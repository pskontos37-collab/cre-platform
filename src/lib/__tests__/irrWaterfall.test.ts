import { describe, it, expect } from 'vitest'
import {
  xnpv, xirr, cashToHitIrr, seniorClassOwed,
  computeIrrWaterfall, runIrrWaterfall, computeSellToday,
  type IrrPosition, type DatedFlow,
} from '../waterfall'
import type { WaterfallTier } from '../../types/database'
import {
  GW_L1_LP, MAG_L1_LP, KM_L1_LP,
  GW_L2_AC, GW_L2_D, GW_L2_B, MAG_L2_A, MAG_L2_B, KM_L2_A, KM_L2_B,
} from './fixtures/selltodayFlows'

// ── helpers ──────────────────────────────────────────────────────────────
function tier(
  order: number,
  type: WaterfallTier['tier_type'],
  o: { hurdle?: number | null; em?: number | null; pref?: number | null; lp?: number | null; gp?: number | null } = {},
): WaterfallTier {
  return {
    id: `t${order}`, deal_id: 'd', tier_order: order, tier_type: type,
    description: null, hurdle_irr: o.hurdle ?? null, hurdle_em: o.em ?? null, pref_rate: o.pref ?? null,
    lp_split_pct: o.lp ?? null, gp_split_pct: o.gp ?? null,
    is_cumulative: true, is_pik: false, created_at: '2021-01-01',
  }
}
// Dates 365 days apart (2021/2022/2023 are all non-leap) so Actual/365 is exact.
const D2021 = '2021-01-01', D2022 = '2022-01-01', D2023 = '2023-01-01'

// ── xnpv / xirr ─────────────────────────────────────────────────────────
describe('xnpv / xirr', () => {
  it('one-year 10% return', () => {
    const flows: DatedFlow[] = [{ date: D2021, amount: -1000 }, { date: D2022, amount: 1100 }]
    expect(xnpv(0.10, flows)).toBeCloseTo(0, 4)
    expect(xirr(flows)!).toBeCloseTo(0.10, 6)
  })
  it('two-year 10% compounded', () => {
    const flows: DatedFlow[] = [{ date: D2021, amount: -1000 }, { date: D2023, amount: 1210 }]
    expect(xirr(flows)!).toBeCloseTo(0.10, 6)
  })
  it('returns null when flows never cross sign', () => {
    expect(xirr([{ date: D2021, amount: -100 }, { date: D2022, amount: -50 }])).toBeNull()
  })
  it('handles a negative IRR', () => {
    const flows: DatedFlow[] = [{ date: D2021, amount: -1000 }, { date: D2022, amount: 500 }]
    expect(xirr(flows)!).toBeCloseTo(-0.5, 6)
  })
})

// ── cashToHitIrr ────────────────────────────────────────────────────────
describe('cashToHitIrr', () => {
  it('computes the exact distribution to reach a hurdle', () => {
    const lp: DatedFlow[] = [{ date: D2021, amount: -900 }]
    const need = cashToHitIrr(lp, 0.10, D2022)
    expect(need).toBeCloseTo(990, 6)   // -900 + 990/1.1 = 0  => IRR 10%
    // verify it actually lands on the hurdle
    expect(xirr([...lp, { date: D2022, amount: need }])!).toBeCloseTo(0.10, 6)
  })
  it('returns <=0 when already above the hurdle', () => {
    const lp: DatedFlow[] = [{ date: D2021, amount: -900 }, { date: D2022, amount: 1200 }]
    expect(cashToHitIrr(lp, 0.10, D2022)).toBeLessThan(0)
  })
})

// ── promote ladder (hand-checkable) ─────────────────────────────────────
// LP -900, GP -100 at 2021; distribute at 2022 (1 yr). Tiers: 90/10 to 10% IRR,
// 80/20 to 15% IRR, 70/30 residual.
const LADDER: WaterfallTier[] = [
  tier(1, 'promote_split', { hurdle: 0.10, lp: 0.90, gp: 0.10 }),
  tier(2, 'promote_split', { hurdle: 0.15, lp: 0.80, gp: 0.20 }),
  tier(3, 'promote_split', { hurdle: null, lp: 0.70, gp: 0.30 }),
]
const POS = (): IrrPosition[] => [
  { investorId: 'lp', type: 'lp', flows: [{ date: D2021, amount: -900 }] },
  { investorId: 'gp', type: 'gp', flows: [{ date: D2021, amount: -100 }] },
]

