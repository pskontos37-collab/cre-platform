// tenantUnderwriting.ts — bottoms-up, lease-by-lease acquisition underwrite
// (ARGUS-lite). Builds an annual NOI + leasing-capital stream from a rent roll +
// market leasing assumptions + operating expenses, then runs it through the
// shared returns core in acqUnderwriting.ts.
//
// Model (annual periods, institutional first-pass conventions):
//  • In-place base rent with contractual annual steps until expiry.
//  • At expiry, a BLENDED rollover: renewalProb * (renew at market, no downtime)
//    + (1-renewalProb) * (new lease at market, with downtime + TI/LC + free rent).
//    One rollover per lease within the hold (the first expiry) is modeled.
//  • NNN tenants reimburse their pro-rata share of recoverable OpEx (occupancy-
//    adjusted; landlord eats the recoverable OpEx on vacant space). 'gross' /
//    'base_year' tenants pay a gross rent (no separate recovery here).
//  • NOI = base rent + recoveries + other income - OpEx - general vacancy - credit
//    loss. Capital = TI + LC (first rolled year) + capital reserves.
//  • Exit value = forward (year hold+1) NOI / exit cap.
//
// NOT modeled (first-pass): percentage rent (needs tenant sales — use otherIncome),
// monthly granularity, multiple re-rollovers within one hold. Sanity-check against
// ARGUS before relying for a bid.

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
  otherIncomePsf?: number       // parking / % rent proxy / storage, $/SF/yr (grows w/ OpEx)
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

interface TenantYear { rent: number; capital: number; occupiedSf: number; isNnn: boolean }

/** One lease's rent, leasing capital and (recovery-generating) occupied SF for year t (1-indexed). */
function leaseYear(l: LeaseLine, roll: RolloverAssumptions, t: number): TenantYear {
  const isNnn = l.recovery === 'nnn'
  const rollYear = Math.max(0, Math.round(l.termRemainingYears))
  const marketPsf = roll.marketRentPsf * Math.pow(1 + roll.marketRentGrowthPct, t - 1)

  if (t <= rollYear) {
    // in-place lease, stepped
    return { rent: l.baseRentPsf * Math.pow(1 + l.annualBumpPct, t - 1) * l.sf, capital: 0, occupiedSf: l.sf, isNnn }
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
  const renewOcc = l.sf
  const newOcc = l.sf * (1 - dt)                                       // vacant during downtime -> no recovery

  return {
    rent: p * renewRent + (1 - p) * newRent,
    capital: p * renewCap + (1 - p) * newCap,
    occupiedSf: p * renewOcc + (1 - p) * newOcc,
    isNnn,
  }
}

export interface TenantYearBreakdown {
  year: number; baseRent: number; recoveries: number; otherIncome: number
  opex: number; vacancyCredit: number; noi: number; capital: number
}

export interface TenantUnderwriteResult extends AcqResult {
  breakdown: TenantYearBreakdown[]     // t=1..hold
}

/** Build the property NOI for a given year index t (1-indexed). */
function propertyYear(m: TenantModelAssumptions, t: number): TenantYearBreakdown {
  const grow = Math.pow(1 + m.opex.opexGrowthPct, t - 1)
  const recoverableOpex = m.opex.recoverableOpexPsf * m.glaSf * grow
  const nonRecoverableOpex = m.opex.nonRecoverableOpexPsf * m.glaSf * grow
  const otherIncome = (m.opex.otherIncomePsf ?? 0) * m.glaSf * grow

  let baseRent = 0, occNnnSf = 0, capital = 0
  for (const l of m.leases) {
    const y = leaseYear(l, m.rollover, t)
    baseRent += y.rent
    capital += y.capital
    if (y.isNnn) occNnnSf += (l.proRataSharePct != null ? l.proRataSharePct * m.glaSf : y.occupiedSf)
  }
  // NNN reimbursement, pro-rata to occupied NNN share (capped at recoverable OpEx)
  const recoveries = m.glaSf > 0 ? Math.min(1, occNnnSf / m.glaSf) * recoverableOpex : 0

  const egi = baseRent + recoveries + otherIncome
  const vacancyCredit = egi * (m.opex.generalVacancyPct + m.opex.creditLossPct)
  const opex = recoverableOpex + nonRecoverableOpex
  const noi = egi - opex - vacancyCredit
  return { year: t, baseRent, recoveries, otherIncome, opex, vacancyCredit, noi, capital: capital + m.opex.capitalReservePsf * m.glaSf }
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
