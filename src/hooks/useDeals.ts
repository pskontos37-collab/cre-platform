import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'
import type { WaterfallTier } from '../types/database'

export interface DealPrefPosition {
  id: string
  principal_amount: number
  preferred_rate: number
  is_pik: boolean
  priority_rank: number
}

export interface CapitalFlowRow {
  id: string
  deal_id: string
  party: string
  role: 'lp' | 'gp' | 'class_a' | 'class_ac' | 'class_b' | 'class_c' | 'class_d'
  flow_date: string
  amount: number
  source: string | null
}

/** deals.selltoday jsonb — per-deal sell-today defaults + agreement quirks. */
export interface SellTodayConfig {
  gross_value?: number
  closing_cost_pct?: number
  nca?: number
  payoff?: number
  payoff_label?: string
  freeze_date?: string
  override?: { threshold: number; lp: number; gp: number }
  cash_split?: { lp: number; gp: number }
  entity_cash?: number
  units?: Record<string, number>
  class_d_caps?: { irr: number; em: number }
}

export interface EntityInvestorRow {
  id: string
  name: string
  unit_class: string
  units: number
}

export interface DealRow {
  id: string
  name: string
  property_id: string
  closing_date: string | null
  total_equity: number | null
  gp_equity: number | null
  lp_equity: number | null
  preferred_equity_amount: number | null
  notes: string | null
  layer: 1 | 2 | null
  selltoday: SellTodayConfig | null
  properties: { name: string } | null
  waterfall_tiers: WaterfallTier[]
  preferred_equity_positions: DealPrefPosition[]
  capital_flows: CapitalFlowRow[]
  entity_investors: EntityInvestorRow[]
}

/** All modeled deals with tiers, pref positions, dated capital flows, rosters, and property name. */
export function useDeals() {
  return useQuery<DealRow[]>(async () => {
    const { data, error } = await supabase
      .from('deals')
      .select('*, properties(name), waterfall_tiers(*), preferred_equity_positions(*), capital_flows(*), entity_investors(*)')
      .order('name')
    if (error) throw new Error(error.message)
    return (data ?? []) as unknown as DealRow[]
  }, [])
}
