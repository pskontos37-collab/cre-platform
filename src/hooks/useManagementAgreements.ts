import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'

export interface MgmtDeadline {
  id: string
  agreement_id: string
  property_id: string
  kind: string
  label: string
  frequency: string | null
  due_rule: string | null
  next_due: string | null
  source_section: string | null
}

export interface MgmtAgreement {
  id: string
  property_id: string
  document_id: string | null
  role: string
  manager_name: string | null
  sub_manager_name: string | null
  owner_name: string | null
  effective_date: string | null
  amends_id: string | null
  term_start: string | null
  term_end: string | null
  termination_notice_days: number | null
  mgmt_fee_pct: number | null
  construction_fee_pct: number | null
  leasing_fee_pct: number | null
  budget_variance_pct: number | null
  monthly_report_due_day: number | null
  terms: Record<string, unknown>
  is_current: boolean
  notes: string | null
  // abstractor-v2 PMA phase (migration 20240104): verified abstract + QA verdict
  abstract?: any | null
  qa?: any | null
  qa_status?: string | null
  qa_at?: string | null
  properties?: { name: string } | null
  management_agreement_deadlines?: MgmtDeadline[]
}

export function useManagementAgreements(propertyId: string | null) {
  return useQuery<MgmtAgreement[]>(async () => {
    if (!propertyId) return []
    const { data, error } = await supabase
      .from('management_agreements')
      .select('*, properties(name), management_agreement_deadlines(*)')
      .eq('property_id', propertyId)
      .order('effective_date', { ascending: true })
    if (error) throw new Error(error.message)
    return (data ?? []) as unknown as MgmtAgreement[]
  }, [propertyId])
}
