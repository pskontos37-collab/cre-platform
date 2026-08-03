import { supabase } from '../lib/supabase'
import { useQuery } from './useQuery'

export interface DataQualityFinding {
  property_id: string
  property_name: string | null
  scope: 'abstract' | 'property'
  abstract_id: string | null
  tenant_name: string | null
  check_code: string
  severity: 'discrepancy' | 'confirm' | 'info'
  item_key: string
  detail: string
  resolved: boolean
  resolution_status: string | null
}

// Human labels + why-it-matters for each standing check. Kept here (not in SQL)
// so wording can change without a migration.
export const CHECK_LABEL: Record<string, { title: string; why: string }> = {
  mri_flag_only_right: {
    title: 'Right asserted from an MRI flag alone',
    why: 'The leases.has_* columns are NOT NULL with a false default, so "false" means "never populated" and cannot establish that a right is absent. Krispy Kreme reported no radius clause on that basis while its lease carries a 3-mile radius.',
  },
  citation_not_confirmed: {
    title: 'Verifier quote not found in the sources',
    why: 'The verifier marked a field "confirmed" and supplied a verbatim quote that cannot be located in the source documents. It reads as sourced and is not.',
  },
  schedule_vs_term: {
    title: 'Rent schedule disagrees with its own term',
    why: 'An OCR rent table prints option tiers in the same grid as initial-term tiers, so they get absorbed into the base schedule. Burlington covered 240 months against a ~124-month term.',
  },
  allowance_missed: {
    title: 'Allowance in a brief, absent from the abstract',
    why: 'A source brief records a landlord-to-tenant allowance carrying an actual figure while the abstract reports none. This is how the Little Caesars $24,000 TI allowance was found.',
  },
  exclusive_not_landlord_restricting: {
    title: 'Exclusive without a landlord-restricting covenant',
    why: 'exclusives.exists=true requires quoted language by which the LANDLORD restricts other occupants. A paraphrase, or an exhibit schedule listing OTHER tenants protections, belongs in use restrictions - mixing them poisons leasing decisions.',
  },
  mgmt_fee_implausible: {
    title: 'Impossible management fee',
    why: 'mgmt_fee_pct already stores a percent (Gateway 1.75, KM 3.1, Magnolia 2.75). A fee at or above 20% means a x100 was applied somewhere.',
  },
  override_no_op: {
    title: 'Reviewer override changed nothing',
    why: 'An override set a field to the value it already held. That hides the field from the worklist without correcting anything, and a mis-pathed override looks identical to a real correction.',
  },
  rentroll_stale: {
    title: 'Rent roll is stale',
    why: 'Rolls arrive monthly; more than 75 days means at least two have been missed. Occupancy, WALT and rent all drift from the last load.',
  },
  brief_under_read: {
    title: 'Document brief may have under-read the file',
    why: 'Compression above 15:1 on a substantial document is the signature of a brief that read only part of it. Re-briefing the earlier cohort moved large-doc compression from 20.4:1 to 6.5:1.',
  },
}

export const SEVERITY_ORDER: Record<string, number> = { discrepancy: 0, confirm: 1, info: 2 }

/**
 * Standing deterministic data-quality findings for one property
 * (v_property_data_quality, migration 20240181). Costs no AI: every check is SQL
 * over data already stored. Findings already resolved through the Review Center
 * are returned with resolved=true so they can be shown as settled rather than
 * silently disappearing.
 */
export function useDataQuality(propertyId: string | null) {
  return useQuery<DataQualityFinding[]>(async () => {
    if (!propertyId) return []
    const { data, error } = await supabase
      .from('v_property_data_quality')
      .select('*')
      .eq('property_id', propertyId)
    if (error) throw new Error(error.message)
    return ((data ?? []) as DataQualityFinding[]).sort((a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
      a.check_code.localeCompare(b.check_code) ||
      (a.tenant_name ?? '').localeCompare(b.tenant_name ?? ''))
  }, [propertyId])
}
