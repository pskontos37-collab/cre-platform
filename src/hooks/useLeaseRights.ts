import { supabase } from '../lib/supabase'
import { useQuery } from './useQuery'

// Lease Rights Radar (migration 20240072, spec docs/COTENANCY-RISK-RADAR-SPEC.md):
// live risk computed by two SQL RPCs — nothing is cached or cron-scheduled, so the
// tiers always reflect the current leases / options / occupancy / reported sales.

export type RiskTier = 'triggered' | 'stale_data' | 'high' | 'watch' | 'unknown' | 'ok'

export interface CoTenancyRiskRow {
  clause_id: string
  lease_id: string
  property_id: string
  tenant_name: string
  tier: RiskTier
  reasons: string[]
  named_at_risk: {
    label: string
    state: string
    expiration: string | null
    notice_deadline: string | null
    is_rea_member: boolean
    newer_notice_doc: boolean
  }[]
  occupancy_pct: number | null
  threshold_pct: number | null
  exposed_annual_rent: number | null
}

export type TerminationTier = 'triggered' | 'high' | 'watch' | 'open' | 'lapsed' | 'unknown' | 'informational' | 'ok'

export interface TerminationRiskRow {
  right_id: string
  lease_id: string
  property_id: string
  tenant_name: string
  right_type: 'sales_kickout' | 'fixed_window' | 'ongoing_notice' | 'cotenancy_termination' | 'other'
  tier: TerminationTier
  reasons: string[]
  ttm_sales: number | null
  sales_threshold: number | null
  notice_days: number | null
  window_start: string | null
  window_end: string | null
  lease_expiration: string | null
  exposed_annual_rent: number | null
  details: string | null
}

export function useCoTenancyRisk(propertyIds?: string[]) {
  return useQuery<CoTenancyRiskRow[]>(async () => {
    const { data, error } = await supabase.rpc('co_tenancy_risk')
    if (error) throw new Error(error.message)
    let rows = (data ?? []) as CoTenancyRiskRow[]
    if (propertyIds?.length) rows = rows.filter(r => propertyIds.includes(r.property_id))
    return rows
  }, [propertyIds?.join(',') ?? ''])
}

export function useTerminationRisk(propertyIds?: string[]) {
  return useQuery<TerminationRiskRow[]>(async () => {
    const { data, error } = await supabase.rpc('termination_risk')
    if (error) throw new Error(error.message)
    let rows = (data ?? []) as TerminationRiskRow[]
    if (propertyIds?.length) rows = rows.filter(r => propertyIds.includes(r.property_id))
    return rows
  }, [propertyIds?.join(',') ?? ''])
}

// Ranks for sorting: most urgent first.
export const TIER_RANK: Record<string, number> = {
  triggered: 0, open: 1, stale_data: 2, high: 3, watch: 4, unknown: 5, informational: 6, ok: 7, lapsed: 8,
}

export const TIER_COLOR: Record<string, { fg: string; bg: string }> = {
  triggered:     { fg: 'var(--red)',        bg: 'var(--red-bg, rgba(220,60,60,.12))' },
  open:          { fg: 'var(--red)',        bg: 'var(--red-bg, rgba(220,60,60,.12))' },
  high:          { fg: 'var(--amber)',      bg: 'var(--amber-bg)' },
  stale_data:    { fg: 'var(--amber)',      bg: 'var(--amber-bg)' },
  watch:         { fg: 'var(--text-muted)', bg: 'var(--surface-2)' },
  unknown:       { fg: 'var(--text-faint)', bg: 'var(--surface-2)' },
  informational: { fg: 'var(--text-faint)', bg: 'var(--surface-2)' },
  ok:            { fg: 'var(--green, #3a9)', bg: 'var(--surface-2)' },
  lapsed:        { fg: 'var(--text-faint)', bg: 'var(--surface-2)' },
}

export const TIER_LABEL: Record<string, string> = {
  triggered: 'Triggered', open: 'Exercisable now', stale_data: 'Data stale — reconcile',
  high: 'High risk', watch: 'Watch', unknown: 'Monitor manually',
  informational: 'Info', ok: 'OK', lapsed: 'Lapsed',
}
