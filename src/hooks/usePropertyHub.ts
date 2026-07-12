import { supabase } from '../lib/supabase'
import { useQuery } from './useQuery'
import { num } from './useFinancials'
import { fetchAllRows } from '../lib/fetchAll'
import type { Loan } from '../types/database'

// ── List page: per-property KPI strip ────────────────────────────────────────
// One bulk query per source (not per property) so the list stays fast.

export interface PropertyListKpis {
  t12Noi: number | null                       // GL-derived, null when no GL loaded
  occupiedSf: number | null                   // latest rent-roll snapshot
  annualRent: number | null
  occupancyPct: number | null                 // occupied SF / property total SF
  rentRollAsOf: { year: number; month: number } | null
}

export function usePropertyListKpis(propertyIds: string[], totalSfById: Record<string, number | null>) {
  return useQuery<Record<string, PropertyListKpis>>(async () => {
    const out: Record<string, PropertyListKpis> = {}
    if (!propertyIds.length) return out
    for (const id of propertyIds) {
      out[id] = { t12Noi: null, occupiedSf: null, annualRent: null, occupancyPct: null, rentRollAsOf: null }
    }

    // GL: trailing-12 NOI per property (sum of the last 12 months present per property)
    const { data: monthly, error: mErr } = await supabase
      .from('v_gl_pnl_monthly')
      .select('property_id, period_year, period_month, noi')
      .in('property_id', propertyIds)
    if (mErr) throw new Error(mErr.message)
    const byProp = new Map<string, Array<{ key: number; noi: number }>>()
    for (const r of (monthly ?? []) as any[]) {
      const arr = byProp.get(r.property_id) ?? []
      arr.push({ key: Number(r.period_year) * 12 + Number(r.period_month), noi: num(r.noi) })
      byProp.set(r.property_id, arr)
    }
    for (const [pid, arr] of byProp) {
      arr.sort((a, b) => a.key - b.key)
      out[pid].t12Noi = arr.slice(-12).reduce((s, r) => s + r.noi, 0)
    }

    // Rent roll: latest snapshot per property → occupied SF + annual rent
    const { data: snaps, error: sErr } = await supabase
      .from('rent_roll_snapshots')
      .select('id, property_id, period_year, period_month')
      .in('property_id', propertyIds)
      .order('period_year', { ascending: false })
      .order('period_month', { ascending: false })
    if (sErr) throw new Error(sErr.message)
    const latestSnap = new Map<string, { id: string; year: number; month: number }>()
    for (const s of (snaps ?? []) as any[]) {
      if (!latestSnap.has(s.property_id)) {
        latestSnap.set(s.property_id, { id: s.id, year: Number(s.period_year), month: Number(s.period_month) })
      }
    }
    if (latestSnap.size) {
      const { data: rows, error: rErr } = await supabase
        .from('rent_roll_rows')
        .select('property_id, snapshot_id, sqft, annual_base_rent, is_occupied')
        .in('snapshot_id', [...latestSnap.values()].map(s => s.id))
      if (rErr) throw new Error(rErr.message)
      const agg = new Map<string, { sf: number; rent: number }>()
      for (const r of (rows ?? []) as any[]) {
        if (!r.is_occupied) continue
        const prev = agg.get(r.property_id) ?? { sf: 0, rent: 0 }
        agg.set(r.property_id, { sf: prev.sf + num(r.sqft), rent: prev.rent + num(r.annual_base_rent) })
      }
      for (const [pid, v] of agg) {
        const snap = latestSnap.get(pid)
        out[pid].occupiedSf = v.sf
        out[pid].annualRent = v.rent
        out[pid].rentRollAsOf = snap ? { year: snap.year, month: snap.month } : null
        const total = totalSfById[pid]
        out[pid].occupancyPct = total && total > 0 ? v.sf / total : null
      }
    }

    return out
  }, [propertyIds.join(',')])
}

// ── Detail page: loans secured by this property ──────────────────────────────
// Includes cross-collateralized loans that sit on another entity (e.g. the KM
// MetLife loan on the Consolidated record) but name this property as collateral.

export interface PropertyLoanRow {
  loan: Loan
  t12Noi: number | null      // NOI of the loan's collateral set
  dscr: number | null
  debtYield: number | null
  covenantType: 'debt_yield' | 'dscr' | null
  headroom: number | null
  isNear: boolean
  isBreach: boolean
}

