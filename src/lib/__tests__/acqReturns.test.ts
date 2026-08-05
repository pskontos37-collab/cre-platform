// @vitest-environment node
//
// acqReturns.test.ts — independent verification of the acquisition returns core
// (acqUnderwriting.ts). EVERY expected value below is hand-derived from the
// stated financial conventions (closed-form annuity/IRR arithmetic, shown in
// the comments) — never by running the code under test. The par-bond cases are
// chosen so the true IRR is an exact round number, making solver drift visible.

import { describe, it, expect } from 'vitest'
import { underwrite, computeReturns } from '../acqUnderwriting'

describe('underwrite — all-cash direct-cap model', () => {
  // price 10,000,000 · acq costs 2% → basis 10,200,000 · NOI 700,000 flat ·
  // exit cap 7% → exit value 10,000,000 · selling costs 2% → net 9,800,000.
  const base = {
    purchasePrice: 10_000_000, acqCostsPct: 0.02, inPlaceNoi: 700_000,
    noiGrowthPct: 0, exitCapPct: 0.07, sellingCostsPct: 0.02,
    closeDate: '2026-01-01',
  }

  it('1-year hold: IRR is the exact one-period return 10.5/10.2 − 1', () => {
    const r = underwrite({ ...base, holdYears: 1 })
    // single flow pair: −10,200,000 at close; +(700,000 + 9,800,000) one exact
    // Actual/365 year later ⇒ IRR = 10,500,000/10,200,000 − 1 = 0.0294117647…
    expect(r.totalBasis).toBeCloseTo(10_200_000, 2)
    expect(r.exitValue).toBeCloseTo(10_000_000, 2)
    expect(r.netSaleProceeds).toBeCloseTo(9_800_000, 2)
    expect(r.unleveredIrr).not.toBeNull()
    expect(r.unleveredIrr as number).toBeCloseTo(10.5 / 10.2 - 1, 6)
    // all-cash ⇒ levered economics are identical to unlevered
    expect(r.leveredIrr as number).toBeCloseTo(r.unleveredIrr as number, 8)
  })

  it('5-year hold: closed-form multiple, cash-on-cash, profit, spreads', () => {
    const r = underwrite({ ...base, holdYears: 5 })
    // returned = 700,000×5 + 9,800,000 = 13,300,000 ; invested = 10,200,000
    expect(r.equityMultiple).toBeCloseTo(13_300_000 / 10_200_000, 10)
    expect(r.profit).toBeCloseTo(3_100_000, 2)
    // avg CoC = (3,500,000/5)/10,200,000
    expect(r.avgCashOnCash).toBeCloseTo(700_000 / 10_200_000, 10)
    expect(r.goingInCapPct).toBeCloseTo(0.07, 12)
    expect(r.stabilizedYieldOnCostPct).toBeCloseTo(700_000 / 10_200_000, 10)
    expect(r.valueAddSpreadPct).toBeCloseTo(700_000 / 10_200_000 - 0.07, 10)
    // no debt ⇒ DSCR/debt-yield undefined every year
    expect(r.dscrByYear).toEqual([null, null, null, null, null])
    expect(r.debtYieldByYear).toEqual([null, null, null, null, null])
  })

  it('default 3% growth compounds the NOI stream and the forward exit NOI', () => {
    const r = underwrite({ purchasePrice: 10_000_000, inPlaceNoi: 700_000, holdYears: 3, exitCapPct: 0.07, closeDate: '2026-01-01' })
    expect(r.yearlyNoi[0]).toBeCloseTo(700_000, 6)
    expect(r.yearlyNoi[1]).toBeCloseTo(721_000, 6)          // ×1.03
    expect(r.yearlyNoi[2]).toBeCloseTo(742_630, 6)          // ×1.03²
    expect(r.exitYearNoi).toBeCloseTo(700_000 * 1.03 ** 3, 6) // 764,908.90 forward
  })

  it('zero exit cap degrades to zero exit value without dividing by zero', () => {
    const r = underwrite({ ...base, holdYears: 2, exitCapPct: 0 })
    expect(r.exitValue).toBe(0)
    expect(Number.isFinite(r.equityMultiple)).toBe(true)
  })
})

describe('computeReturns — levered, interest-only (par-bond construction)', () => {
  // Loan 6,000,000 at 5% IO ⇒ DS 300,000. Equity 4,000,000 earns 400,000/yr and
  // returns 4,000,000 principal at exit — a par bond with a 10% coupon, so the
  // levered IRR is EXACTLY 10%; the unlevered side is a 7% par bond on 10,000,000.
  const inp = {
    noiByYear: [700_000, 700_000, 700_000], capitalByYear: [0, 0, 0], exitYearNoi: 700_000,
    purchasePrice: 10_000_000, acqCostsPct: 0, capexUpfront: 0,
    exitCapPct: 0.07, sellingCostsPct: 0,
    ltvPct: 0.6, loanRatePct: 0.05, amortYears: 30, ioYears: 3,
    closeDate: '2026-01-01',
  }

  it('sizes the debt stack and cash flows exactly', () => {
    const r = computeReturns(inp)
    expect(r.loanAmount).toBe(6_000_000)
    expect(r.equity).toBe(4_000_000)
    expect(r.yearlyDebtService).toEqual([300_000, 300_000, 300_000])
    expect(r.yearlyOperatingCf).toEqual([400_000, 400_000, 400_000])
    expect(r.loanPayoff).toBe(6_000_000)          // IO through hold — no amortization
    expect(r.netSaleProceeds).toBeCloseTo(4_000_000, 6)
  })

  it('hits the exact par-bond IRRs on both sides of the stack', () => {
    const r = computeReturns(inp)
    expect(r.leveredIrr as number).toBeCloseTo(0.10, 4)
    expect(r.unleveredIrr as number).toBeCloseTo(0.07, 4)
    expect(r.equityMultiple).toBeCloseTo(5_200_000 / 4_000_000, 10)  // 1.3×
    expect(r.profit).toBeCloseTo(1_200_000, 4)
  })

  it('reports coverage: DSCR 7/3 and debt yield 7/60 every year', () => {
    const r = computeReturns(inp)
    for (const d of r.dscrByYear) expect(d as number).toBeCloseTo(700 / 300, 10)
    for (const y of r.debtYieldByYear) expect(y as number).toBeCloseTo(0.7 / 6, 10)
    expect(r.yearOneDscr as number).toBeCloseTo(2.333333333, 6)
    expect(r.yearOneDebtYield as number).toBeCloseTo(0.116666667, 6)
  })
})

