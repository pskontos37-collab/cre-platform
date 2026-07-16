// tenantUnderwriting.ts — bottoms-up, lease-by-lease acquisition underwrite
// (ARGUS-lite). Builds an annual NOI + leasing-capital stream from a rent roll +
// market leasing assumptions + operating expenses, then runs it through the
// shared returns core in acqUnderwriting.ts.
//
// Model (annual periods, institutional first-pass conventions):
//  • In-place base rent with contractual annual steps until expiry.
//  • At expiry, a BLENDED rollover: renewalProb * (renew at market, no downtime)
//    + (1-renewalProb) * (new lease at market, with downtime + TI/LC + free rent).
//    The space re-rolls every releaseTermYears within the hold.
//  • Recoveries (v3.3 — recovery & income realism):
//     - NNN tenants reimburse their occupied SF x recoverable OpEx/SF, with an
//       optional CAM admin-fee markup, an optional controllable-recovery growth
//       cap (tenant pays capped growth; landlord eats the excess), and an optional
//       gross-up: during downtime the landlord still recovers as if the tenant's
//       space were grossUp%-occupied.
//     - base_year tenants reimburse only the recoverable OpEx GROWTH above their
//       base-year stop (default = year-1 recoverable level).
//     - gross tenants pay a gross rent (no separate recovery).
//  • Percentage rent: a retail tenant with sales and a % rate pays overage on
//    sales above the (natural or stated) breakpoint; scaled by occupancy.
//  • NOI = base rent + recoveries + % rent + other income - OpEx - vacancy - credit.
//    Capital = TI + LC (rollover years) + capital reserves.
//  • Exit value = forward (year hold+1) NOI / exit cap.
//
// NOT modeled (first-pass): monthly granularity; per-tenant base-year stops other
// than the default; admin fee / caps split by controllable vs tax/insurance (the
// whole recoverable pool is treated as controllable). Sanity-check against ARGUS
// before relying on this for a bid.

import { computeReturns, type AcqResult, type RefinanceTerms } from './acqUnderwriting'

export type RecoveryType = 'nnn' | 'gross' | 'base_year'

export interface LeaseLine {
  name: string
  sf: number
  baseRentPsf: number          // current annual base rent, $/SF
  annualBumpPct: number        // contractual step, %/yr (decimal)
  termRemainingYears: number   // years from close until expiry (rounded to whole years)
  recovery: RecoveryType
  proRataSharePct?: number     // share of recoverable OpEx; default sf / GLA
  baseYearOpexPsf?: number     // base_year only: expense stop $/SF (default = yr-1 recoverable)
  salesPsf?: number            // annual tenant sales, $/SF (drives % rent)
  pctRentRate?: number         // percentage-rent rate, decimal (e.g. 0.06)
  breakpointPsf?: number       // % rent breakpoint $/SF (default natural = baseRent/rate)
}

export interface RolloverAssumptions {
  renewalProbPct: number        // 0..1
  marketRentPsf: number         // today's market base rent, $/SF
  marketRentGrowthPct: number   // annual, decimal
  downtimeMonths: number        // vacancy on a NEW deal (non-renewal)
  tiNewPsf: number              // tenant improvements, new deal, $/SF
  tiRenewPsf: number            // TI on renewal, $/SF
  lcNewPsf: number              // leasing commission, new deal, $/SF
  lcRenewPsf: number            // LC on renewal, $/SF
  freeRentMonthsNew: number     // free rent on a new deal
  releaseTermYears?: number     // new-lease term; the space re-rolls every N years (default 7)
}

export interface OpexAssumptions {
  recoverableOpexPsf: number    // CAM + insurance + tax (recoverable), $/SF/yr
  nonRecoverableOpexPsf: number // management, non-reimbursables, $/SF/yr
  opexGrowthPct: number         // annual, decimal
  generalVacancyPct: number     // % of EGI, ON TOP of explicit rollover downtime (default 0)
  creditLossPct: number         // % of EGI
  capitalReservePsf: number     // $/SF/yr
  otherIncomePsf?: number       // parking / storage, $/SF/yr (grows w/ OpEx)
  adminFeePct?: number          // CAM admin fee markup on NNN recoveries (e.g. 0.15)
  recoveryCapPct?: number       // annual cap on controllable recovery growth (null = uncapped)
  grossUpPct?: number           // gross recoveries up to this occupancy (e.g. 0.95; 0 = off)
  salesGrowthPct?: number       // annual growth of tenant sales for % rent (default = opexGrowth)
}

