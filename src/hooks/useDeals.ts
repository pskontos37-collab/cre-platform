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
  // abstractor-v2 JV phase (migration 20240105): verified operating-agreement
  // abstract + QA verdict (agreement-abstract / agreement-verify kind=jv).
  abstract: any | null
  // Entity-matched source documents the abstract was synthesized from. Persisted
  // by agreement-abstract so a regenerate re-reads the SAME curated doc set.
  abstract_source_doc_ids: string[] | null
  qa: any | null
  qa_status: string | null
  qa_at: string | null
  properties: { name: string; asset_type: string | null } | null
  waterfall_tiers: WaterfallTier[]
  preferred_equity_positions: DealPrefPosition[]
  capital_flows: CapitalFlowRow[]
  entity_investors: EntityInvestorRow[]
}

/** On-demand regeneration of a JV deal's verified operating-agreement abstract.
 *  Re-runs agreement-abstract (kind=jv) against the deal's stored
 *  abstract_source_doc_ids (the entity-matched doc set jv_rollout curated), then
 *  the agreement-verify adversarial pass. The generator invalidates the prior QA
 *  before verify re-scores it. Returns the fresh qa_status for the toast. */
export async function regenerateJvAbstract(dealId: string): Promise<{ qaStatus: string | null; docsUsed: number }> {
  const gen = await supabase.functions.invoke('agreement-abstract', { body: { kind: 'jv', id: dealId } })
  if (gen.error) throw new Error((gen.data as any)?.error ?? gen.error.message)
  if ((gen.data as any)?.error) throw new Error((gen.data as any).error)
  const docsUsed = Number((gen.data as any)?.docs_used ?? 0)

  const ver = await supabase.functions.invoke('agreement-verify', { body: { kind: 'jv', id: dealId } })
  if (ver.error) throw new Error((ver.data as any)?.error ?? ver.error.message)
  if ((ver.data as any)?.error) throw new Error((ver.data as any).error)
  return { qaStatus: (ver.data as any)?.qa_status ?? null, docsUsed }
}

/** All modeled deals with tiers, pref positions, dated capital flows, rosters, and property name. */
export function useDeals() {
  return useQuery<DealRow[]>(async () => {
    const { data, error } = await supabase
      .from('deals')
      .select('*, properties(name, asset_type), waterfall_tiers(*), preferred_equity_positions(*), capital_flows(*), entity_investors(*)')
      .order('name')
    if (error) throw new Error(error.message)
    return (data ?? []) as unknown as DealRow[]
  }, [])
}
