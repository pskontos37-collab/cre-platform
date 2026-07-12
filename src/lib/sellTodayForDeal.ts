import {
  computeSellToday,
  type SellTodayResult,
  type SellTodayL2Config,
  type IrrPosition,
  type SeniorClassPosition,
  type DatedFlow,
} from './waterfall'
import type { DealRow } from '../hooks/useDeals'

export const todayIso = () => new Date().toISOString().slice(0, 10)

export function flowsByRoles(d: DealRow, roles: string[]): DatedFlow[] {
  return d.capital_flows
    .filter(f => roles.includes(f.role))
    .map(f => ({ date: f.flow_date, amount: Number(f.amount) }))
}

/**
 * Layer-1 "sold today" for a single deal, using the deal's stored `selltoday`
 * config as the sale assumptions. This is the dashboard-rollup basis and mirrors
 * WaterfallPage's runSellToday for the L1 legs — the /waterfall page additionally
 * overlays a live GL-derived net-current-assets figure and lets the user tweak
 * gross value; here we take the stored config values as-is.
 *
 * Returns null when the deal has no LP flows or no current valuation
 * (gross_value), since a total-value return is not meaningful without a value.
 *
 * `ncaOverride` (e.g. the live GL-derived net current assets) takes precedence
 * over the stored config nca when provided — mirroring the /waterfall page,
 * where GL NCA wins. A value of 0 is a valid override and is respected.
 */
export function sellTodayL1(
  deal: DealRow,
  asOf = todayIso(),
  ncaOverride?: number | null,
): SellTodayResult | null {
  const lpFlows = flowsByRoles(deal, ['lp'])
  if (lpFlows.length === 0) return null

  const c1 = deal.selltoday ?? {}
  if (!c1.gross_value) return null

  const positions: IrrPosition[] = [
    { investorId: 'lp', type: 'lp', flows: lpFlows },
    { investorId: 'gp', type: 'gp', flows: flowsByRoles(deal, ['gp']) },
  ]

  return computeSellToday({
    asOfDate: asOf,
    grossValue: c1.gross_value,
    closingCostPct: c1.closing_cost_pct ?? 0.015,
    netCurrentAssets: ncaOverride ?? c1.nca ?? 0,
    payoff: c1.payoff ?? 0,
    l1: {
      positions,
      tiers: deal.waterfall_tiers,
      freezeDate: c1.freeze_date ?? null,
      saleOverride: c1.override
        ? { threshold: c1.override.threshold, lpShare: c1.override.lp, gpShare: c1.override.gp }
        : null,
      cashSplit: c1.cash_split
        ? { lpShare: c1.cash_split.lp, gpShare: c1.cash_split.gp }
        : null,
    },
  })
}

/**
 * Full two-layer "sold today" for a deal that has a Layer-2 syndication entity.
 * Mirrors WaterfallPage.runSellToday: runs the L1 JV waterfall, then cascades the
 * GP take (plus entity cash) through the M&J entity to value each unit class —
 * Class A/C (syndication LPs), Class B (MJW promote), Class D (senior). Needed to
 * report GP/promote returns, which have no Layer-1 cash basis (`result.l2.classBValue`).
 *
 * `l2Deal` is the layer-2 deal for the same property (null → L1-only, no l2 block).
 * Returns null when the L1 deal has no LP flows or no current valuation.
 */
export function sellTodayFull(
  l1Deal: DealRow,
  l2Deal: DealRow | null,
  asOf = todayIso(),
  ncaOverride?: number | null,
): SellTodayResult | null {
  const lpFlows = flowsByRoles(l1Deal, ['lp'])
  if (lpFlows.length === 0) return null

  const c1 = l1Deal.selltoday ?? {}
  if (!c1.gross_value) return null

  const positions: IrrPosition[] = [
    { investorId: 'lp', type: 'lp', flows: lpFlows },
    { investorId: 'gp', type: 'gp', flows: flowsByRoles(l1Deal, ['gp']) },
  ]

  let l2: SellTodayL2Config | undefined
  if (l2Deal) {
    const c2 = l2Deal.selltoday ?? {}
    const dFlows = flowsByRoles(l2Deal, ['class_d'])
    const seniorClasses: SeniorClassPosition[] = dFlows.length > 0
      ? [{ investorId: 'class_d', flows: dFlows, irrCap: c2.class_d_caps?.irr ?? 0.15, emCap: c2.class_d_caps?.em ?? 2.0 }]
      : []
    l2 = {
      entityCash: c2.entity_cash ?? 0,
      lpFlows: flowsByRoles(l2Deal, ['class_a', 'class_ac', 'class_c']),
      gpFlows: flowsByRoles(l2Deal, ['class_b']),
      seniorClasses,
      tiers: l2Deal.waterfall_tiers,
    }
  }

  return computeSellToday({
    asOfDate: asOf,
    grossValue: c1.gross_value,
    closingCostPct: c1.closing_cost_pct ?? 0.015,
    netCurrentAssets: ncaOverride ?? c1.nca ?? 0,
    payoff: c1.payoff ?? 0,
    l1: {
      positions,
      tiers: l1Deal.waterfall_tiers,
      freezeDate: c1.freeze_date ?? null,
      saleOverride: c1.override
        ? { threshold: c1.override.threshold, lpShare: c1.override.lp, gpShare: c1.override.gp }
        : null,
      cashSplit: c1.cash_split
        ? { lpShare: c1.cash_split.lp, gpShare: c1.cash_split.gp }
        : null,
    },
    l2,
  })
}
