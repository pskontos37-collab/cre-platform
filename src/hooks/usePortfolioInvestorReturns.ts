import { useMemo } from 'react'
import { xirr } from '../lib/waterfall'
import type { DealRow } from './useDeals'

export interface PortfolioInvestorReturn {
  name: string
  role: string
  layer: 1 | 2
  propertyCount: number
  totalContributed: number
  totalDistributed: number
  totalMultiple: number | null
  totalIrr: number | null
}

const ROLE_NAMES: Record<string, string> = {
  'lp': 'LP Partner',
  'gp': 'GP (MJW Wilkow)',
  'class_a': 'Class A',
  'class_ac': 'Class A/C',
  'class_b': 'Class B (Promote)',
  'class_c': 'Class C',
  'class_d': 'Class D (Senior)',
}

/**
 * Aggregate investor returns across multiple properties at portfolio level.
 */
export function usePortfolioInvestorReturns(
  deals: DealRow[] | null,
  layer: 1 | 2 = 1,
): PortfolioInvestorReturn[] {
  return useMemo(() => {
    if (!deals || deals.length === 0) return []

    const layerDeals = deals.filter(d => d.layer === layer)
    if (layerDeals.length === 0) return []

    const roles = layer === 2
      ? ['class_a', 'class_ac', 'class_b', 'class_c', 'class_d']
      : ['lp', 'gp']

    const results: PortfolioInvestorReturn[] = []

    for (const role of roles) {
      const docsWithRole = layerDeals.filter(d =>
        d.capital_flows.some(f => f.role === role)
      )

      if (docsWithRole.length === 0) continue

      let contributed = 0
      let distributed = 0

      // Pool every dated capital flow for this role across all properties, so
      // we can run one portfolio-level IRR on the combined cash stream.
      const flows = docsWithRole.flatMap(doc =>
        doc.capital_flows
          .filter(f => f.role === role)
          .map(f => ({ date: f.flow_date, amount: Number(f.amount ?? 0) })),
      )

      for (const flow of flows) {
        if (flow.amount < 0) {
          contributed -= flow.amount
        } else {
          distributed += flow.amount
        }
      }

      const multiple = contributed > 0 ? distributed / contributed : null

      // Realized IRR on cash to date. xirr returns null unless the stream has
      // both a contribution and a distribution (mirrors the property-level guard).
      const irr = contributed > 0 && distributed > 0 ? xirr(flows) : null

      results.push({
        name: ROLE_NAMES[role] || role,
        role,
        layer,
        propertyCount: docsWithRole.length,
        totalContributed: contributed,
        totalDistributed: distributed,
        totalMultiple: multiple,
        totalIrr: irr,
      })
    }

    return results
  }, [deals, layer])
}
