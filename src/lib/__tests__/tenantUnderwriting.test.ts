// @vitest-environment node
//
// tenantUnderwriting.test.ts — independent verification of the bottoms-up,
// lease-by-lease underwrite (ARGUS-lite). Every expected value is hand-derived
// in the comments from the documented conventions — recoveries by type (NNN /
// base-year / gross), admin fees, natural breakpoints, blended rollover, and
// month-resolved downtime — never by running the engine itself.

import { describe, it, expect } from 'vitest'
import { underwriteTenant, type TenantModelAssumptions } from '../tenantUnderwriting'

// A zero-noise shell: no growth, no vacancy/credit, no reserves, all-cash.
const shell = (over: Partial<TenantModelAssumptions>): TenantModelAssumptions => ({
  glaSf: 10_000,
  purchasePrice: 2_500_000, acqCostsPct: 0, capexUpfront: 0,
  holdYears: 5, exitCapPct: 0.079, sellingCostsPct: 0,
  ltvPct: 0, loanRatePct: 0, amortYears: 0,
  closeDate: '2026-01-01',
  leases: [],
  rollover: {
    renewalProbPct: 1, marketRentPsf: 20, marketRentGrowthPct: 0,
    downtimeMonths: 0, tiNewPsf: 0, tiRenewPsf: 0, lcNewPsf: 0, lcRenewPsf: 0,
    freeRentMonthsNew: 0,
  },
  opex: {
    recoverableOpexPsf: 0, nonRecoverableOpexPsf: 0, opexGrowthPct: 0,
    generalVacancyPct: 0, creditLossPct: 0, capitalReservePsf: 0,
  },
  ...over,
})

describe('NNN recovery with admin fee and tax/insurance pass-through', () => {
  // 10,000 SF single tenant at $20 NNN. Controllable OpEx $5/SF carries a 15%
  // CAM admin fee; tax+insurance $2/SF passes through UN-marked-up; $1/SF is
  // non-recoverable. Hand math per year (no growth):
  //   base rent    = 20×10,000            = 200,000
  //   recoveries   = 10,000×(5×1.15 + 2)  =  77,500
  //   OpEx         = (5+2+1)×10,000       =  80,000
  //   NOI          = 277,500 − 80,000     = 197,500
  //   capital      = 0.10×10,000 reserve  =   1,000
  const m = shell({
    holdYears: 5,
    leases: [{ name: 'T', sf: 10_000, baseRentPsf: 20, annualBumpPct: 0, termRemainingYears: 10, recovery: 'nnn' }],
    opex: {
      recoverableOpexPsf: 5, taxInsurancePsf: 2, nonRecoverableOpexPsf: 1,
      opexGrowthPct: 0, generalVacancyPct: 0, creditLossPct: 0,
      capitalReservePsf: 0.10, adminFeePct: 0.15,
    },
  })

  it('reproduces the hand-computed year-1 stack', () => {
    const r = underwriteTenant(m)
    const y1 = r.breakdown[0]
    expect(y1.baseRent).toBeCloseTo(200_000, 6)
    expect(y1.recoveries).toBeCloseTo(77_500, 6)
    expect(y1.opex).toBeCloseTo(80_000, 6)
    expect(y1.noi).toBeCloseTo(197_500, 6)
    expect(y1.capital).toBeCloseTo(1_000, 6)
  })

  it('exit math: 197,500 forward NOI at a 7.9 cap is exactly the 2.5M price', () => {
    const r = underwriteTenant(m)
    expect(r.exitYearNoi).toBeCloseTo(197_500, 6)
    expect(r.exitValue).toBeCloseTo(2_500_000, 4)
    expect(r.goingInCapPct).toBeCloseTo(0.079, 10)
    // returned = (197,500−1,000)×5 + 2,500,000 = 3,482,500 on 2,500,000 in
    expect(r.equityMultiple).toBeCloseTo(3_482_500 / 2_500_000, 8)
  })

  it('monthly periodicity reproduces the annual result on a flat, no-rollover model', () => {
    // The engine documents this invariant; hold both code paths to it.
    const annual = underwriteTenant({ ...m, holdYears: 3 })
    const monthly = underwriteTenant({ ...m, holdYears: 3, periodicity: 'monthly' })
    for (let t = 0; t < 3; t++) {
      expect(monthly.yearlyNoi[t]).toBeCloseTo(annual.yearlyNoi[t], 4)
      expect(monthly.yearlyCapital[t]).toBeCloseTo(annual.yearlyCapital[t], 4)
    }
  })
})

