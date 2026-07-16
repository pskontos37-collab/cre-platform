import { describe, it, expect } from 'vitest'
import { computeWaterfall, accruePreferredReturn } from '../waterfall'
import type { CapitalPosition, PrefEquityPosition, WaterfallInput } from '../waterfall'
import type { WaterfallTier } from '../../types/database'

// ── Fixtures ───────────────────────────────────────────────────────────────

const LP: CapitalPosition = {
  investorId: 'lp-1',
  type: 'lp',
  initialContribution: 900_000,
  contributedToDate: 900_000,
  distributedToDate: 0,
  prefAccruedToDate: 0,
}

const GP: CapitalPosition = {
  investorId: 'gp-1',
  type: 'gp',
  initialContribution: 100_000,
  contributedToDate: 100_000,
  distributedToDate: 0,
  prefAccruedToDate: 0,
}

const TIERS: WaterfallTier[] = [
  {
    id: 't1', deal_id: 'd1', tier_order: 1,
    tier_type: 'return_of_capital',
    description: 'Return LP capital',
    hurdle_irr: null, pref_rate: null,
    lp_split_pct: 1.0, gp_split_pct: 0,
    is_cumulative: true, is_pik: false, created_at: '',
  },
  {
    id: 't2', deal_id: 'd1', tier_order: 2,
    tier_type: 'preferred_return',
    description: '8% LP pref',
    hurdle_irr: null, pref_rate: 0.08,
    lp_split_pct: 1.0, gp_split_pct: 0,
    is_cumulative: true, is_pik: false, created_at: '',
  },
  {
    id: 't3', deal_id: 'd1', tier_order: 3,
    tier_type: 'promote_split',
    description: '80/20 promote',
    hurdle_irr: 0.15, pref_rate: null,
    lp_split_pct: 0.80, gp_split_pct: 0.20,
    is_cumulative: true, is_pik: false, created_at: '',
  },
]

const baseInput = (cashAvailable: number): WaterfallInput => ({
  cashAvailable,
  positions: [{ ...LP }, { ...GP }],
  preferredEquityPositions: [],
  tiers: TIERS,
  periodYears: 1,
})

// ── accruePreferredReturn ──────────────────────────────────────────────────

describe('accruePreferredReturn', () => {
  it('computes cumulative pref on unreturned capital', () => {
    expect(accruePreferredReturn(LP, 0.08, 1, true)).toBeCloseTo(72_000)
  })

  it('returns 0 when capital is fully returned (cumulative)', () => {
    const fullyReturned: CapitalPosition = { ...LP, distributedToDate: 900_000 }
    expect(accruePreferredReturn(fullyReturned, 0.08, 1, true)).toBe(0)
  })

  it('non-cumulative pref uses initial contribution even after partial return', () => {
    const partial: CapitalPosition = { ...LP, distributedToDate: 400_000 }
    expect(accruePreferredReturn(partial, 0.08, 1, false)).toBeCloseTo(72_000)
  })

  it('scales correctly for a quarterly period', () => {
    expect(accruePreferredReturn(LP, 0.08, 0.25, true)).toBeCloseTo(18_000)
  })
})

// ── Return of Capital ──────────────────────────────────────────────────────

describe('computeWaterfall — return of capital', () => {
  it('pays LP ROC in full when cash equals contribution', () => {
    const result = computeWaterfall(baseInput(900_000))
    const roc = result.lineItems.filter(li => li.tierType === 'return_of_capital')
    expect(roc.length).toBe(1)
    expect(roc[0].amount).toBeCloseTo(900_000)
    expect(result.residualCash).toBeCloseTo(0)
  })

  it('does not overpay ROC when excess cash is available', () => {
    const result = computeWaterfall(baseInput(2_000_000))
    const totalRoc = result.lineItems
      .filter(li => li.tierType === 'return_of_capital')
      .reduce((s, li) => s + li.amount, 0)
    expect(totalRoc).toBeCloseTo(900_000)
  })

  it('pays partial ROC when cash is insufficient', () => {
    const result = computeWaterfall(baseInput(400_000))
    const totalRoc = result.lineItems
      .filter(li => li.tierType === 'return_of_capital')
      .reduce((s, li) => s + li.amount, 0)
    expect(totalRoc).toBeCloseTo(400_000)
    expect(result.residualCash).toBeCloseTo(0)
  })
})

// ── Preferred Return ───────────────────────────────────────────────────────

describe('computeWaterfall — preferred return', () => {
  // Ordering matters: ROC (tier 1) runs before the pref tier (tier 2) and pays
  // down distributedToDate. A CUMULATIVE pref accrues on unreturned capital
  // (initialContribution - distributedToDate), so once ROC fully returns capital
  // in the same event there is nothing left to accrue on and pref is 0. A
  // NON-CUMULATIVE pref accrues on the initial contribution regardless.
  it('pays no cumulative pref once ROC has fully returned capital this event', () => {
    // 900k ROC returns all LP capital, so the cumulative pref base is 0; the
    // 100k remainder flows past the pref tier to the promote split.
    const result = computeWaterfall(baseInput(1_000_000))
    const totalPref = result.lineItems
      .filter(li => li.tierType === 'preferred_return')
      .reduce((s, li) => s + li.amount, 0)
    expect(totalPref).toBeCloseTo(0)
  })

  it('pays 8% pref on the initial contribution when the pref tier is non-cumulative', () => {
    // Non-cumulative pref ignores the ROC already paid: 900k initial * 8% = 72k.
    const nonCumulativeTiers = TIERS.map(t =>
      t.tier_type === 'preferred_return' ? { ...t, is_cumulative: false } : t,
    )
    const result = computeWaterfall({ ...baseInput(1_000_000), tiers: nonCumulativeTiers })
    const totalPref = result.lineItems
      .filter(li => li.tierType === 'preferred_return')
      .reduce((s, li) => s + li.amount, 0)
    expect(totalPref).toBeCloseTo(72_000)
  })

  it('does not pay pref when cash only covers ROC', () => {
    const result = computeWaterfall(baseInput(900_000))
    expect(result.lineItems.filter(li => li.tierType === 'preferred_return')).toHaveLength(0)
  })
})

