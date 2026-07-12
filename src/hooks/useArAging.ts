import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'

// Full-detail A/R aging rows for the Receivables panel. Source: ar_aging
// (MRI "Aged Delinquencies" snapshots, loaded by scripts/load_ar_aging.ps1).
// Only the LATEST snapshot per property is returned.

export interface ArCategory {
  code: string
  desc: string
  total: number
}

export interface ArAgingRow {
  id: string
  propertyId: string
  propertyName: string
  asOf: string
  tenantName: string
  tenantId: string | null
  mriLeaseId: string | null
  suite: string | null
  status: string | null
  total: number
  current: number
  b30: number
  b60: number
  b90: number
  b120: number
  pastDue: number
  lastPaymentDate: string | null
  lastPaymentAmount: number | null
  categories: ArCategory[]
}

// Invoice-level lines behind one ar_aging tenant row (lazy — fetched on expand).
export interface ArDetailLine {
  id: string
  invoiceDate: string | null
  category: string | null
  categoryDesc: string | null
  source: string | null
  amount: number
  bucket: 'current' | 'b30' | 'b60' | 'b90' | 'b120'
}

export function useArDetail(arAgingId: string | null) {
  return useQuery<ArDetailLine[]>(async () => {
    if (!arAgingId) return []
    const { data, error } = await supabase
      .from('ar_aging_detail')
      .select('id, invoice_date, category, category_desc, source, amount, bucket')
      .eq('ar_aging_id', arAgingId)
      .order('invoice_date', { ascending: true })
      .limit(500)
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(r => ({
      id: r.id,
      invoiceDate: r.invoice_date,
      category: r.category,
      categoryDesc: r.category_desc,
      source: r.source,
      amount: Number(r.amount ?? 0),
      bucket: r.bucket,
    }))
  }, [arAgingId])
}

// Emailable contacts for the A/R follow-up composer, from the tenant_contacts
// directory. Keyed two ways so an aging row can resolve its recipients even
// when it has no tenants-table link: "propertyId|id:tenantId" and
// "propertyId|nm:<normalized tenant name>". Within a tenant, billing contacts
// rank first (then general/corporate/operational), primaries before others.
export interface ArFollowUpContact {
  name: string | null
  email: string
  type: string
}

const CONTACT_TYPE_RANK: Record<string, number> = {
  billing: 0, general: 1, corporate: 2, operational: 3, legal_notice: 4,
}

// Loose name key: lowercase, alphanumerics only — survives punctuation and
// spacing drift between MRI tenant labels and directory names.
export const normalizeTenantName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export function useArContacts(propertyIds: string[]) {
  return useQuery<Record<string, ArFollowUpContact[]>>(async () => {
    if (!propertyIds.length) return {}
    const { data, error } = await supabase
      .from('tenant_contacts')
      .select('property_id, tenant_id, tenant_name, contact_type, contact_name, email, is_primary')
      .in('property_id', propertyIds)
      .not('email', 'is', null)
    if (error) throw new Error(error.message)

    const rows = ((data ?? []) as any[])
      .filter(r => typeof r.email === 'string' && r.email.includes('@'))
      .sort((a, b) =>
        (CONTACT_TYPE_RANK[a.contact_type] ?? 9) - (CONTACT_TYPE_RANK[b.contact_type] ?? 9) ||
        Number(b.is_primary) - Number(a.is_primary))

    const map: Record<string, ArFollowUpContact[]> = {}
    const push = (key: string, c: ArFollowUpContact) => {
      const list = map[key] ?? (map[key] = [])
      if (!list.some(x => x.email.toLowerCase() === c.email.toLowerCase())) list.push(c)
    }
    for (const r of rows) {
      const c: ArFollowUpContact = { name: r.contact_name, email: r.email.trim(), type: r.contact_type }
      if (r.tenant_id) push(`${r.property_id}|id:${r.tenant_id}`, c)
      if (r.tenant_name) push(`${r.property_id}|nm:${normalizeTenantName(r.tenant_name)}`, c)
    }
    return map
  }, [propertyIds.join(',')])
}

// Follow-up log (ar_followups): reminder drafts generated per tenant, newest
// first. Keyed like the contacts map so aging rows resolve with or without an
// MRI lease id: "propertyId|mri:<lease>" and "propertyId|nm:<normalized name>".
export interface ArFollowUp {
  id: string
  method: string
  recipients: string[]
  pastDue: number | null
  createdAt: string
  sentByName: string | null
}

