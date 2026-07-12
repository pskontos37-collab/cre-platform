import { useMemo } from 'react'
import { xirr, type DatedFlow } from '../lib/waterfall'
import type { DealRow } from './useDeals'

export interface InvestorReturn {
  name: string
  role: string // 'lp', 'gp', 'class_a', etc.
  contributed: number
  distributed: number
  soldTodayValue: number // projected sale proceeds
  irr: number | null
  em: number | null
}

/**
 * Compute realized IRR and EM for each investor class/role.
 * For Layer 1: LP vs GP
 * For Layer 2: Class A, B, C, D
 *
 * Pass soldTodayMap with role -> sale proceeds mapping to calculate projected returns.
 * If empty, shows historical returns based on distributions to date.
 */
export function useInvestorReturns(
  deal: DealRow | null,
  asOfDate: string, // ISO date string
  soldTodayMap: Record<string, number> = {}, // role -> sale proceeds (optional)
): InvestorReturn[] {
  return useMemo(() => {
    if (!deal) return []

    const roles = deal.layer === 2
      ? ['class_a', 'class_ac', 'class_b', 'class_c', 'class_d']
      : ['lp', 'gp']

    return roles
      .map(role => {
        const flows = deal.capital_flows
          .filter(f => f.role === role)
          .map(f => ({ date: f.flow_date, amount: Number(f.amount) }))

        if (flows.length === 0) return null

        const contributed = flows
          .filter(f => f.amount < 0)
          .reduce((s, f) => s - f.amount, 0)

        const distributed = flows
          .filter(f => f.amount > 0)
          .reduce((s, f) => s + f.amount, 0)

        // Get sale proceeds for this role (if provided for "sold today" scenario)
        const saleProceeds = soldTodayMap[role] ?? 0

        // Calculate IRR
        // If saleProceeds provided, include it; otherwise just use historical distributions
        let irr: number | null = null
        if (contributed > 0) {
          if (saleProceeds !== 0) {
            // Projected scenario: add sale proceeds as of date
            irr = xirr([...flows, { date: asOfDate, amount: saleProceeds }])
          } else if (distributed > 0) {
            // Historical scenario: IRR based on distributions to date
            irr = xirr(flows)
          }
        }

        let em: number | null = null
        if (contributed > 0) {
          em = (distributed + saleProceeds) / contributed
        }

        // Friendly names
        const nameMap: Record<string, string> = {
          'lp': 'LP Partner',
          'gp': 'GP (MJW Wilkow)',
          'class_a': 'Class A',
          'class_ac': 'Class A/C',
          'class_b': 'Class B (Promote)',
          'class_c': 'Class C',
          'class_d': 'Class D (Senior)',
        }

        return {
          name: nameMap[role] || role,
          role,
          contributed,
          distributed,
          soldTodayValue: saleProceeds,
          irr,
          em,
        }
      })
      .filter(Boolean) as InvestorReturn[]
  }, [deal, asOfDate, soldTodayMap])
}