export interface TenantModelAssumptions {
  glaSf: number
  purchasePrice: number
  acqCostsPct: number
  capexUpfront: number
  holdYears: number
  exitCapPct: number
  sellingCostsPct: number
  ltvPct: number
  loanRatePct: number
  amortYears: number
  ioYears?: number
  loanFeePct?: number
  refi?: RefinanceTerms | null
  closeDate: string
  leases: LeaseLine[]
  rollover: RolloverAssumptions
  opex: OpexAssumptions
}

interface TenantYear {
  rent: number            // base rent this year
  capital: number         // TI/LC this year
  occupiedSf: number      // downtime-adjusted occupied SF (recovery / % rent base)
  occFrac: number         // occupiedSf / sf (0..1); how much of the year the space earns
}

/** One lease's base rent, leasing capital and occupied SF for year t (1-indexed). */
function leaseYear(l: LeaseLine, roll: RolloverAssumptions, t: number): TenantYear {
  const rollYear = Math.max(0, Math.round(l.termRemainingYears))
  const marketPsf = roll.marketRentPsf * Math.pow(1 + roll.marketRentGrowthPct, t - 1)

  if (t <= rollYear) {
    // in-place lease, stepped
    return { rent: l.baseRentPsf * Math.pow(1 + l.annualBumpPct, t - 1) * l.sf, capital: 0, occupiedSf: l.sf, occFrac: 1 }
  }

  // rolled: blend renew vs new. The space re-rolls every `releaseTermYears`;
  // TI/LC/downtime/free-rent hit each rollover (lease-start) year.
  const releaseTerm = Math.max(1, Math.round(roll.releaseTermYears ?? 7))
  const first = ((t - rollYear - 1) % releaseTerm) === 0   // rollover-event years: rollYear+1, +releaseTerm, ...
  const p = Math.min(1, Math.max(0, roll.renewalProbPct))
  const dt = first ? Math.min(1, roll.downtimeMonths / 12) : 0
  const frNew = first ? Math.min(1, roll.freeRentMonthsNew / 12) : 0

  const renewRent = marketPsf * l.sf                                   // renewal: full year, no downtime
  const newRent = marketPsf * l.sf * Math.max(0, 1 - dt - frNew)       // new: lose downtime + free rent
  const renewCap = first ? (roll.tiRenewPsf + roll.lcRenewPsf) * l.sf : 0
  const newCap = first ? (roll.tiNewPsf + roll.lcNewPsf) * l.sf : 0
  const occSf = l.sf * (p * 1 + (1 - p) * (1 - dt))                    // vacant during downtime -> no recovery

  return {
    rent: p * renewRent + (1 - p) * newRent,
    capital: p * renewCap + (1 - p) * newCap,
    occupiedSf: occSf,
    occFrac: l.sf > 0 ? occSf / l.sf : 0,
  }
}

export interface TenantYearBreakdown {
  year: number; baseRent: number; recoveries: number; pctRent: number; otherIncome: number
  opex: number; vacancyCredit: number; noi: number; capital: number
}

export interface TenantUnderwriteResult extends AcqResult {
  breakdown: TenantYearBreakdown[]     // t=1..hold
}