describe('computeIrrWaterfall — promote ladder', () => {
  it('steps up the split exactly at each IRR breakpoint', () => {
    const r = computeIrrWaterfall({ cashAvailable: 2000, distributionDate: D2022, positions: POS(), tiers: LADDER })
    // tier 1: LP needs 990 (to 10%), tierTotal 1100 -> GP 110
    expect(r.tierResults[0].lp).toBeCloseTo(990, 2)
    expect(r.tierResults[0].gp).toBeCloseTo(110, 2)
    expect(r.tierResults[0].reachedHurdle).toBe(true)
    // tier 2: LP needs +45 (to 15%), tierTotal 56.25 -> GP 11.25
    expect(r.tierResults[1].lp).toBeCloseTo(45, 2)
    expect(r.tierResults[1].gp).toBeCloseTo(11.25, 2)
    // tier 3 residual: remaining 843.75 at 70/30
    expect(r.tierResults[2].lp).toBeCloseTo(590.625, 2)
    expect(r.tierResults[2].gp).toBeCloseTo(253.125, 2)
    // totals reconcile
    expect(r.lpTake + r.gpTake).toBeCloseTo(2000, 2)
    expect(r.lpTake).toBeCloseTo(1625.625, 2)
    expect(r.gpTake).toBeCloseTo(374.375, 2)
    expect(r.residualCash).toBeCloseTo(0, 6)
  })

  it('at exactly the tier-2 breakpoint, LP IRR is 15% and residual tier is empty', () => {
    const r = computeIrrWaterfall({ cashAvailable: 1156.25, distributionDate: D2022, positions: POS(), tiers: LADDER })
    expect(r.lpIrrAfter!).toBeCloseTo(0.15, 4)
    const t3 = r.tierResults.find(t => t.tierOrder === 3)
    expect(t3?.lp ?? 0).toBeCloseTo(0, 4)
  })

  it('exhausts inside tier 1 when cash is short (hurdle not reached)', () => {
    const r = computeIrrWaterfall({ cashAvailable: 500, distributionDate: D2022, positions: POS(), tiers: LADDER })
    expect(r.tierResults).toHaveLength(1)
    expect(r.tierResults[0].reachedHurdle).toBe(false)
    expect(r.tierResults[0].lp).toBeCloseTo(450, 2) // 90% of 500
    expect(r.tierResults[0].gp).toBeCloseTo(50, 2)
    expect(r.lpIrrAfter!).toBeLessThan(0.10)
  })

  it('below the first hurdle the split is pari-passu (GP gets only its 10%)', () => {
    const r = computeIrrWaterfall({ cashAvailable: 500, distributionDate: D2022, positions: POS(), tiers: LADDER })
    expect(r.gpTake / (r.lpTake + r.gpTake)).toBeCloseTo(0.10, 6)
  })
})

// ── senior preferred equity ─────────────────────────────────────────────
describe('computeIrrWaterfall — preferred equity', () => {
  it('pays simple pref return then redeems principal before common tiers', () => {
    const r = computeIrrWaterfall({
      cashAvailable: 2000, distributionDate: D2022, positions: POS(), tiers: LADDER,
      preferredEquity: [{ investorId: 'metlife', principal: 1000, rate: 0.10, sinceDate: D2021 }],
    })
    expect(r.prefTake).toBeCloseTo(1100, 2)   // 100 return + 1000 principal
    // only 900 reaches the common tiers
    expect(r.lpTake + r.gpTake).toBeCloseTo(900, 2)
  })
  it('compounding pref accrues on the unpaid balance', () => {
    const r = computeIrrWaterfall({
      cashAvailable: 5000, distributionDate: D2023, positions: POS(), tiers: LADDER,
      preferredEquity: [{ investorId: 'ml', principal: 1000, rate: 0.10, sinceDate: D2021, compounding: true }],
    })
    // 2 yrs compounding: 1000*(1.1^2 - 1) = 210 return + 1000 principal
    expect(r.prefTake).toBeCloseTo(1210, 1)
  })
})

