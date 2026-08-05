// @vitest-environment node
//
// distributionLedger.test.ts — the /investors ledger + quarterly report math.
// IRR expectations are solved by hand from the quadratic in the comments (the
// dates deliberately avoid leap boundaries so Actual/365 year fractions are
// exact integers), never by running the code under test.

import { describe, it, expect } from 'vitest'
import { buildPartyLedgers, quarterRef, recentCompleteQuarters, quarterlyNet, distributedInWindow } from '../distributionLedger'
import type { DealRow, CapitalFlowRow } from '../../hooks/useDeals'

const flow = (party: string, role: CapitalFlowRow['role'], flow_date: string, amount: number): CapitalFlowRow =>
  ({ id: `${party}-${flow_date}`, deal_id: 'd1', party, role, flow_date, amount, source: null })

const dealWith = (flows: CapitalFlowRow[]): DealRow => ({ capital_flows: flows } as unknown as DealRow)

describe('buildPartyLedgers', () => {
  // LP: −1,000,000 on 2025-01-01, +300,000 on 2026-01-01, +900,000 on 2027-01-01.
  // Neither interval crosses Feb-29, so Actual/365 times are exactly 1 and 2 years.
  // IRR solves −1,000,000 + 300,000v + 900,000v² = 0  ⇒  9v² + 3v − 10 = 0
  //   v = (−3 + √369)/18 = 0.90052071  ⇒  r = 1/v − 1 = 0.1104701
  const lpFlows = [
    flow('MetLife', 'lp', '2026-01-01', 300_000),   // deliberately out of order
    flow('MetLife', 'lp', '2025-01-01', -1_000_000),
    flow('MetLife', 'lp', '2027-01-01', 900_000),
  ]
  const gpFlows = [flow('MJW', 'gp', '2025-01-01', -500_000)]

  it('totals, DPI and the hand-solved IRR', () => {
    const [lp] = buildPartyLedgers(dealWith(lpFlows))
    expect(lp.contributed).toBe(1_000_000)
    expect(lp.distributed).toBe(1_200_000)
    expect(lp.dpi).toBeCloseTo(1.2, 12)
    expect(lp.lastDistribution).toBe('2027-01-01')
    expect(lp.irr).not.toBeNull()
    expect(lp.irr as number).toBeCloseTo(0.1104701, 4)
  })

  it('sorts flows ascending even when input arrives shuffled', () => {
    const [lp] = buildPartyLedgers(dealWith(lpFlows))
    expect(lp.flows.map(f => f.flow_date)).toEqual(['2025-01-01', '2026-01-01', '2027-01-01'])
  })

  it('a contribution-only party has no realized IRR and no last distribution', () => {
    const ledgers = buildPartyLedgers(dealWith([...lpFlows, ...gpFlows]))
    // largest contributor first
    expect(ledgers.map(l => l.party)).toEqual(['MetLife', 'MJW'])
    const gp = ledgers[1]
    expect(gp.contributed).toBe(500_000)
    expect(gp.distributed).toBe(0)
    expect(gp.dpi).toBe(0)
    expect(gp.irr).toBeNull()
    expect(gp.lastDistribution).toBeNull()
  })

  it('keys parties by party AND role (same name, two roles = two ledgers)', () => {
    const ledgers = buildPartyLedgers(dealWith([
      flow('MJW', 'gp', '2025-01-01', -100_000),
      flow('MJW', 'class_d', '2025-01-01', -200_000),
    ]))
    expect(ledgers).toHaveLength(2)
    expect(ledgers[0].contributed).toBe(200_000)  // class_d sorts first (larger)
  })
})

describe('quarterRef', () => {
  it('produces correct calendar bounds for all four quarters', () => {
    expect(quarterRef(2026, 1)).toMatchObject({ key: '2026-Q1', start: '2026-01-01', end: '2026-03-31', months: [1, 2, 3] })
    expect(quarterRef(2026, 2)).toMatchObject({ start: '2026-04-01', end: '2026-06-30' })
    expect(quarterRef(2026, 3)).toMatchObject({ start: '2026-07-01', end: '2026-09-30' })
    expect(quarterRef(2026, 4)).toMatchObject({ key: '2026-Q4', start: '2026-10-01', end: '2026-12-31', label: 'Q4 2026' })
  })
})

describe('recentCompleteQuarters', () => {
  it('mid-Q3 2026: the most recent COMPLETE quarter is Q2 2026', () => {
    const qs = recentCompleteQuarters(4, new Date(2026, 7, 4))   // 2026-08-04
    expect(qs.map(q => q.key)).toEqual(['2026-Q2', '2026-Q1', '2025-Q4', '2025-Q3'])
  })

  it('January rolls back across the year boundary to Q4', () => {
    const qs = recentCompleteQuarters(4, new Date(2026, 0, 15))
    expect(qs.map(q => q.key)).toEqual(['2025-Q4', '2025-Q3', '2025-Q2', '2025-Q1'])
  })
})

describe('quarterlyNet', () => {
  it('nets flows into calendar quarters over a continuous window ending now', () => {
    const flows = [
      flow('X', 'lp', '2026-01-15', 100),
      flow('X', 'lp', '2026-02-10', -40),
      flow('X', 'lp', '2026-05-05', 10),
    ]
    const out = quarterlyNet(flows, 3, new Date(2026, 7, 4))     // window Q1..Q3 2026
    expect(out.map(o => o.ref.key)).toEqual(['2026-Q1', '2026-Q2', '2026-Q3'])
    expect(out.map(o => o.net)).toEqual([60, 10, 0])
    expect(out.map(o => o.hasFlows)).toEqual([true, true, false])
  })
})

describe('distributedInWindow', () => {
  const flows = [
    flow('X', 'lp', '2026-03-31', 50),    // inclusive lower/upper bounds matter
    flow('X', 'lp', '2026-04-01', 70),
    flow('X', 'lp', '2026-05-01', -30),   // contribution — never counted
    flow('X', 'lp', '2026-06-30', 80),
    flow('X', 'lp', '2026-07-01', 90),
  ]
  it('sums positive flows inside the inclusive window only', () => {
    expect(distributedInWindow(flows, '2026-04-01', '2026-06-30')).toBe(150)
  })
  it('window edges are inclusive on both sides', () => {
    expect(distributedInWindow(flows, '2026-03-31', '2026-07-01')).toBe(290)
  })
})