/** Build the property NOI for a given year index t (1-indexed). */
function propertyYear(m: TenantModelAssumptions, t: number): TenantYearBreakdown {
  const o = m.opex
  const grow = Math.pow(1 + o.opexGrowthPct, t - 1)
  const recoverableOpex = o.recoverableOpexPsf * m.glaSf * grow        // actual expense (OpEx line)
  const nonRecoverableOpex = o.nonRecoverableOpexPsf * m.glaSf * grow
  const otherIncome = (o.otherIncomePsf ?? 0) * m.glaSf * grow

  // recoverable OpEx/SF that tenants are BILLED — capped growth if a controllable
  // cap is set; landlord still incurs the uncapped `recoverableOpex` above.
  const billGrow = o.recoveryCapPct != null
    ? Math.pow(1 + Math.min(o.opexGrowthPct, o.recoveryCapPct), t - 1)
    : grow
  const billedPsf = o.recoverableOpexPsf * billGrow
  const adminFee = 1 + Math.max(0, o.adminFeePct ?? 0)
  const grossUp = Math.min(1, Math.max(0, o.grossUpPct ?? 0))
  const salesGrow = Math.pow(1 + (o.salesGrowthPct ?? o.opexGrowthPct), t - 1)

  let baseRent = 0, recoveries = 0, pctRent = 0, capital = 0
  for (const l of m.leases) {
    const y = leaseYear(l, m.rollover, t)
    baseRent += y.rent
    capital += y.capital

    // recovery SF: honor an explicit pro-rata share (as a share of GLA), else the
    // downtime-adjusted occupied SF; gross-up lifts the billed SF toward grossUp%.
    const fullSf = l.proRataSharePct != null ? l.proRataSharePct * m.glaSf : l.sf
    const occSf = l.proRataSharePct != null ? l.proRataSharePct * m.glaSf * y.occFrac : y.occupiedSf
    const billSf = grossUp > 0 ? Math.min(fullSf, Math.max(occSf, grossUp * fullSf)) : occSf

    if (l.recovery === 'nnn') {
      recoveries += billSf * billedPsf * adminFee
    } else if (l.recovery === 'base_year') {
      const stop = l.baseYearOpexPsf ?? o.recoverableOpexPsf   // yr-1 recoverable by default
      recoveries += occSf * Math.max(0, billedPsf - stop)      // reimburse growth over the stop
    }

    // percentage rent: overage on sales above the (natural or stated) breakpoint
    const rate = l.pctRentRate ?? 0
    if (rate > 0 && (l.salesPsf ?? 0) > 0) {
      const sales = (l.salesPsf as number) * l.sf * salesGrow
      const bp = l.breakpointPsf != null ? l.breakpointPsf * l.sf : y.rent / rate
      pctRent += Math.max(0, rate * (sales - bp)) * y.occFrac
    }
  }

  const egi = baseRent + recoveries + pctRent + otherIncome
  const vacancyCredit = egi * (o.generalVacancyPct + o.creditLossPct)
  const opex = recoverableOpex + nonRecoverableOpex
  const noi = egi - opex - vacancyCredit
  return { year: t, baseRent, recoveries, pctRent, otherIncome, opex, vacancyCredit, noi, capital: capital + o.capitalReservePsf * m.glaSf }
}

export function underwriteTenant(m: TenantModelAssumptions): TenantUnderwriteResult {
  const hold = Math.max(1, Math.round(m.holdYears))
  const breakdown: TenantYearBreakdown[] = []
  const noiByYear: number[] = []
  const capitalByYear: number[] = []
  for (let t = 1; t <= hold; t++) {
    const y = propertyYear(m, t)
    breakdown.push(y)
    noiByYear.push(y.noi)
    capitalByYear.push(y.capital)
  }
  const exitYearNoi = propertyYear(m, hold + 1).noi   // forward NOI at sale

  const base = computeReturns({
    noiByYear, capitalByYear, exitYearNoi,
    purchasePrice: m.purchasePrice, acqCostsPct: m.acqCostsPct, capexUpfront: m.capexUpfront,
    exitCapPct: m.exitCapPct, sellingCostsPct: m.sellingCostsPct,
    ltvPct: m.ltvPct, loanRatePct: m.loanRatePct, amortYears: m.amortYears,
    ioYears: m.ioYears, loanFeePct: m.loanFeePct, refi: m.refi, closeDate: m.closeDate,
  })
  return { ...base, breakdown }
}

/** Levered-IRR sensitivity over exit cap (cols) x market-rent growth (rows). */
export function tenantSensitivity(m: TenantModelAssumptions, exitCaps: number[], growths: number[]): (number | null)[][] {
  return growths.map(g => exitCaps.map(ec =>
    underwriteTenant({ ...m, exitCapPct: ec, rollover: { ...m.rollover, marketRentGrowthPct: g } }).leveredIrr))
}