describe('base-year expense stop', () => {
  // $30 gross-ish tenant with a base-year stop at year-1 recoverables ($6/SF),
  // OpEx growing 3%/yr. The stop means the LANDLORD keeps year-1 exposure and
  // the TENANT absorbs all growth above it — so NOI is IDENTICAL every year:
  //   yr1: 300,000 + 0        − 60,000  = 240,000
  //   yr2: 300,000 + 1,800    − 61,800  = 240,000   (6×1.03 = 6.18)
  //   yr3: 300,000 + 3,654    − 63,654  = 240,000   (6×1.03² = 6.3654)
  it('insulates NOI from controllable OpEx growth', () => {
    const r = underwriteTenant(shell({
      holdYears: 3, purchasePrice: 3_000_000, exitCapPct: 0.08,
      leases: [{ name: 'BY', sf: 10_000, baseRentPsf: 30, annualBumpPct: 0, termRemainingYears: 10, recovery: 'base_year' }],
      opex: {
        recoverableOpexPsf: 6, nonRecoverableOpexPsf: 0, opexGrowthPct: 0.03,
        generalVacancyPct: 0, creditLossPct: 0, capitalReservePsf: 0,
      },
    }))
    expect(r.breakdown[0].recoveries).toBeCloseTo(0, 6)
    expect(r.breakdown[1].recoveries).toBeCloseTo(1_800, 4)
    expect(r.breakdown[2].recoveries).toBeCloseTo(3_654, 4)
    for (const y of r.breakdown) expect(y.noi).toBeCloseTo(240_000, 4)
  })
})

describe('blended rollover at lease expiry (annual model)', () => {
  // 1,000 SF at $10, expiring after year 1. Market $15, renewal prob 70%,
  // 6 months downtime + 3 months free rent on a new deal, TI/LC 5+2 renew,
  // 20+10 new. Hand math:
  //   yr1: in place                          rent = 10,000, capital 0
  //   yr2: renew 15,000 | new 15,000×0.25 = 3,750
  //        blended rent = 0.7×15,000 + 0.3×3,750         = 11,625
  //        blended cap  = 0.7×7,000  + 0.3×30,000        = 13,900
  //   yr3: both sides at full market                     = 15,000, capital 0
  it('blends renew vs new economics and charges TI/LC only in the event year', () => {
    const r = underwriteTenant(shell({
      glaSf: 1_000, purchasePrice: 100_000, exitCapPct: 0.10, holdYears: 3,
      leases: [{ name: 'R', sf: 1_000, baseRentPsf: 10, annualBumpPct: 0, termRemainingYears: 1, recovery: 'nnn' }],
      rollover: {
        renewalProbPct: 0.7, marketRentPsf: 15, marketRentGrowthPct: 0,
        downtimeMonths: 6, tiNewPsf: 20, tiRenewPsf: 5, lcNewPsf: 10, lcRenewPsf: 2,
        freeRentMonthsNew: 3, releaseTermYears: 7,
      },
    }))
    expect(r.breakdown[0].baseRent).toBeCloseTo(10_000, 6)
    expect(r.breakdown[0].capital).toBeCloseTo(0, 6)
    expect(r.breakdown[1].baseRent).toBeCloseTo(11_625, 4)
    expect(r.breakdown[1].capital).toBeCloseTo(13_900, 4)
    expect(r.breakdown[2].baseRent).toBeCloseTo(15_000, 4)
    expect(r.breakdown[2].capital).toBeCloseTo(0, 6)
  })
})