// ── Promote Split ──────────────────────────────────────────────────────────

describe('computeWaterfall — promote split', () => {
  it('splits the post-ROC remainder 80/20', () => {
    // 900k ROC returns all LP capital (cumulative pref base -> 0), leaving 100k
    // of the 1_000_000 to split 80/20 between LP and GP.
    const result = computeWaterfall(baseInput(1_000_000))
    const split = result.lineItems.filter(li => li.tierType === 'promote_split')
    const lpSplit = split.find(li => li.investorType === 'lp')
    const gpSplit = split.find(li => li.investorType === 'gp')
    expect(lpSplit?.amount).toBeCloseTo(80_000)
    expect(gpSplit?.amount).toBeCloseTo(20_000)
  })

  it('GP receives nothing when cash only covers ROC', () => {
    const result = computeWaterfall(baseInput(900_000))
    expect(result.lineItems.filter(li => li.investorType === 'gp')).toHaveLength(0)
  })
})

// ── Preferred Equity ───────────────────────────────────────────────────────

describe('computeWaterfall — preferred equity', () => {
  const pref: PrefEquityPosition = {
    investorId: 'pref-1',
    principal: 200_000,
    preferredRate: 0.10,
    isPik: false,
    accruedReturn: 0,
    isRedeemed: false,
  }

  it('pays pref equity return before LP waterfall', () => {
    const result = computeWaterfall({
      ...baseInput(250_000),
      preferredEquityPositions: [{ ...pref }],
    })
    const prefReturn = result.lineItems.find(li => li.tierType === 'preferred_equity_return')
    expect(prefReturn).toBeDefined()
    expect(prefReturn!.amount).toBeCloseTo(20_000) // 200k × 10%
  })

  it('redeems principal when return is current and cash covers it', () => {
    const result = computeWaterfall({
      ...baseInput(1_500_000),
      preferredEquityPositions: [{ ...pref }],
    })
    const redemption = result.lineItems.find(li => li.tierType === 'preferred_equity_redemption')
    expect(redemption).toBeDefined()
    expect(redemption!.amount).toBeCloseTo(200_000)
    expect(result.updatedPrefEquityPositions[0].isRedeemed).toBe(true)
  })

  it('skips already-redeemed positions', () => {
    const result = computeWaterfall({
      ...baseInput(1_000_000),
      preferredEquityPositions: [{ ...pref, isRedeemed: true }],
    })
    expect(result.lineItems.filter(li => li.investorType === 'preferred_equity')).toHaveLength(0)
  })

  it('accrues PIK return without paying cash', () => {
    const pikPref: PrefEquityPosition = { ...pref, isPik: true }
    const result = computeWaterfall({
      ...baseInput(1_000_000),
      preferredEquityPositions: [pikPref],
    })
    expect(result.lineItems.filter(li => li.tierType === 'preferred_equity_return')).toHaveLength(0)
    expect(result.updatedPrefEquityPositions[0].accruedReturn).toBeCloseTo(20_000)
  })
})

// ── Multiple LPs ───────────────────────────────────────────────────────────

describe('computeWaterfall — multiple LPs', () => {
  it('distributes ROC pro-rata by initial contribution', () => {
    const lp1: CapitalPosition = {
      investorId: 'lp-1', type: 'lp',
      initialContribution: 600_000, contributedToDate: 600_000,
      distributedToDate: 0, prefAccruedToDate: 0,
    }
    const lp2: CapitalPosition = {
      investorId: 'lp-2', type: 'lp',
      initialContribution: 400_000, contributedToDate: 400_000,
      distributedToDate: 0, prefAccruedToDate: 0,
    }
    const result = computeWaterfall({
      cashAvailable: 1_000_000,
      positions: [lp1, lp2, { ...GP }],
      preferredEquityPositions: [],
      tiers: TIERS,
      periodYears: 1,
    })
    const roc = result.lineItems.filter(li => li.tierType === 'return_of_capital')
    expect(roc.find(li => li.investorId === 'lp-1')?.amount).toBeCloseTo(600_000)
    expect(roc.find(li => li.investorId === 'lp-2')?.amount).toBeCloseTo(400_000)
  })
})

// ── Edge cases ─────────────────────────────────────────────────────────────

describe('computeWaterfall — edge cases', () => {
  it('returns empty result when no cash is available', () => {
    const result = computeWaterfall(baseInput(0))
    expect(result.lineItems).toHaveLength(0)
    expect(result.totalDistributed).toBe(0)
    expect(result.residualCash).toBe(0)
  })

  it('totalDistributed + residualCash equals cashAvailable', () => {
    const result = computeWaterfall(baseInput(750_000))
    expect(result.totalDistributed + result.residualCash).toBeCloseTo(750_000)
  })

  it('tracks updated position balances after distribution', () => {
    const result = computeWaterfall(baseInput(900_000))
    const updatedLp = result.updatedPositions.find(p => p.investorId === 'lp-1')
    expect(updatedLp?.distributedToDate).toBeCloseTo(900_000)
  })
})