// ── real deal shape (Knightdale L1: 90/10@12%, 70/30@15%, 60/40) ─────────
describe('computeIrrWaterfall — Knightdale-shaped tiers', () => {
  const KD: WaterfallTier[] = [
    tier(1, 'promote_split', { hurdle: 0.12, lp: 0.90, gp: 0.10 }),
    tier(2, 'promote_split', { hurdle: 0.15, lp: 0.70, gp: 0.30 }),
    tier(3, 'promote_split', { hurdle: null, lp: 0.60, gp: 0.40 }),
  ]
  it('LP lands on 12% then 15% as the promote steps 10->30->40', () => {
    const pos: IrrPosition[] = [
      { investorId: 'bbk', type: 'lp', flows: [{ date: D2021, amount: -9_000_000 }] },
      { investorId: 'mjw', type: 'gp', flows: [{ date: D2021, amount: -1_000_000 }] },
    ]
    // Big enough to clear both hurdles into the residual tier.
    const r = computeIrrWaterfall({ cashAvailable: 20_000_000, distributionDate: D2023, positions: pos, tiers: KD })
    expect(r.tierResults[0].reachedHurdle).toBe(true)
    expect(r.tierResults[1].reachedHurdle).toBe(true)
    expect(r.tierResults[2].gpSplit).toBe(0.40)
    // GP's blended share must exceed its 10% equity (it earns promote)
    expect(r.gpTake / (r.lpTake + r.gpTake)).toBeGreaterThan(0.10)
    expect(r.lpTake + r.gpTake).toBeCloseTo(20_000_000, 0)
  })
})

// ── multi-event runner ──────────────────────────────────────────────────
describe('runIrrWaterfall', () => {
  it('threads cash-flow history across events and totals reconcile', () => {
    const r = runIrrWaterfall({
      positions: POS(), tiers: LADDER,
      events: [{ date: D2022, amount: 500 }, { date: D2023, amount: 1500 }],
    })
    expect(r.lpTotal + r.gpTotal).toBeCloseTo(2000, 2)
    expect(r.events).toHaveLength(2)
    expect(r.lpIrr).not.toBeNull()
    expect(r.gpIrr).not.toBeNull()
    // GP promote means GP's realized IRR should exceed the LP's
    expect(r.gpIrr!).toBeGreaterThan(r.lpIrr!)
  })
})

// ── hurdle-freeze date ───────────────────────────────────────────────────
describe('computeIrrWaterfall — hurdle freeze', () => {
  it('solves hurdles at the freeze date, not the distribution date', () => {
    const pos: IrrPosition[] = [
      { investorId: 'lp', type: 'lp', flows: [{ date: D2021, amount: -1000 }] },
      { investorId: 'gp', type: 'gp', flows: [] },
    ]
    const tiers = [tier(1, 'promote_split', { hurdle: 0.10, lp: 0.9, gp: 0.1 }), tier(2, 'promote_split', { lp: 0.5, gp: 0.5 })]
    // distribution in 2023, but deemed made 2022: LP needs 1100 (one year at 10%), not 1210
    const r = computeIrrWaterfall({ cashAvailable: 5000, distributionDate: D2023, hurdleDate: D2022, positions: pos, tiers })
    expect(r.tierResults[0].lp).toBeCloseTo(1100, 2)
  })
})

