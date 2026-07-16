import { describe, it, expect } from 'vitest'
import { scoreDealFit, bestFit, fitCategory, type BuyBox, type FitDeal } from '../buyBox'

const BB: BuyBox = {
  id: 'bb1', name: 'Value-Add Retail — Sunbelt',
  assetTypes: ['retail'], riskProfiles: ['value_add', 'core_plus'],
  states: ['NC', 'SC', 'GA', 'FL', 'TX'], markets: [],
  minPrice: 20e6, maxPrice: 80e6, minGla: null, maxGla: null,
  minGoingInCap: 0.06, maxGoingInCap: null, minIrr: 0.13, minEquityMultiple: null,
  active: true, notes: null,
}
const deal = (o: Partial<FitDeal>): FitDeal => ({
  assetType: 'retail', riskProfile: 'value_add', state: 'NC', market: null,
  glaSf: null, askPrice: 50e6, goingInCap: 0.07, projIrr: 0.15, equityMultiple: null, ...o,
})

describe('buyBox.scoreDealFit', () => {
  it('scores a clean match on-strategy (all applicable criteria pass)', () => {
    const f = scoreDealFit(deal({}), BB)
    expect(f.disqualified).toBe(false)
    expect(f.passed).toBe(f.applicable)
    expect(f.score).toBe(1)
    expect(fitCategory({ bb: BB, fit: f })).toBe('on')
  })
  it('disqualifies on a hard (asset type) miss regardless of soft score', () => {
    const f = scoreDealFit(deal({ assetType: 'office' }), BB)
    expect(f.disqualified).toBe(true)
    expect(fitCategory({ bb: BB, fit: f })).toBe('off')
  })
  it('disqualifies on a hard geography miss', () => {
    const f = scoreDealFit(deal({ state: 'CA' }), BB)
    expect(f.disqualified).toBe(true)
    expect(fitCategory({ bb: BB, fit: f })).toBe('off')
  })
  it('degrades to partial on soft misses (weak cap + IRR)', () => {
    const f = scoreDealFit(deal({ goingInCap: 0.04, projIrr: 0.10 }), BB)
    expect(f.disqualified).toBe(false)
    expect(f.score).toBeCloseTo(4 / 6, 5)   // asset/risk/geo/size pass; cap+IRR fail
    expect(fitCategory({ bb: BB, fit: f })).toBe('partial')
  })
  it('excludes unknown deal values from the denominator (sparse data still on)', () => {
    const f = scoreDealFit(deal({ askPrice: null, goingInCap: null, projIrr: null }), BB)
    expect(f.applicable).toBe(3)   // only asset/risk/geo known
    expect(f.score).toBe(1)
    expect(fitCategory({ bb: BB, fit: f })).toBe('on')
  })
})

describe('buyBox.bestFit', () => {
  it('returns null when no active buy-box exists', () => {
    expect(bestFit(deal({}), [{ ...BB, active: false }])).toBeNull()
  })
  it('prefers a non-disqualified box over a disqualified one', () => {
    const officeBox: BuyBox = { ...BB, id: 'bb2', name: 'Office', assetTypes: ['office'] }
    const best = bestFit(deal({}), [officeBox, BB])   // retail deal
    expect(best?.bb.id).toBe('bb1')
    expect(best?.fit.disqualified).toBe(false)
  })
})
