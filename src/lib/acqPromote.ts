// acqPromote.ts — split an acquisition's projected LEVERED cash flow between an
// LP and a GP through a promote waterfall, and report each side's IRR / equity
// multiple plus the GP promote dollars. Reuses the validated IRR-hurdle engine in
// waterfall.ts (runIrrWaterfall) so the acquisition underwrite and the live
// portfolio waterfalls share one solver.
//
// Structure (institutional value-add JV, first-pass):
//   • LP and GP co-invest the equity at lpEquityPct / (1 - lpEquityPct).
//   • Tier 1 is PARI-PASSU (split = the equity ratio) up to the `prefRate` IRR —
//     an IRR-hurdle tier inherently returns capital + the pref, so no separate
//     return-of-capital / preferred-return tiers are needed.
//   • Each promote tier then splits cash LP/GP (GP > its co-invest share) until the
//     LP reaches that tier's hurdle IRR; the last tier (hurdleIrr null) is residual.
//
// Negative levered-flow years are treated as additional pro-rata capital calls
// (appended to each side's contributions), not distributions. Pure functions.

import { runIrrWaterfall, xirr, type DatedFlow } from './waterfall'
import type { WaterfallTier } from '../types/database'

export interface PromoteTier {
  hurdleIrr: number | null   // LP IRR at which this tier is satisfied (null = residual)
  gpPct: number              // GP share of cash in this tier (decimal, e.g. 0.20)
}

export interface PromoteStructure {
  lpEquityPct: number        // LP share of equity (GP = 1 - lpEquityPct), e.g. 0.9
  prefRate: number           // pari-passu preferred return IRR, e.g. 0.08
  tiers: PromoteTier[]        // promote tiers above the pref, in ascending hurdle order
}

export const DEFAULT_PROMOTE: PromoteStructure = {
  lpEquityPct: 0.9,
  prefRate: 0.08,
  tiers: [
    { hurdleIrr: 0.15, gpPct: 0.20 },   // 8%–15% IRR: 80/20
    { hurdleIrr: null, gpPct: 0.30 },   // above 15%: 70/30
  ],
}

export interface PromoteResult {
  lpEquity: number
  gpEquity: number
  totalDistributed: number
  lpCash: number
  gpCash: number
  lpIrr: number | null
  gpIrr: number | null
  lpEm: number | null
  gpEm: number | null
  dealLeveredIrr: number | null   // blended (undivided) levered IRR
  gpProrata: number               // GP's co-invest (no-promote) share of distributions
  gpPromote: number               // gpCash - gpProrata (the promote dollars)
  gpPromotePctOfProfit: number    // promote / total profit above returned capital
}

/** Build the promote_split tier ladder for computeIrrWaterfall from a PromoteStructure. */
export function buildPromoteTiers(s: PromoteStructure): WaterfallTier[] {
  const gpEquityPct = Math.max(0, 1 - s.lpEquityPct)
  const mk = (order: number, hurdle: number | null, lp: number, gp: number): WaterfallTier => ({
    id: `t${order}`, deal_id: 'acq', tier_order: order, tier_type: 'promote_split',
    description: null, hurdle_irr: hurdle, hurdle_em: null, pref_rate: null,
    lp_split_pct: lp, gp_split_pct: gp, is_cumulative: false, is_pik: false, created_at: '',
  })
  const tiers: WaterfallTier[] = [mk(1, s.prefRate, s.lpEquityPct, gpEquityPct)]  // pari-passu to pref
  s.tiers.forEach((t, i) => tiers.push(mk(i + 2, t.hurdleIrr, Math.max(0, 1 - t.gpPct), t.gpPct)))
  return tiers
}

/**
 * Split `leveredFlows` (from computeReturns / underwrite / underwriteTenant) LP vs GP.
 * flow[0] is the -equity outlay at close; later negatives are pro-rata capital calls;
 * positives are distribution events run through the waterfall.
 */
export function computePromote(leveredFlows: DatedFlow[], s: PromoteStructure): PromoteResult {
  const lpPct = Math.min(1, Math.max(0, s.lpEquityPct))
  const gpPct = 1 - lpPct
  const lpFlows: DatedFlow[] = []
  const gpFlows: DatedFlow[] = []
  const events: { date: string | Date; amount: number }[] = []
  for (const f of leveredFlows) {
    if (f.amount < 0) {
      lpFlows.push({ date: f.date, amount: f.amount * lpPct })
      gpFlows.push({ date: f.date, amount: f.amount * gpPct })
    } else if (f.amount > 0) {
      events.push({ date: f.date, amount: f.amount })
    }
  }

  const sumNeg = (fs: DatedFlow[]) => fs.filter(f => f.amount < 0).reduce((a, f) => a - f.amount, 0)
  const lpEquity = sumNeg(lpFlows)
  const gpEquity = sumNeg(gpFlows)

  const run = runIrrWaterfall({
    positions: [
      { investorId: 'LP', type: 'lp', flows: lpFlows },
      { investorId: 'GP', type: 'gp', flows: gpFlows },
    ],
    tiers: buildPromoteTiers(s),
    events,
  })

  const lpCash = run.lpTotal
  const gpCash = run.gpTotal
  const totalDistributed = lpCash + gpCash
  const contribTotal = lpEquity + gpEquity
  const gpShareOfCapital = contribTotal > 0 ? gpEquity / contribTotal : gpPct
  const gpProrata = gpShareOfCapital * totalDistributed
  const gpPromote = gpCash - gpProrata
  const totalProfit = totalDistributed - contribTotal

  return {
    lpEquity, gpEquity, totalDistributed, lpCash, gpCash,
    lpIrr: run.lpIrr, gpIrr: run.gpIrr,
    lpEm: lpEquity > 0 ? lpCash / lpEquity : null,
    gpEm: gpEquity > 0 ? gpCash / gpEquity : null,
    dealLeveredIrr: xirr(leveredFlows),
    gpProrata, gpPromote,
    gpPromotePctOfProfit: totalProfit > 0 ? gpPromote / totalProfit : 0,
  }
}
