import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'

// Reciprocal Easement / Operation & Easement agreements (rea_agreements,
// migration 20240034) with live A/R balances joined for members that carry
// an MRI lease id in the aging snapshots.

export interface ReaMember {
  name: string
  role?: string
  tract?: string
  mri?: string
  note?: string
  arTotal?: number | null
  arAsOf?: string | null
}

export interface ReaSourceDoc {
  id: string
  title: string
}

export interface ReaAgreement {
  id: string
  propertyId: string
  propertyName: string
  name: string
  agreementDate: string | null
  termSummary: string | null
  operator: string | null
  members: ReaMember[]
  costSharing: string | null
  keyProvisions: string | null
  amendments: string | null
  openItems: string | null
  sourceDocs: ReaSourceDoc[]
  // abstractor-v2 REA phase (migration 20240104): verified abstract + QA verdict
  abstract: any | null
  qa: any | null
  qaStatus: string | null
  qaAt: string | null
}

export function useReaAgreements(propertyIds: string[], propertyNames: Record<string, string>) {
  return useQuery<ReaAgreement[]>(async () => {
    if (!propertyIds.length) return []

    const [reaRes, arRes] = await Promise.all([
      supabase
        .from('rea_agreements')
        .select('id, property_id, name, agreement_date, term_summary, operator, members, cost_sharing, key_provisions, amendments, open_items, source_docs, abstract, qa, qa_status, qa_at')
        .in('property_id', propertyIds)
        .order('agreement_date', { ascending: true }),
      supabase
        .from('ar_aging')
        .select('property_id, mri_lease_id, as_of_date, total')
        .in('property_id', propertyIds)
        .order('as_of_date', { ascending: false })
        .limit(500),
    ])
    if (reaRes.error) throw new Error(reaRes.error.message)
    if (arRes.error) throw new Error(arRes.error.message)

    // latest A/R balance per MRI lease id
    const arByMri: Record<string, { total: number; asOf: string }> = {}
    for (const r of (arRes.data ?? []) as any[]) {
      if (r.mri_lease_id && !arByMri[r.mri_lease_id]) {
        arByMri[r.mri_lease_id] = { total: Number(r.total ?? 0), asOf: r.as_of_date }
      }
    }

    return ((reaRes.data ?? []) as any[]).map(r => ({
      id:            r.id,
      propertyId:    r.property_id,
      propertyName:  propertyNames[r.property_id] ?? '—',
      name:          r.name,
      agreementDate: r.agreement_date,
      termSummary:   r.term_summary,
      operator:      r.operator,
      members:       ((r.members ?? []) as any[]).map(m => ({
        ...m,
        arTotal: m.mri && arByMri[m.mri] ? arByMri[m.mri].total : null,
        arAsOf:  m.mri && arByMri[m.mri] ? arByMri[m.mri].asOf : null,
      })),
      costSharing:   r.cost_sharing,
      keyProvisions: r.key_provisions,
      amendments:    r.amendments,
      openItems:     r.open_items,
      sourceDocs:    (r.source_docs ?? []) as ReaSourceDoc[],
      abstract:      r.abstract ?? null,
      qa:            r.qa ?? null,
      qaStatus:      r.qa_status ?? null,
      qaAt:          r.qa_at ?? null,
    }))
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}
