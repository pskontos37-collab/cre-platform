import { describe, it, expect } from 'vitest'
import { parseMoneyRange, parsePct, matchPartner, rankPartners, type MatchPartner, type MatchDeal } from '../partnerMatch'

describe('partnerMatch parsers', () => {
  it('parses the first $ range from free text (defaults unit to millions)', () => {
    expect(parseMoneyRange('$20-100M ($7-20M eq)')).toEqual([20e6, 100e6])
    expect(parseMoneyRange('$50M')).toEqual([50e6, 50e6])
    expect(parseMoneyRange('unpriced')).toBeNull()
    expect(parseMoneyRange(null)).toBeNull()
  })
  it('parses the first percentage into a decimal', () => {
    expect(parsePct('17%+')).toBeCloseTo(0.17, 5)
    expect(parsePct('Core 7-9%')).toBeCloseTo(0.09, 5)
    expect(parsePct('n/a')).toBeNull()
  })
})

const deal: MatchDeal = { assetType: 'retail', state: 'NC', market: null, submarket: null, askPrice: 50e6, projIrr: 0.15 }
const P = (o: Partial<MatchPartner>): MatchPartner => ({
  id: o.id ?? 'p', name: o.name ?? 'P', tier: o.tier ?? 'current',
  productTypes: o.productTypes ?? [], markets: o.markets ?? null, returnTarget: o.returnTarget ?? null,
  dealSize: o.dealSize ?? null, active: o.active ?? true,
})
const A = P({ id: 'A', name: 'A', tier: 'current', productTypes: ['retail'], dealSize: '$20-100M', returnTarget: '13%+', markets: 'Southeast, NC, SC' })
const B = P({ id: 'B', name: 'B', tier: 'tier2_prospect', productTypes: ['office'], dealSize: '$100-300M', returnTarget: '18%+', markets: 'Gateway CBD' })
const C = P({ id: 'C', name: 'C', tier: 'tier1_prospect' })   // agnostic mandate

describe('partnerMatch scoring', () => {
  it('scores a strong current-partner fit high', () => {
    expect(matchPartner(deal, A).score).toBeCloseTo(5.5, 5)   // +2 product +1 size +1 return +1 geo +0.5 tier
  })
  it('penalizes a wrong-product / wrong-size / low-return partner', () => {
    expect(matchPartner(deal, B).score).toBeCloseTo(-4.5, 5)  // -3 product -1 size -0.5 return +0 tier
  })
  it('gives an agnostic mandate a small neutral (tier-only) score', () => {
    expect(matchPartner(deal, C).score).toBeCloseTo(0.25, 5)
  })
  it('ranks strong fit first, agnostic middle, poor fit last', () => {
    const ranked = rankPartners(deal, [B, C, A], new Set()).map(m => m.partner.id)
    expect(ranked).toEqual(['A', 'C', 'B'])
  })
  it('excludes partners already on the deal', () => {
    const ranked = rankPartners(deal, [A, C], new Set(['A'])).map(m => m.partner.id)
    expect(ranked).toEqual(['C'])
  })
})
