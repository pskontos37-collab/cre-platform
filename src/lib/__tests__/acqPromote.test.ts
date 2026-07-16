import { describe, it, expect } from 'vitest'
import { computePromote, buildPromoteTiers, DEFAULT_PROMOTE, type PromoteStructure } from '../acqPromote'
import type { DatedFlow } from '../waterfall'

// A ~5-year hold: -equity at close, single exit distribution.
const T0 = '2026-07-15'
const T5 = '2031-07-14'
const flows = (equity: number, exit: number): DatedFlow[] => [
  { date: T0, amount: -equity },
  { date: T5, amount: exit },
]

const STD: PromoteStructure = { lpEquityPct: 0.9, prefRate: 0.08, tiers: [{ hurdleIrr: 0.15, gpPct: 0.20 }, { hurdleIrr: null, gpPct: 0.30 }] }

describe('acqPromote', () => {
  it('builds a pari-passu pref tier plus the promote tiers', () => {
    const tiers = buildPromoteTiers(STD)
    expect(tiers).toHaveLength(3)
    // gp/lp splits derived by subtraction (e.g. 1 - 0.9) carry IEEE-754 error,
    // so match the exact literals with toMatchObject and the derived side with
    // toBeCloseTo. tier 1 = pari-passu to the 8% pref, 90/10.
    expect(tiers[0]).toMatchObject({ tier_type: 'promote_split', hurdle_irr: 0.08, lp_split_pct: 0.9 })
    expect(tiers[0].gp_split_pct).toBeCloseTo(0.1, 10)
    // tier 2 = 15% hurdle, 80/20
    expect(tiers[1]).toMatchObject({ hurdle_irr: 0.15, gp_split_pct: 0.2 })
    expect(tiers[1].lp_split_pct).toBeCloseTo(0.8, 10)
    // tier 3 = residual, 70/30
    expect(tiers[2]).toMatchObject({ hurdle_irr: null, gp_split_pct: 0.3 })
    expect(tiers[2].lp_split_pct).toBeCloseTo(0.7, 10)
  })

  it('routes all cash to the LP when the GP takes no equity and no promote', () => {
    const r = computePromote(flows(100, 200), { lpEquityPct: 1, prefRate: 0.08, tiers: [{ hurdleIrr: null, gpPct: 0 }] })
    expect(r.gpCash).toBeCloseTo(0, 6)
    expect(r.lpCash).toBeCloseTo(200, 6)
    expect(r.lpIrr!).toBeCloseTo(r.dealLeveredIrr!, 6)   // LP == whole-deal levered IRR
  })

  it('is pari-passu (no promote) when the deal never clears the pref', () => {
    const r = computePromote(flows(100, 130), STD)   // 1.30x over 5y ~= 5.4% IRR < 8% pref
    expect(r.lpCash).toBeCloseTo(117, 6)             // 90% of 130
    expect(r.gpCash).toBeCloseTo(13, 6)              // 10% of 130
    expect(r.gpPromote).toBeCloseTo(0, 6)
    expect(r.lpIrr!).toBeCloseTo(r.gpIrr!, 6)         // equal returns, pari-passu
  })

  it('pays the GP a promote once the LP clears the pref (tier 2 engaged)', () => {
    const r = computePromote(flows(100, 200), STD)   // 2.0x over 5y ~= 14.9% IRR, between 8% and 15%
    expect(r.lpCash + r.gpCash).toBeCloseTo(200, 4)  // cash conserved
    expect(r.gpIrr!).toBeGreaterThan(r.lpIrr!)        // GP outperforms via promote
    expect(r.lpIrr!).toBeGreaterThan(0.08)
    expect(r.lpIrr!).toBeLessThan(0.15)
    expect(r.gpPromote).toBeGreaterThan(0)
    expect(r.gpEm!).toBeGreaterThan(r.lpEm!)
  })

  it('engages the residual (top) tier on a high return and conserves cash', () => {
    const r = computePromote(flows(100, 400), STD)   // 4.0x over 5y ~= 32% IRR, above the 15% hurdle
    expect(r.lpCash + r.gpCash).toBeCloseTo(400, 4)
    expect(r.gpIrr!).toBeGreaterThan(r.lpIrr!)
    expect(r.gpPromotePctOfProfit).toBeGreaterThan(0)
    expect(r.gpPromotePctOfProfit).toBeLessThan(0.30)  // blended below the top-tier 30%
  })

  it('DEFAULT_PROMOTE is a standard 90/10, 8% pref, 80/20-to-15, 70/30 structure', () => {
    expect(DEFAULT_PROMOTE.lpEquityPct).toBe(0.9)
    expect(DEFAULT_PROMOTE.prefRate).toBe(0.08)
    expect(DEFAULT_PROMOTE.tiers.map(t => t.gpPct)).toEqual([0.20, 0.30])
  })
})
