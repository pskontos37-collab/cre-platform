import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'

// Certificate of Insurance tracker (coi_certificates, migration 20240082).
// One row per insured party (tenant / vendor / TI contractor) per property.
// v1 data is seeded from the Ebix "MJ Wilkow Report" export (scripts/load_ebix.ps1)
// so status + deficiencies are populated but per-coverage limits/dates arrive
// later from the ACORD PDFs via the coi-extract pipeline.

export type PartyType = 'tenant' | 'vendor' | 'contractor'
export type CoiStatus = 'compliant' | 'deficient' | 'expiring' | 'expired' | 'missing' | 'pending'

export interface CoiDeficiency { label: string; code?: string; detail?: string }

export interface CoiCertificate {
  id: string
  propertyId: string
  partyType: PartyType
  partyName: string
  tenantId: string | null
  ebixVendorNum: string | null
  insuredName: string | null
  insuredAddress: string | null
  insuredContact: string | null
  insuredEmail: string | null
  insuredPhone: string | null
  producerName: string | null
  producerEmail: string | null
  producerPhone: string | null
  effectiveDate: string | null
  expirationDate: string | null
  amBestRating: string | null
  status: CoiStatus
  deficiencies: CoiDeficiency[]
  source: 'ai_extraction' | 'email_inbound' | 'ebix_import' | 'manual'
  notes: string | null
  updatedAt: string
}

export const STATUS_META: Record<CoiStatus, { label: string; color: string }> = {
  missing:   { label: 'Missing',   color: 'var(--red)' },
  expired:   { label: 'Expired',   color: 'var(--red)' },
  deficient: { label: 'Deficient', color: 'var(--amber)' },
  expiring:  { label: 'Expiring',  color: 'var(--amber)' },
  compliant: { label: 'Compliant', color: 'var(--green)' },
  pending:   { label: 'Pending',   color: 'var(--text-muted)' },
}

export const PARTY_META: Record<PartyType, { label: string; icon: string }> = {
  tenant:     { label: 'Tenant',     icon: '🏬' },
  vendor:     { label: 'Vendor',     icon: '🔧' },
  contractor: { label: 'Contractor', icon: '🏗' },
}

const SELECT =
  'id, property_id, party_type, party_name, tenant_id, ebix_vendor_num, insured_name, ' +
  'insured_address, insured_contact, insured_email, insured_phone, producer_name, ' +
  'producer_email, producer_phone, effective_date, expiration_date, am_best_rating, ' +
  'status, deficiencies, source, notes, updated_at'

function mapRow(r: any): CoiCertificate {
  return {
    id:             r.id,
    propertyId:     r.property_id,
    partyType:      r.party_type,
    partyName:      r.party_name,
    tenantId:       r.tenant_id,
    ebixVendorNum:  r.ebix_vendor_num,
    insuredName:    r.insured_name,
    insuredAddress: r.insured_address,
    insuredContact: r.insured_contact,
    insuredEmail:   r.insured_email,
    insuredPhone:   r.insured_phone,
    producerName:   r.producer_name,
    producerEmail:  r.producer_email,
    producerPhone:  r.producer_phone,
    effectiveDate:  r.effective_date,
    expirationDate: r.expiration_date,
    amBestRating:   r.am_best_rating,
    status:         r.status,
    deficiencies:   Array.isArray(r.deficiencies) ? r.deficiencies : [],
    source:         r.source,
    notes:          r.notes,
    updatedAt:      r.updated_at,
  }
}

export function useCoiCertificates(propertyIds: string[]) {
  return useQuery<CoiCertificate[]>(async () => {
    if (!propertyIds.length) return []
    const { data, error } = await supabase
      .from('coi_certificates')
      .select(SELECT)
      .in('property_id', propertyIds)
      .order('party_name', { ascending: true })
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(mapRow)
  }, [propertyIds.join(',')])
}
