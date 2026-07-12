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
  /** The property this figure was computed for. `useQuery` keeps stale data across
   *  key changes, so callers must confirm this matches the currently selected
   *  property before applying the figure (a Gateway NCA must not leak into Knightdale). */
  propertyId: string
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
      propertyId,
      nca: Number(row.nca ?? 0),
      assets: Number(row.assets ?? 0),
      liabilities: Number(row.liabilities ?? 0),
      gl_year: Number(row.gl_year),
    }
  }, [propertyId])
}

/**
 * Batched GL net-current-assets lookup for the portfolio dashboard. Runs the
 * property_nca RPC for each property and returns a { propertyId -> nca } map,
 * omitting properties that have no GL year (callers fall back to the stored
 * selltoday.nca). Keeps the dashboard's sold-today math on the same NCA basis
 * as the /waterfall page.
 */
export function useGlNcaMap(propertyIds: string[]) {
  const key = [...propertyIds].sort().join(',')
  return useQuery<Record<string, number>>(async () => {
    if (propertyIds.length === 0) return {}
    const entries = await Promise.all(propertyIds.map(async pid => {
      const { data, error } = await supabase.rpc('property_nca', { pid })
      if (error) throw new Error(error.message)
      const row = Array.isArray(data) ? data[0] : data
      if (!row || row.gl_year == null) return [pid, null] as const
      return [pid, Number(row.nca ?? 0)] as const
    }))
    const map: Record<string, number> = {}
    for (const [pid, nca] of entries) if (nca != null) map[pid] = nca
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}