describe('computeReturns — amortizing loan', () => {
  // Standard annuity, hand-derived: pmt = L·r/(1−(1+r)^−n)
  //   1.05^30 = 4.32194238 ⇒ pmt = 50,000/0.76862255 = 65,051.435
  //   bal₁ = 1,050,000 − 65,051.435 = 984,948.565
  //   bal₂ = 984,948.565×1.05 − 65,051.435 = 969,144.558
  it('annuity payment and ending balances match the closed form', () => {
    const r = computeReturns({
      noiByYear: [130_000, 130_000], capitalByYear: [0, 0], exitYearNoi: 130_000,
      purchasePrice: 2_000_000, acqCostsPct: 0, capexUpfront: 0,
      exitCapPct: 0.065, sellingCostsPct: 0,
      ltvPct: 0.5, loanRatePct: 0.05, amortYears: 30, ioYears: 0,
      closeDate: '2026-01-01',
    })
    expect(r.loanAmount).toBe(1_000_000)
    expect(r.yearlyDebtService[0]).toBeCloseTo(65_051.435, 2)
    expect(r.yearlyDebtService[1]).toBeCloseTo(65_051.435, 2)
    expect(r.loanPayoff).toBeCloseTo(969_144.56, 1)
  })

  it('zero-rate amortization degrades to straight-line principal', () => {
    const r = computeReturns({
      noiByYear: [100_000], capitalByYear: [0], exitYearNoi: 100_000,
      purchasePrice: 1_000_000, acqCostsPct: 0, capexUpfront: 0,
      exitCapPct: 0.10, sellingCostsPct: 0,
      ltvPct: 0.5, loanRatePct: 0, amortYears: 10, ioYears: 0,
      closeDate: '2026-01-01',
    })
    expect(r.yearlyDebtService[0]).toBeCloseTo(50_000, 6)   // 500,000/10
    expect(r.loanPayoff).toBeCloseTo(450_000, 6)
  })
})

describe('computeReturns — mid-hold refinance', () => {
  // Going-in: 5,000,000 at 5% IO (DS 250,000). Refi at end of year 2 against
  // forward NOI 700,000 valued at a 7 cap: new loan = 10,000,000×0.6 = 6,000,000
  // at 6% IO (DS 360,000). Cash-out = 6,000,000 − 5,000,000 − 1% costs = 940,000.
  const inp = {
    noiByYear: [700_000, 700_000, 700_000, 700_000], capitalByYear: [0, 0, 0, 0], exitYearNoi: 700_000,
    purchasePrice: 10_000_000, acqCostsPct: 0, capexUpfront: 0,
    exitCapPct: 0.07, sellingCostsPct: 0,
    ltvPct: 0.5, loanRatePct: 0.05, amortYears: 30, ioYears: 4,
    refi: { yearsFromClose: 2, ltvPct: 0.6, ratePct: 0.06, amortYears: 30, ioYears: 2, costPct: 0.01, capPct: 0.07 },
    closeDate: '2026-01-01',
  }

  it('switches debt service at the refi and pays off the NEW loan at exit', () => {
    const r = computeReturns(inp)
    // L1 = (700,000/0.07)×0.6 carries an IEEE-754 division artifact (…99994),
    // so the refi-loan figures are asserted to the cent, not bit-exact.
    expect(r.yearlyDebtService[0]).toBe(250_000)
    expect(r.yearlyDebtService[1]).toBe(250_000)
    expect(r.yearlyDebtService[2]).toBeCloseTo(360_000, 6)
    expect(r.yearlyDebtService[3]).toBeCloseTo(360_000, 6)
    expect(r.loanPayoff).toBeCloseTo(6_000_000, 6)
    expect(r.netSaleProceeds).toBeCloseTo(4_000_000, 6)
  })

  it('distributes the cash-out in the refi year’s levered flow', () => {
    const r = computeReturns(inp)
    // year-2 levered flow = operating CF 450,000 + cash-out 940,000
    expect(r.leveredFlows[2].amount).toBeCloseTo(450_000 + 940_000, 4)
    // final flow = operating CF 340,000 + net sale 4,000,000
    expect(r.leveredFlows[4].amount).toBeCloseTo(4_340_000, 4)
    expect(r.equity).toBe(5_000_000)
  })
})
