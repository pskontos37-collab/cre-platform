import { supabase } from '../lib/supabase'
import type { Property, Portfolio } from '../types/database'
import { useQuery } from './useQuery'

export interface PropertyWithPortfolio extends Property {
  portfolio: Pick<Portfolio, 'id' | 'name'> | null
}

export function useProperties() {
  return useQuery<PropertyWithPortfolio[]>(async () => {
    // Prototype starts with owned assets only; third-party-managed properties are
    // excluded until we choose to surface them (toggle this filter to include them).
    const { data, error } = await supabase
      .from('properties')
      .select('*, portfolio:portfolios(id, name)')
      .eq('ownership_type', 'owned')
      .eq('is_pipeline', false)   // DD/acquisition shells live only in /diligence, never in AUM surfaces
      .order('name')
    if (error) throw new Error(error.message)
    return (data ?? []) as PropertyWithPortfolio[]
  }, [])
}

export function usePortfolios() {
  return useQuery<Portfolio[]>(async () => {
    const { data, error } = await supabase
      .from('portfolios')
      .select('*')
      .order('name')
    if (error) throw new Error(error.message)
    return data ?? []
  }, [])
}

/**
 * The set of portfolio ids rooted at `rootId` — the portfolio itself plus every
 * descendant down the parent_id tree. Lets a filter or access grant on a parent
 * portfolio (e.g. MetLife) roll up its children (e.g. MetLife/URS). One-directional:
 * asking for a child never pulls in its parent's direct assets.
 */
export function portfolioSubtreeIds(portfolios: Portfolio[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const p of portfolios) {
    if (!p.parent_id) continue
    const arr = childrenOf.get(p.parent_id) ?? []
    arr.push(p.id)
    childrenOf.set(p.parent_id, arr)
  }
  const out = new Set<string>()
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()!
    if (out.has(id)) continue
    out.add(id)
    for (const c of childrenOf.get(id) ?? []) stack.push(c)
  }
  return out
}
