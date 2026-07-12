import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'

// Vendor service contracts (service_agreements, migration 20240037) abstracted
// from the corpus by scripts/extract_service_agreements.ps1. One row per source
// document; the /services panel groups rows by vendor + category and treats the
// latest agreement in each group as current.

export type Lifecycle = 'expired' | 'expiring' | 'active' | 'evergreen' | 'terminated' | 'superseded' | 'unknown'

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
  docId: string | null
  docTitle: string | null
  filePath: string | null
}

export const EXPIRING_WINDOW_DAYS = 90

/** Where an agreement sits in its life today (manual status wins over dates). */
export function lifecycleOf(a: ServiceAgreement, todayIso: string, horizonIso: string): Lifecycle {
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
      .select('id, property_id, vendor, service_category, description, agreement_date, start_date, end_date, term_summary, auto_renews, cancel_notice_days, annual_value, pricing_summary, status, notes, document_id, file_path, documents(title, file_path)')
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
      docId:            r.document_id,
      docTitle:         r.documents?.title ?? null,
      filePath:         r.file_path ?? r.documents?.file_path ?? null,
    }))
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}
