import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'

// Vendor service contracts (service_agreements, migration 20240037) abstracted
// from the corpus by scripts/extract_service_agreements.ps1. One row per source
// document; the /services panel groups rows by vendor + category and treats the
// latest agreement in each group as current.

export type Lifecycle =
  | 'expired' | 'expiring' | 'active' | 'evergreen'
  | 'terminated' | 'superseded'
  | 'completed' | 'cancelled' | 'ignored'
  | 'unknown'

/** Manual user dismissals (migration 20240078). All three drop the relationship
 *  from the default list, the renewals widget and the email digest. Completed =
 *  one-time job finished (self-explanatory, no note); cancelled and ignored
 *  REQUIRE an audit note. Distinct from `status` ('terminated'/'superseded'),
 *  which belongs to the extraction pipeline. */
export type Resolution = 'completed' | 'cancelled' | 'ignored'

export const RESOLVED_LIFECYCLES: ReadonlySet<Lifecycle> = new Set(['completed', 'cancelled', 'ignored'])

export interface ServiceAgreement {
  id: string
  propertyId: string
  propertyName: string
  vendor: string
  category: string
  description: string | null
  agreementDate: string | null
  startDate: string | null
  endDate: string | null
  termSummary: string | null
  autoRenews: boolean | null
  cancelNoticeDays: number | null
  annualValue: number | null
  pricingSummary: string | null
  status: string
  notes: string | null
  resolution: Resolution | null
  resolvedAt: string | null
  resolvedByName: string | null
  resolutionReason: string | null
  docId: string | null
  docTitle: string | null
  filePath: string | null
  qa: any | null
  qaStatus: string | null
  qaAt: string | null
}

export const EXPIRING_WINDOW_DAYS = 90

/** Where an agreement sits in its life today (manual resolution wins over
 *  pipeline status, which wins over dates). */
export function lifecycleOf(a: ServiceAgreement, todayIso: string, horizonIso: string): Lifecycle {
  if (a.resolution) return a.resolution
  if (a.status === 'terminated') return 'terminated'
  if (a.status === 'superseded') return 'superseded'
  if (a.endDate) {
    if (a.endDate < todayIso) return 'expired'
    if (a.endDate <= horizonIso) return 'expiring'
    return 'active'
  }
  if (a.autoRenews) return 'evergreen'
  return 'unknown'
}

export function useServiceAgreements(propertyIds: string[], propertyNames: Record<string, string>) {
  return useQuery<ServiceAgreement[]>(async () => {
    if (!propertyIds.length) return []

    const { data, error } = await supabase
      .from('service_agreements')
      .select('id, property_id, vendor, service_category, description, agreement_date, start_date, end_date, term_summary, auto_renews, cancel_notice_days, annual_value, pricing_summary, status, notes, resolution, resolved_at, resolved_by_name, resolution_reason, document_id, file_path, qa, qa_status, qa_at, documents(title, file_path)')
      .in('property_id', propertyIds)
      .order('vendor', { ascending: true })
    if (error) throw new Error(error.message)

    return ((data ?? []) as any[]).map(r => ({
      id:               r.id,
      propertyId:       r.property_id,
      propertyName:     propertyNames[r.property_id] ?? '—',
      vendor:           r.vendor,
      category:         r.service_category,
      description:      r.description,
      agreementDate:    r.agreement_date,
      startDate:        r.start_date,
      endDate:          r.end_date,
      termSummary:      r.term_summary,
      autoRenews:       r.auto_renews,
      cancelNoticeDays: r.cancel_notice_days,
      annualValue:      r.annual_value != null ? Number(r.annual_value) : null,
      pricingSummary:   r.pricing_summary,
      status:           r.status,
      notes:            r.notes,
      resolution:       r.resolution,
      resolvedAt:       r.resolved_at,
      resolvedByName:   r.resolved_by_name,
      resolutionReason: r.resolution_reason,
      docId:            r.document_id,
      docTitle:         r.documents?.title ?? null,
      filePath:         r.file_path ?? r.documents?.file_path ?? null,
      qa:               r.qa ?? null,
      qaStatus:         r.qa_status ?? null,
      qaAt:             r.qa_at ?? null,
    }))
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}

/** Mark an agreement completed / cancelled / ignored — drops it from the
 *  /services default view, the renewals widget and the email digest. Cancelled
 *  and ignored require a reason note (also DB-enforced); who/when is recorded
 *  for all three, and every resolve/restore transition lands in audit_log via
 *  the audit_service_agreement_resolution trigger (migration 20240078).
 *  Goes through the resolve_service_agreement RPC (migration 20240079) so
 *  property managers can act on their entitled properties too — the table's
 *  write RLS stays admin/AM-only, the RPC touches only the resolution fields. */
export async function resolveServiceAgreement(id: string, resolution: Resolution, reason?: string): Promise<void> {
  const trimmed = (reason ?? '').trim()
  if (resolution !== 'completed' && !trimmed) {
    throw new Error(`An audit note is required to mark an agreement ${resolution}`)
  }
  const { data, error } = await supabase.rpc('resolve_service_agreement', {
    p_id: id,
    p_resolution: resolution,
    p_reason: trimmed || null,
  })
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Not permitted — admins, asset managers, or property managers assigned to this property only')
}

/** Bring a resolved agreement back into tracking. The original note stays in
 *  audit_log (the trigger records old + new on this transition too). */
export async function restoreServiceAgreement(id: string): Promise<void> {
  const { data, error } = await supabase.rpc('resolve_service_agreement', {
    p_id: id,
    p_resolution: null,
    p_reason: null,
  })
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Not permitted — admins, asset managers, or property managers assigned to this property only')
}
