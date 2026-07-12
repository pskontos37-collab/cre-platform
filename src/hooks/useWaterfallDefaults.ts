import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'
import type { DealRow } from './useDeals'

export interface WaterfallDefaults {
  closingCostPct: number // percent, e.g. 1.5
  nca: number           // net current assets
  payoff: number        // debt payoff
  payoffLabel: string   // label for payoff
}

/**
 * Get waterfall defaults from deal configuration (deals.selltoday stored values).
 * GL-derived NCA (useGlNca below) takes precedence over the stored nca when available.
 */
export function getWaterfallDefaults(l1Deal: DealRow | null): WaterfallDefaults {
  if (!l1Deal?.selltoday) {
    return { closingCostPct: 1.5, nca: 0, payoff: 0, payoffLabel: 'Debt payoff' }
  }

  const c = l1Deal.selltoday
  return {
    closingCostPct: (c.closing_cost_pct ?? 0.015) * 100,
    nca: c.nca ?? 0,
    payoff: c.payoff ?? 0,
    payoffLabel: c.payoff_label ?? 'Debt payoff',
  }
}

/**
 * Net current assets computed server-side from the property's latest GL year
 * (migration 20240074_property_nca): current assets (cash, receivables net of
 * allowance, prepaids, escrows) less current liabilities (payables, accruals,
 * deposits, prepaid rent). Straight-line rent and mortgage/loan principal are
 * excluded — principal belongs in the payoff input.
 */
export interface GlNca {
  nca: number
  assets: number
  liabilities: number
  gl_year: number
}

export function useGlNca(propertyId: string | null) {
  return useQuery<GlNca | null>(async () => {
    if (!propertyId) return null
    const { data, error } = await supabase.rpc('property_nca', { pid: propertyId })
    if (error) throw new Error(error.message)
    const row = Array.isArray(data) ? data[0] : data
    if (!row || row.gl_year == null) return null
    return {
      nca: Number(row.nca ?? 0),
      assets: Number(row.assets ?? 0),
      liabilities: Number(row.liabilities ?? 0),
      gl_year: Number(row.gl_year),
    }
  }, [propertyId])
}
