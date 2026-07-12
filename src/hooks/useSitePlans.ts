import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'

// ── Site plans ────────────────────────────────────────────────────────────────
// The centre-wide tenant-directory site plans (doc_type='site_plan', classified
// in migration 20240051) for a property, with a fresh signed URL for each so the
// pdf.js viewer / canvas renderer can open them. The "primary" plan is the
// authoritative current map (the one filed under RETAIL\PROPERTY INFORMATION\…\
// Site Plan\); absent that, the newest by file mtime.

export interface SitePlanDoc {
  id: string
  title: string | null
  fileName: string | null
  storagePath: string | null
  signedUrl: string | null
  isPrimary: boolean
  when: string | null            // file mtime (falls back to created_at)
}

export interface SitePlanProperty { id: string; name: string; count: number }

// Properties that actually have a classified site plan — drives the map's
// picker. Not driven by useProperties() because that filters to owned assets
// and a reporting rollup (the Knightdale Consolidated record) also carries a
// combined site map worth viewing.
export function useSitePlanProperties() {
  return useQuery<SitePlanProperty[]>(async () => {
    const { data, error } = await supabase
      .from('documents')
      .select('property_id')
      .eq('doc_type', 'site_plan')
      .not('property_id', 'is', null)
    if (error) throw new Error(error.message)
    const counts = new Map<string, number>()
    for (const r of (data ?? []) as any[]) counts.set(r.property_id, (counts.get(r.property_id) ?? 0) + 1)
    const ids = [...counts.keys()]
    if (!ids.length) return []
    const { data: props, error: pErr } = await supabase
      .from('properties').select('id, name').in('id', ids)
    if (pErr) throw new Error(pErr.message)
    const nameById = new Map<string, string>(((props ?? []) as any[]).map(p => [p.id, p.name]))
    return ids
      .map(id => ({ id, name: nameById.get(id) ?? '—', count: counts.get(id) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [])
}

export function useSitePlans(propertyId: string | null) {
  return useQuery<SitePlanDoc[]>(async () => {
    if (!propertyId) return []
    const { data, error } = await supabase
      .from('documents')
      .select('id, title, file_name, file_path, storage_path, file_mtime, created_at')
      .eq('property_id', propertyId)
      .eq('doc_type', 'site_plan')
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as any[]

    const paths = rows.map(r => r.storage_path).filter((p): p is string => typeof p === 'string' && p.startsWith('p/'))
    const signed = new Map<string, string>()
    if (paths.length) {
      const { data: s } = await supabase.storage.from('documents').createSignedUrls(paths, 3600)
      for (const it of s ?? []) if (it.path && it.signedUrl) signed.set(it.path, it.signedUrl)
    }

    const isAuthoritative = (fp: string) => /property information/i.test(fp) && /\\site plan\\/i.test(fp)
    const plans: SitePlanDoc[] = rows.map(r => ({
      id:          r.id,
      title:       r.title ?? null,
      fileName:    r.file_name ?? null,
      storagePath: r.storage_path ?? null,
      signedUrl:   r.storage_path ? (signed.get(r.storage_path) ?? null) : null,
      isPrimary:   isAuthoritative(String(r.file_path ?? '')),
      when:        r.file_mtime ?? r.created_at ?? null,
    }))
    // Primary first, then newest.
    plans.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
      return (b.when ?? '').localeCompare(a.when ?? '')
    })
    return plans
  }, [propertyId])
}

// ── Interactive map regions ───────────────────────────────────────────────────
// Vision-extracted suite hotspots for ONE plan document, reconciled against the
// live data the way asset managers read a site plan: who's in each suite, are
// they current, expiring, or delinquent, and is the suite an REA member or under
// an exclusive. Everything joins on the suite key (rent roll, A/R, and — via a
// member's MRI id → A/R suite — the REA members).

export type SuiteStatus = 'occupied' | 'expiring' | 'delinquent' | 'vacant' | 'unknown'

export interface SuiteRegion {
  id: string
  page: number
  x: number; y: number; w: number; h: number   // normalised [0,1], origin top-left
  suiteLabel: string | null
  status: SuiteStatus
  matched: boolean               // reconciled to THIS property's rent roll
  tenant: string | null
  sqft: number | null
  annualRent: number | null
  leaseEnd: string | null
  arTotal: number | null
  hasExclusive: boolean
  hasCoTenancy: boolean
  rea: { name: string; tract: string | null; role: string | null } | null
  source: string
}

export interface SitePlanMapData {
  regions: SuiteRegion[]
  pages: number[]                // distinct page numbers that carry regions
  matched: number                // regions tied to a rent-roll suite
}

const DAY = 86_400_000

function normSuite(s?: string | null): string {
  const raw = (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const m = raw.match(/^([A-Z]*)0*(\d+)$/)
  return m ? m[1] + m[2] : raw         // strip leading zeros of the numeric tail: A01 → A1
}

export function useSitePlanMap(propertyId: string | null, documentId: string | null) {
  return useQuery<SitePlanMapData>(async () => {
    const empty: SitePlanMapData = { regions: [], pages: [], matched: 0 }
    if (!propertyId || !documentId) return empty

    // Regions for this plan
    const { data: regRows, error: regErr } = await supabase
      .from('site_plan_regions')
      .select('id, page, x, y, w, h, suite_label, tenant_label, rr_suite, unit_id, confidence, source')
      .eq('document_id', documentId)
    if (regErr) throw new Error(regErr.message)
    const regions = (regRows ?? []) as any[]
    if (!regions.length) return empty

    // Latest rent-roll snapshot rows for the property → per-suite occupancy
    const { data: snaps } = await supabase
      .from('rent_roll_snapshots')
      .select('id, period_year, period_month')
      .eq('property_id', propertyId)
      .order('period_year', { ascending: false })
      .order('period_month', { ascending: false })
      .limit(1)
    const snapId = (snaps ?? [])[0]?.id ?? null
    const rrBySuite = new Map<string, any>()
    if (snapId) {
      const { data: rr } = await supabase
        .from('rent_roll_rows')
        .select('suite, tenant_name, sqft, annual_base_rent, lease_end, is_occupied, unit_id')
        .eq('snapshot_id', snapId)
      for (const r of (rr ?? []) as any[]) rrBySuite.set(normSuite(r.suite), r)
    }

    // Latest A/R per suite + an MRI-id → suite index (for REA member mapping)
    const { data: ar } = await supabase
      .from('ar_aging')
      .select('suite, tenant_label, total, mri_lease_id, as_of_date')
      .eq('property_id', propertyId)
      .order('as_of_date', { ascending: false })
      .limit(1000)
    const arBySuite = new Map<string, number>()
    const suiteByMri = new Map<string, string>()   // mri → normalised suite
    for (const r of (ar ?? []) as any[]) {
      const ns = normSuite(r.suite)
      if (ns && !arBySuite.has(ns)) arBySuite.set(ns, Number(r.total ?? 0))
      if (r.mri_lease_id && r.suite && !suiteByMri.has(r.mri_lease_id)) suiteByMri.set(r.mri_lease_id, ns)
    }

    // Lease flags (exclusives / co-tenancy) by unit_id — Tier 3 overlay
    const { data: leases } = await supabase
      .from('leases')
      .select('unit_id, has_exclusives, has_co_tenancy_clause')
      .eq('property_id', propertyId)
    const flagsByUnit = new Map<string, { excl: boolean; coten: boolean }>()
    for (const l of (leases ?? []) as any[]) {
      if (l.unit_id) flagsByUnit.set(l.unit_id, { excl: !!l.has_exclusives, coten: !!l.has_co_tenancy_clause })
    }

    // REA members mapped to a suite via their MRI id — Tier 3 overlay
    const { data: reas } = await supabase
      .from('rea_agreements')
      .select('name, members')
      .eq('property_id', propertyId)
    const reaBySuite = new Map<string, { name: string; tract: string | null; role: string | null }>()
    for (const rea of (reas ?? []) as any[]) {
      for (const m of ((rea.members ?? []) as any[])) {
        if (!m.mri) continue
        const ns = suiteByMri.get(m.mri)
        if (ns && !reaBySuite.has(ns)) reaBySuite.set(ns, { name: rea.name, tract: m.tract ?? null, role: m.role ?? null })
      }
    }

    const now = Date.now()
    let matched = 0
    const out: SuiteRegion[] = regions.map(r => {
      const key = normSuite(r.rr_suite ?? r.suite_label)
      const rr = key ? rrBySuite.get(key) : undefined
      const arTotal = key && arBySuite.has(key) ? arBySuite.get(key)! : null
      const flags = rr?.unit_id ? flagsByUnit.get(rr.unit_id) : undefined
      const rea = key ? (reaBySuite.get(key) ?? null) : null
      if (rr) matched++

      const leaseEnd: string | null = rr?.lease_end ?? null
      const expiring = leaseEnd ? (new Date(leaseEnd).getTime() - now) <= 365 * DAY && new Date(leaseEnd).getTime() >= now : false

      let status: SuiteStatus
      if (rr) {
        if (!rr.is_occupied) status = 'vacant'
        else if (arTotal != null && arTotal > 0) status = 'delinquent'
        else if (expiring) status = 'expiring'
        else status = 'occupied'
      } else {
        const label = (r.tenant_label ?? '').trim()
        status = label && !/vacant|available|avail\b/i.test(label) ? 'unknown' : 'vacant'
      }

      return {
        id: r.id,
        page: Number(r.page ?? 1),
        x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h),
        suiteLabel: r.suite_label ?? null,
        status,
        matched: !!rr,
        tenant: (rr?.tenant_name ?? r.tenant_label ?? null) || null,
        sqft: rr?.sqft != null ? Number(rr.sqft) : null,
        annualRent: rr?.annual_base_rent != null ? Number(rr.annual_base_rent) : null,
        leaseEnd,
        arTotal,
        hasExclusive: !!flags?.excl,
        hasCoTenancy: !!flags?.coten,
        rea,
        source: r.source ?? 'vision',
      }
    })

    const pages = [...new Set(out.map(r => r.page))].sort((a, b) => a - b)
    return { regions: out, pages, matched }
  }, [propertyId, documentId])
}