// ── equity-multiple caps (lesser-of) ─────────────────────────────────────
describe('computeIrrWaterfall — EM caps', () => {
  it('EM governs when it is the lesser threshold', () => {
    // LP -1000 one year ago; 12% IRR needs 1120 but 1.05x EM needs only 1050.
    const pos: IrrPosition[] = [
      { investorId: 'lp', type: 'lp', flows: [{ date: D2021, amount: -1000 }] },
      { investorId: 'gp', type: 'gp', flows: [] },
    ]
    const tiers = [
      tier(1, 'promote_split', { hurdle: 0.12, em: 1.05, lp: 1.0, gp: 0.0 }),
      tier(2, 'promote_split', { lp: 0.5, gp: 0.5 }),
    ]
    const r = computeIrrWaterfall({ cashAvailable: 2050, distributionDate: D2022, positions: pos, tiers })
    expect(r.tierResults[0].lp).toBeCloseTo(1050, 2)
    expect(r.tierResults[0].emGoverned).toBe(true)
    expect(r.tierResults[1].lp).toBeCloseTo(500, 2)  // residual 1000 at 50/50
  })
})

// ── senior class (Gateway Class D shape) ─────────────────────────────────
describe('seniorClassOwed', () => {
  it('IRR leg governs near funding; EM cap governs far out', () => {
    const d = { investorId: 'class_d', flows: GW_L2_D, irrCap: 0.15, emCap: 2.0 }
    // Workbook fixture: $1,547,710 funded 10/16/25 → owed $1,593,411.85 at 12/31/25
    expect(seniorClassOwed(d, '2025-12-31')).toBeCloseTo(1593411.85162675, 2)
    // Ten years out the 2.0x EM cap binds: 2 × 1,547,710
    expect(seniorClassOwed(d, '2035-12-31')).toBeCloseTo(3095420, 2)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Sell-today fixtures from the user's own models (PS Samples.xlsx and the
// Knightdale Waterfall Revised v3 workbook). L1 hurdle solves were validated
// against the workbooks to the penny in PowerShell before porting here.
// ═════════════════════════════════════════════════════════════════════════

const GW_L1_TIERS = [
  tier(1, 'promote_split', { hurdle: 0.10, lp: 0.9, gp: 0.1 }),
  tier(2, 'promote_split', { hurdle: 0.15, lp: 0.8, gp: 0.2 }),
  tier(3, 'promote_split', { lp: 0.7, gp: 0.3 }),
]
const GW_L2_TIERS = [
  tier(1, 'return_of_capital'),
  tier(2, 'promote_split', { hurdle: 0.16, lp: 1.0, gp: 0.0 }),
  tier(3, 'promote_split', { lp: 0.8, gp: 0.2 }),   // per OA §6(c)(ii): 80/20, not the workbook's 70/30
]

describe('computeSellToday — Gateway (PS Samples 12/31/25)', () => {
  it('reproduces the estimated entity valuation', () => {
    const r = computeSellToday({
      asOfDate: '2025-12-31',
      grossValue: 246699771,
      closingCostPct: 0.01,
      netCurrentAssets: 6233403.06,
      payoff: 119001782,
      l1: {
        positions: [
          { investorId: 'ml_urs', type: 'lp', flows: GW_L1_LP },
          { investorId: 'mjw', type: 'gp', flows: [] },
        ],
        tiers: GW_L1_TIERS,
      },
      l2: {
        entityCash: 412752,   // workbook cash-on-hand
        lpFlows: GW_L2_AC,
        gpFlows: GW_L2_B,
        seniorClasses: [{ investorId: 'class_d', flows: GW_L2_D, irrCap: 0.15, emCap: 2.0 }],
        tiers: GW_L2_TIERS,
      },
    })
    // pool = 246,699,771 × 0.99 − 119,001,782 + 6,233,403.06 = 131,464,394.35 (their NOCV)
    expect(r.ladderPool).toBeCloseTo(131464394.35, 1)
    // Actual XIRR ~4.4% — everything lands in tier 1 at 90/10
    expect(r.l1LpTotal).toBeCloseTo(118317954.915, 0)
    expect(r.l1GpTotal).toBeCloseTo(13146439.435, 0)
    // Layer 2: D takes its lesser-of preference; A/C get the rest (16% pref unreached); B zero
    expect(r.l2!.pool).toBeCloseTo(13559191.435, 1)
    expect(r.l2!.seniorClassValues['class_d']).toBeCloseTo(1593411.85, 0)
    expect(r.l2!.classAValue).toBeCloseTo(11965779.58, 0)
    expect(r.l2!.classBValue).toBeCloseTo(0, 0)
  })
})

const MAG_L1_TIERS = [
  tier(1, 'promote_split', { hurdle: 0.10, lp: 0.9, gp: 0.1 }),
  tier(2, 'promote_split', { hurdle: 0.15, lp: 0.8, gp: 0.2 }),
  tier(3, 'promote_split', { lp: 0.7, gp: 0.3 }),
]
const MAG_L2_TIERS = [
  tier(1, 'return_of_capital'),
  tier(2, 'promote_split', { hurdle: 0.10, lp: 1.0, gp: 0.0 }),
  tier(3, 'promote_split', { lp: 0.6, gp: 0.4 }),
]

describe('computeSellToday — Magnolia (PS Samples 12/31/25)', () => {
  it('reproduces the estimated entity valuation (pref payoff, negative NCA)', () => {
    const r = computeSellToday({
      asOfDate: '2025-12-31',
      grossValue: 116000000,
      closingCostPct: 0.015,
      netCurrentAssets: -981010.95,
      payoff: 69500000,   // MetLife preferred equity payoff (no mortgage)
      l1: {
        positions: [
          { investorId: 'metlife', type: 'lp', flows: MAG_L1_LP },
          { investorId: 'mjw', type: 'gp', flows: [] },
        ],
        tiers: MAG_L1_TIERS,
      },
      l2: {
        entityCash: 864279.86,
        lpFlows: MAG_L2_A,
        gpFlows: MAG_L2_B,
        tiers: MAG_L2_TIERS,
      },
    })
    // pool = 116,000,000 × 0.985 − 69,500,000 (MetLife pref payoff) − 981,010.95 = 43,778,989.05
    expect(r.ladderPool).toBeCloseTo(43778989.05, 1)
    // Actual XIRR below the 10% tier-1 hurdle, so the whole pool splits 90/10
    expect(r.l1LpTotal).toBeCloseTo(39401090.145, 0)   // pool × 0.9
    expect(r.l1GpTotal).toBeCloseTo(4377898.905, 0)    // pool × 0.1
    // L2: pool = l1 GP take + entity cash 864,279.86 = 5,242,178.765 — all to Class A
    // (10% hurdle needs $21.1M); B units zero today
    expect(r.l2!.pool).toBeCloseTo(5242178.765, 1)
    expect(r.l2!.classAValue).toBeCloseTo(5242178.765, 0)
    expect(r.l2!.classBValue).toBeCloseTo(0, 0)
  })
})

const KM_L1_TIERS = [
  tier(1, 'promote_split', { hurdle: 0.12, lp: 0.9, gp: 0.1 }),
  tier(2, 'promote_split', { hurdle: 0.15, lp: 0.7, gp: 0.3 }),
  tier(3, 'promote_split', { lp: 0.6, gp: 0.4 }),
]
const KM_L2_TIERS = [
  tier(1, 'return_of_capital'),
  tier(2, 'promote_split', { hurdle: 0.12, em: 1.75, lp: 1.0, gp: 0.0 }),
  tier(3, 'promote_split', { hurdle: 0.15, em: 2.2, lp: 0.7, gp: 0.3 }),
  tier(4, 'promote_split', { lp: 0.5, gp: 0.5 }),
]

describe('computeSellToday — Knightdale ($87M, freeze + $73M override)', () => {
  const input = {
    asOfDate: '2026-02-27',
    grossValue: 87000000,
    closingCostPct: 0.02,
    netCurrentAssets: 0,
    payoff: 34000000,
    l1: {
      positions: [
        { investorId: 'bbk', type: 'lp' as const, flows: KM_L1_LP },
        { investorId: 'mjw', type: 'gp' as const, flows: [] },
      ],
      tiers: KM_L1_TIERS,
      freezeDate: '2025-06-30',
      saleOverride: { threshold: 73000000, lpShare: 0.75, gpShare: 0.25 },
      cashSplit: { lpShare: 0.9, gpShare: 0.1 },
    },
  }

  it('carves out the >$73M excess at 75/25 and runs the ladder on the rest', () => {
    const r = computeSellToday(input)
    expect(r.priceNetOfCosts).toBeCloseTo(85260000, 2)
    expect(r.overrideExcess).toBeCloseTo(12260000, 2)
    expect(r.overrideLp).toBeCloseTo(9195000, 2)
    expect(r.overrideGp).toBeCloseTo(3065000, 2)
    expect(r.ladderPool).toBeCloseTo(39000000, 2)
    // Everything distributed
    expect(r.l1LpTotal + r.l1GpTotal).toBeCloseTo(51260000, 1)
    // Workbook totals were goal-seeked (its own XIRR check shows 11.9994%/14.9968%);
    // the engine is exact, so allow the workbook's ~$1.1k slop.
    expect(r.l1GpTotal).toBeCloseTo(9648134.04, -4)
    expect(r.l1LpTotal).toBeCloseTo(41611865.96, -4)
  })

  it('freeze pins tier hurdles at 6/30/25: tier-1 LP equals the exact Twelve Percent Amount', () => {
    const r = computeSellToday(input)
    // Engine-exact value validated in PS: 24,683,224.07 (workbook's goal-seek: 24,682,244.33)
    expect(r.l1.tierResults[0].lp).toBeCloseTo(24683224.07, 0)
    expect(r.l1.tierResults[0].reachedHurdle).toBe(true)
    // BBK's pro-forma XIRR (all legs, deemed 6/30/25) clears both hurdles
    expect(r.l1LpIrr!).toBeGreaterThan(0.15)
  })

  it('L2 lesser-of: EM caps govern both Class A preferences (doc-correct, differs from workbook)', () => {
    // Feed the workbook's own L2 pool so the class math is comparable.
    const r = computeIrrWaterfall({
      cashAvailable: 9848134.04357092,
      distributionDate: '2026-07-31',
      positions: [
        { investorId: 'class_a', type: 'lp', flows: KM_L2_A },
        { investorId: 'class_b', type: 'gp', flows: KM_L2_B },
      ],
      tiers: KM_L2_TIERS,
    })
    // Prior dists $1,399,580 on $2.8M: ROC pays 1,400,420, then 1.75x EM needs only
    // 2,100,000 more (< the 12% IRR leg) — EM governs.
    expect(r.tierResults.find(t => t.tierOrder === 2)!.lp).toBeCloseTo(2100000, 0)
    expect(r.tierResults.find(t => t.tierOrder === 2)!.emGoverned).toBe(true)
    // Second preference: 2.2x EM needs 1,260,000 (< 15% IRR leg) — EM governs; 70/30
    expect(r.tierResults.find(t => t.tierOrder === 3)!.lp).toBeCloseTo(1260000, 0)
    expect(r.tierResults.find(t => t.tierOrder === 3)!.gp).toBeCloseTo(540000, 0)
    // Residual 50/50; totals reconcile
    expect(r.lpTake).toBeCloseTo(7034277.02, 0)
    expect(r.gpTake).toBeCloseTo(2813857.02, 0)
    expect(r.lpTake + r.gpTake).toBeCloseTo(9848134.04, 1)
    // EM identities: prior dists + ROC + tier-2 land exactly on 1.75x ($4.9M);
    // + tier-3 lands exactly on 2.2x ($6.16M). (A then shares the residual 50/50,
    // so its final multiple exceeds 2.2x.)
    const roc = r.lineItems.filter(li => li.tierType === 'return_of_capital')
      .reduce((s, li) => s + li.amount, 0)
    expect(roc).toBeCloseTo(1400420, 2)
    expect(1399580 + roc + 2100000).toBeCloseTo(4900000, 0)
    expect(1399580 + roc + 2100000 + 1260000).toBeCloseTo(6160000, 0)
    expect(r.lpEmAfter!).toBeCloseTo((1399580 + 7034277.02) / 2800000, 4)
  })
})