export function useArFollowUps(propertyIds: string[]) {
  return useQuery<Record<string, ArFollowUp[]>>(async () => {
    if (!propertyIds.length) return {}
    const { data, error } = await supabase
      .from('ar_followups')
      .select('id, property_id, mri_lease_id, tenant_name, method, recipients, past_due, created_at, sent_by_name')
      .in('property_id', propertyIds)
      .order('created_at', { ascending: false })
      .limit(1000)
    if (error) throw new Error(error.message)
    const map: Record<string, ArFollowUp[]> = {}
    for (const r of (data ?? []) as any[]) {
      const f: ArFollowUp = {
        id: r.id,
        method: r.method,
        recipients: r.recipients ?? [],
        pastDue: r.past_due != null ? Number(r.past_due) : null,
        createdAt: r.created_at,
        sentByName: r.sent_by_name,
      }
      const keys = [
        r.mri_lease_id ? `${r.property_id}|mri:${r.mri_lease_id}` : null,
        r.tenant_name ? `${r.property_id}|nm:${normalizeTenantName(r.tenant_name)}` : null,
      ].filter(Boolean) as string[]
      for (const k of keys) (map[k] ?? (map[k] = [])).push(f)
    }
    return map
  }, [propertyIds.join(',')])
}

// Durable operational annotations, keyed "propertyId|mriLeaseId".
export function useArNotes(propertyIds: string[]) {
  return useQuery<Record<string, string>>(async () => {
    if (!propertyIds.length) return {}
    const { data, error } = await supabase
      .from('ar_notes')
      .select('property_id, mri_lease_id, note')
      .in('property_id', propertyIds)
    if (error) throw new Error(error.message)
    return Object.fromEntries(((data ?? []) as any[]).map(r => [`${r.property_id}|${r.mri_lease_id}`, r.note]))
  }, [propertyIds.join(',')])
}

export function useArAging(propertyIds: string[], propertyNames: Record<string, string>) {
  return useQuery<ArAgingRow[]>(async () => {
    if (!propertyIds.length) return []

    const { data, error } = await supabase
      .from('ar_aging')
      .select('id, property_id, as_of_date, tenant_label, tenant_id, mri_lease_id, suite, occupant_status, total, bucket_current, bucket_30, bucket_60, bucket_90, bucket_120, last_payment_date, last_payment_amount, categories, tenant:tenants(name)')
      .in('property_id', propertyIds)
      .order('as_of_date', { ascending: false })
      .limit(2000)

    if (error) throw new Error(error.message)

    const rows = (data ?? []) as any[]
    if (!rows.length) return []

    // latest snapshot per property (properties can be exported on different days)
    const latest: Record<string, string> = {}
    for (const r of rows) {
      if (!latest[r.property_id] || r.as_of_date > latest[r.property_id]) latest[r.property_id] = r.as_of_date
    }

    return rows
      .filter(r => r.as_of_date === latest[r.property_id])
      .map(r => {
        const b30 = Number(r.bucket_30 ?? 0), b60 = Number(r.bucket_60 ?? 0)
        const b90 = Number(r.bucket_90 ?? 0), b120 = Number(r.bucket_120 ?? 0)
        const categories: ArCategory[] = Object.entries((r.categories ?? {}) as Record<string, { desc?: string; total?: number }>)
          .map(([code, v]) => ({ code, desc: v?.desc ?? code, total: Number(v?.total ?? 0) }))
          .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
        return {
          id:                r.id,
          propertyId:        r.property_id,
          propertyName:      propertyNames[r.property_id] ?? '—',
          asOf:              r.as_of_date,
          tenantName:        r.tenant?.name ?? r.tenant_label,
          tenantId:          r.tenant_id ?? null,
          mriLeaseId:        r.mri_lease_id,
          suite:             r.suite,
          status:            r.occupant_status,
          total:             Number(r.total ?? 0),
          current:           Number(r.bucket_current ?? 0),
          b30, b60, b90, b120,
          pastDue:           b30 + b60 + b90 + b120,
          lastPaymentDate:   r.last_payment_date,
          lastPaymentAmount: r.last_payment_amount != null ? Number(r.last_payment_amount) : null,
          categories,
        }
      })
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}
