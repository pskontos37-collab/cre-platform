// Tracking for service agreements produced by the /services/new generator.
//
// Stores METADATA ONLY (the form inputs + status) — the .docx/PDF are fully
// reproducible from these fields on demand, so we don't persist blobs. All
// writes are best-effort: if the table hasn't been migrated yet, generation /
// download / email still work and logging simply no-ops.

import { supabase } from '../lib/supabase'
import { useQuery } from './useQuery'
import type { AgreementInput } from '../reports/serviceAgreement/config'
import { PROPERTY_CONFIGS } from '../reports/serviceAgreement/config'

export interface GeneratedAgreement {
  id: string
  property_id: string | null
  property_key: string
  vendor_name: string
  vendor_business: string | null
  vendor_email: string | null
  agreement_date: string | null
  term_type: string | null
  start_date: string | null
  end_date: string | null
  status: 'generated' | 'sent'
  sent_to: string | null
  sent_at: string | null
  created_by: string | null
  created_at: string
}

export function useGeneratedAgreements(propertyKey?: string) {
  return useQuery<GeneratedAgreement[]>(async () => {
    let q = supabase
      .from('generated_service_agreements')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
    if (propertyKey) q = q.eq('property_key', propertyKey)
    const { data, error } = await q
    if (error) {
      // Table not migrated yet, or RLS — degrade quietly to an empty list.
      console.warn('[generated-agreements] list unavailable:', error.message)
      return []
    }
    return (data ?? []) as GeneratedAgreement[]
  }, [propertyKey])
}

const agreementDate = (i: AgreementInput) =>
  [i.day, i.month, i.year].map(s => s.trim()).filter(Boolean).join(' ') || null

/** Best-effort log; returns the new id or null. Never throws. */
export async function logGeneratedAgreement(
  input: AgreementInput,
  opts: { propertyId: string | null; status: 'generated' | 'sent'; sentTo?: string | null },
): Promise<string | null> {
  try {
    const cfg = PROPERTY_CONFIGS[input.property]
    const { data: auth } = await supabase.auth.getUser()
    const row = {
      property_id: opts.propertyId,
      property_key: cfg.key,
      vendor_name: input.vendorName.trim(),
      vendor_business: input.vendorBusiness.trim() || null,
      vendor_email: input.vendorEmail.trim() || null,
      agreement_date: agreementDate(input),
      term_type: input.termType,
      start_date: input.startDate.trim() || null,
      end_date: input.endDate.trim() || null,
      status: opts.status,
      sent_to: opts.sentTo ?? null,
      sent_at: opts.status === 'sent' ? new Date().toISOString() : null,
      created_by: auth?.user?.id ?? null,
    }
    const { data, error } = await supabase
      .from('generated_service_agreements')
      .insert(row)
      .select('id')
      .single()
    if (error) { console.warn('[generated-agreements] log skipped:', error.message); return null }
    return (data as { id: string }).id
  } catch (e) {
    console.warn('[generated-agreements] log error:', e instanceof Error ? e.message : String(e))
    return null
  }
}