describe('percentage rent', () => {
  const leaseBase = { name: 'P', sf: 2_000, baseRentPsf: 25, annualBumpPct: 0, termRemainingYears: 10, recovery: 'nnn' as const, salesPsf: 500, pctRentRate: 0.06 }

  it('natural breakpoint: overage above rent/rate', () => {
    // rent 50,000 ⇒ natural bp = 50,000/0.06 = 833,333.33; sales 1,000,000
    // ⇒ % rent = 0.06 × 166,666.67 = 10,000
    const r = underwriteTenant(shell({ glaSf: 2_000, purchasePrice: 500_000, exitCapPct: 0.10, holdYears: 2, leases: [leaseBase] }))
    expect(r.breakdown[0].pctRent).toBeCloseTo(10_000, 4)
  })

  it('stated breakpoint overrides the natural one', () => {
    // bp $450/SF ⇒ 900,000; % rent = 0.06 × 100,000 = 6,000
    const r = underwriteTenant(shell({ glaSf: 2_000, purchasePrice: 500_000, exitCapPct: 0.10, holdYears: 2, leases: [{ ...leaseBase, breakpointPsf: 450 }] }))
    expect(r.breakdown[0].pctRent).toBeCloseTo(6_000, 4)
  })
})

describe('monthly model times downtime and free rent to the month', () => {
  // 1,000 SF at $10 with 6 months left; renewal prob 0 (pure new-deal path),
  // market $12, 2 months downtime + 1 month free rent. Month grid:
  //   m1–6  in place  10,000/12 ≈ 833.33 → 5,000 total
  //   m7–8  downtime  0   (TI/LC 30×1,000 = 30,000 hits m7)
  //   m9    free rent 0
  //   m10–12 market   12,000/12 = 1,000 → 3,000
  //   year 1 = 8,000 ; year 2 = full market 12,000
  it('year-1 rent loses exactly the vacant + free months', () => {
    const r = underwriteTenant(shell({
      glaSf: 1_000, purchasePrice: 100_000, exitCapPct: 0.10, holdYears: 2,
      periodicity: 'monthly',
      leases: [{ name: 'M', sf: 1_000, baseRentPsf: 10, annualBumpPct: 0, termRemainingYears: 0.5, recovery: 'nnn' }],
      rollover: {
        renewalProbPct: 0, marketRentPsf: 12, marketRentGrowthPct: 0,
        downtimeMonths: 2, tiNewPsf: 20, tiRenewPsf: 5, lcNewPsf: 10, lcRenewPsf: 2,
        freeRentMonthsNew: 1, releaseTermYears: 7,
      },
    }))
    expect(r.breakdown[0].baseRent).toBeCloseTo(8_000, 2)
    expect(r.breakdown[0].capital).toBeCloseTo(30_000, 2)
    expect(r.breakdown[1].baseRent).toBeCloseTo(12_000, 2)
    expect(r.breakdown[1].capital).toBeCloseTo(0, 2)
  })
})

describe('gross lease pays no separate recovery', () => {
  it('recoveries stay zero while OpEx still runs through NOI', () => {
    const r = underwriteTenant(shell({
      holdYears: 2,
      leases: [{ name: 'G', sf: 10_000, baseRentPsf: 28, annualBumpPct: 0, termRemainingYears: 10, recovery: 'gross' }],
      opex: {
        recoverableOpexPsf: 5, nonRecoverableOpexPsf: 1, opexGrowthPct: 0,
        generalVacancyPct: 0, creditLossPct: 0, capitalReservePsf: 0,
      },
    }))
    expect(r.breakdown[0].recoveries).toBe(0)
    // NOI = 280,000 − 60,000
    expect(r.breakdown[0].noi).toBeCloseTo(220_000, 6)
  })
})

describe('vacancy and credit loss apply to EGI', () => {
  it('takes generalVacancy + creditLoss off effective gross income', () => {
    // EGI = 200,000 rent (no recoveries/opex); 5% + 2% ⇒ 14,000 off, NOI 186,000
    const r = underwriteTenant(shell({
      holdYears: 2,
      leases: [{ name: 'V', sf: 10_000, baseRentPsf: 20, annualBumpPct: 0, termRemainingYears: 10, recovery: 'nnn' }],
      opex: {
        recoverableOpexPsf: 0, nonRecoverableOpexPsf: 0, opexGrowthPct: 0,
        generalVacancyPct: 0.05, creditLossPct: 0.02, capitalReservePsf: 0,
      },
    }))
    expect(r.breakdown[0].vacancyCredit).toBeCloseTo(14_000, 6)
    expect(r.breakdown[0].noi).toBeCloseTo(186_000, 6)
  })
})
