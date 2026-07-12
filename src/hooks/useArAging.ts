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
      .select('id, property_id, as_of_date, tenant_label, mri_lease_id, suite, occupant_status, total, bucket_current, bucket_30, bucket_60, bucket_90, bucket_120, last_payment_date, last_payment_amount, categories, tenant:tenants(name)')
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