export function useLoansForProperty(propertyId: string | null) {
  return useQuery<PropertyLoanRow[]>(async () => {
    if (!propertyId) return []

    const { data: loans, error } = await supabase
      .from('loans')
      .select('*')
      .or(`property_id.eq.${propertyId},collateral_property_ids.cs.{${propertyId}}`)
    if (error) throw new Error(error.message)
    const loansArr = (loans ?? []) as Loan[]
    if (!loansArr.length) return []

    const collateralOf = (l: Loan): string[] =>
      l.collateral_property_ids && l.collateral_property_ids.length ? l.collateral_property_ids : [l.property_id]
    const allCollateral = [...new Set(loansArr.flatMap(collateralOf))]

    const { data: monthly, error: mErr } = await supabase
      .from('v_gl_pnl_monthly')
      .select('property_id, period_year, period_month, noi')
      .in('property_id', allCollateral)
    if (mErr) throw new Error(mErr.message)
    const monthlyArr = (monthly ?? []) as Array<{ property_id: string; period_year: number; period_month: number; noi: number | null }>

    const t12For = (ids: string[]): number | null => {
      const set = new Set(ids)
      const byKey = new Map<number, number>()
      for (const r of monthlyArr) {
        if (!set.has(r.property_id)) continue
        const key = Number(r.period_year) * 12 + Number(r.period_month)
        byKey.set(key, (byKey.get(key) ?? 0) + num(r.noi))
      }
      if (!byKey.size) return null
      return [...byKey.keys()].sort((a, b) => a - b).slice(-12).reduce((s, k) => s + (byKey.get(k) ?? 0), 0)
    }

    return loansArr.map(loan => {
      const t12Noi = t12For(collateralOf(loan))
      const ads = loan.annual_debt_service
      const bal = loan.outstanding_balance
      const dscr = ads && ads > 0 && t12Noi !== null ? t12Noi / ads : null
      const debtYield = bal && bal > 0 && t12Noi !== null ? t12Noi / bal : null

      let covenantType: 'debt_yield' | 'dscr' | null = null
      let headroom: number | null = null
      let isBreach = false
      let isNear = false
      if (loan.debt_yield_covenant != null && debtYield != null) {
        covenantType = 'debt_yield'
        headroom = debtYield - loan.debt_yield_covenant
        isBreach = headroom < 0
        isNear = !isBreach && headroom < 0.01
      } else if (loan.dscr_covenant != null && dscr != null) {
        covenantType = 'dscr'
        headroom = dscr - loan.dscr_covenant
        isBreach = headroom < 0
        isNear = !isBreach && headroom < 0.10
      }

      return { loan, t12Noi, dscr, debtYield, covenantType, headroom, isNear, isBreach }
    })
  }, [propertyId])
}

// ── Detail page: documents ────────────────────────────────────────────────────

export interface RecentDoc {
  id: string
  title: string | null
  doc_type: string
  file_name: string | null
  created_at: string
}

export interface PropertyDocs {
  total: number
  byType: Array<{ doc_type: string; count: number }>
  recent: RecentDoc[]
}

export function usePropertyDocs(propertyId: string | null) {
  return useQuery<PropertyDocs>(async () => {
    if (!propertyId) return { total: 0, byType: [], recent: [] }

    const { count, error: cErr } = await supabase
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', propertyId)
    if (cErr) throw new Error(cErr.message)

    const { data: recent, error: rErr } = await supabase
      .from('documents')
      .select('id, title, doc_type, file_name, created_at')
      .eq('property_id', propertyId)
      .order('created_at', { ascending: false })
      .limit(8)
    if (rErr) throw new Error(rErr.message)

    // Type distribution — fetch doc_type only; PostgREST has no group-by, so we
    // aggregate client-side. Paged: responses cap at 1,000 rows and the big
    // corpora (Magnolia ~3.1k docs) would otherwise silently truncate.
    const types = await fetchAllRows<any>((from, to) => supabase
      .from('documents')
      .select('id, doc_type')
      .eq('property_id', propertyId)
      .order('id')
      .range(from, to))
    const typeMap = new Map<string, number>()
    for (const r of types) typeMap.set(r.doc_type, (typeMap.get(r.doc_type) ?? 0) + 1)

    return {
      total: count ?? 0,
      byType: [...typeMap.entries()].map(([doc_type, count]) => ({ doc_type, count })).sort((a, b) => b.count - a.count),
      recent: (recent ?? []) as RecentDoc[],
    }
  }, [propertyId])
}
