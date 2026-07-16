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
//  • Recoveries (v3.4 — recovery & income realism):
//     - Recoverable OpEx splits into CONTROLLABLE (CAM / R&M — recoverableOpexPsf)
//       and NON-CONTROLLABLE (real-estate tax + insurance — taxInsurancePsf). Only
//       the controllable pool is subject to the recovery cap and the CAM admin fee;
//       tax + insurance pass through uncapped and un-marked-up (real-lease behavior).
//       The two pools can grow at different rates (taxes often outpace CAM).
//     - NNN tenants reimburse their occupied SF x (capped controllable x admin fee
//       + uncapped tax/insurance), with an optional gross-up: during downtime the
//       landlord still recovers as if the tenant's space were grossUp%-occupied.
//     - base_year tenants reimburse only the total recoverable OpEx GROWTH above
//       their base-year stop (default = year-1 total recoverable level).
//     - gross tenants pay a gross rent (no separate recovery).
//  • Percentage rent: a retail tenant with sales and a % rate pays overage on
//    sales above the (natural or stated) breakpoint; scaled by occupancy.
//  • NOI = base rent + recoveries + % rent + other income - OpEx - vacancy - credit.
//    Capital = TI + LC (rollover years) + capital reserves.
//  • Exit value = forward (year hold+1) NOI / exit cap.
//
// NOT modeled (first-pass): monthly granularity; per-tenant base-year stops other
// than the default. Sanity-check against ARGUS before relying on this for a bid.

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
  recoverableOpexPsf: number    // CONTROLLABLE recoverable OpEx (CAM / R&M), $/SF/yr — capped + admin-fee'd
  taxInsurancePsf?: number      // NON-controllable recoverable (RE tax + insurance), $/SF/yr — uncapped, no admin fee (default 0)
  taxInsuranceGrowthPct?: number// annual growth for tax + insurance (default = opexGrowthPct)
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
  periodicity?: 'annual' | 'monthly'  // NOI granularity (default 'annual'); 'monthly' times downtime/free-rent/expiry to the month
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
  const taxInsGrow = Math.pow(1 + (o.taxInsuranceGrowthPct ?? o.opexGrowthPct), t - 1)
  const controllableOpex = o.recoverableOpexPsf * m.glaSf * grow       // controllable recoverable (CAM/R&M) expense
  const taxInsExpense = (o.taxInsurancePsf ?? 0) * m.glaSf * taxInsGrow // real-estate tax + insurance expense
  const recoverableOpex = controllableOpex + taxInsExpense             // total recoverable expense (OpEx line)
  const nonRecoverableOpex = o.nonRecoverableOpexPsf * m.glaSf * grow
  const otherIncome = (o.otherIncomePsf ?? 0) * m.glaSf * grow

  // $/SF tenants are BILLED. Controllable growth is capped if a controllable cap
  // is set (landlord absorbs the excess above the cap); tax + insurance always
  // pass through uncapped and un-admin-fee'd.
  const billGrow = o.recoveryCapPct != null
    ? Math.pow(1 + Math.min(o.opexGrowthPct, o.recoveryCapPct), t - 1)
    : grow
  const billedCtrlPsf = o.recoverableOpexPsf * billGrow                // controllable billed $/SF (capped), pre admin fee
  const billedTaxPsf = (o.taxInsurancePsf ?? 0) * taxInsGrow           // tax + insurance billed $/SF (uncapped)
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
      // controllable is marked up by the admin fee; tax + insurance are not
      recoveries += billSf * (billedCtrlPsf * adminFee + billedTaxPsf)
    } else if (l.recovery === 'base_year') {
      // stop = yr-1 TOTAL recoverable (controllable + tax/ins) by default; reimburse growth over it (no admin fee)
      const stop = l.baseYearOpexPsf ?? (o.recoverableOpexPsf + (o.taxInsurancePsf ?? 0))
      recoveries += occSf * Math.max(0, (billedCtrlPsf + billedTaxPsf) - stop)
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

// ─────────────────────── monthly (opt-in) sub-model ───────────────────────
// Same economics as the annual model, but resolved on a monthly grid so downtime,
// free rent and lease expiry are timed to the month (not smeared across a whole
// year). Annual expense/recovery figures are divided by 12; annual growth uses the
// month's year index. Rolls up to the SAME annual noiByYear the returns core reads,
// so financing/refi/promote are unchanged. A flat, no-rollover model reproduces the
// annual result exactly (PS-validated).

interface MonthFlow { rent: number; capital: number; occupiedSf: number; occFrac: number }

/** One lease's base rent, leasing capital and occupied SF for absolute month mAbs (1-indexed from close). */
function leaseMonth(l: LeaseLine, roll: RolloverAssumptions, mAbs: number): MonthFlow {
  const termMo = Math.max(0, Math.round(l.termRemainingYears * 12))
  const yr0 = Math.floor((mAbs - 1) / 12)                    // 0-based year for annual growth/steps
  const marketPsf = roll.marketRentPsf * Math.pow(1 + roll.marketRentGrowthPct, yr0)

  if (mAbs <= termMo) {
    const annualRent = l.baseRentPsf * Math.pow(1 + l.annualBumpPct, yr0) * l.sf   // stepped annually
    return { rent: annualRent / 12, capital: 0, occupiedSf: l.sf, occFrac: 1 }
  }

  // rolled: the space re-leases every releaseTermYears. Each new lease starts with
  // downtime (vacant), then free rent (occupied, no rent); TI/LC hit the event month.
  const releaseMo = Math.max(1, Math.round((roll.releaseTermYears ?? 7) * 12))
  const cyclePos = (mAbs - termMo - 1) % releaseMo           // 0..releaseMo-1 within the current lease
  const eventMonth = cyclePos === 0
  const p = Math.min(1, Math.max(0, roll.renewalProbPct))
  const dtMo = Math.max(0, Math.round(roll.downtimeMonths))
  const frMo = Math.max(0, Math.round(roll.freeRentMonthsNew))
  const inDowntime = cyclePos < dtMo
  const inFreeRent = cyclePos >= dtMo && cyclePos < dtMo + frMo
  const mkMonthly = marketPsf * l.sf / 12
  const newRent = (inDowntime || inFreeRent) ? 0 : mkMonthly
  const newOccSf = inDowntime ? 0 : l.sf                     // no recovery while vacant
  return {
    rent: p * mkMonthly + (1 - p) * newRent,                 // renewal: full rent, no downtime/free rent
    capital: eventMonth ? (p * (roll.tiRenewPsf + roll.lcRenewPsf) + (1 - p) * (roll.tiNewPsf + roll.lcNewPsf)) * l.sf : 0,
    occupiedSf: p * l.sf + (1 - p) * newOccSf,
    occFrac: l.sf > 0 ? (p * l.sf + (1 - p) * newOccSf) / l.sf : 0,
  }
}

interface MonthAgg { baseRent: number; recoveries: number; pctRent: number; otherIncome: number; opex: number; vacancyCredit: number; capital: number }

/** Property NOI components for absolute month mAbs (1-indexed). */
function propertyMonth(m: TenantModelAssumptions, mAbs: number): MonthAgg {
  const o = m.opex
  const yr0 = Math.floor((mAbs - 1) / 12)
  const grow = Math.pow(1 + o.opexGrowthPct, yr0)
  const taxInsGrow = Math.pow(1 + (o.taxInsuranceGrowthPct ?? o.opexGrowthPct), yr0)
  const controllableOpex = o.recoverableOpexPsf * m.glaSf * grow / 12
  const taxInsExpense = (o.taxInsurancePsf ?? 0) * m.glaSf * taxInsGrow / 12
  const nonRecoverableOpex = o.nonRecoverableOpexPsf * m.glaSf * grow / 12
  const otherIncome = (o.otherIncomePsf ?? 0) * m.glaSf * grow / 12

  const billGrow = o.recoveryCapPct != null
    ? Math.pow(1 + Math.min(o.opexGrowthPct, o.recoveryCapPct), yr0)
    : grow
  const billedCtrlPsf = o.recoverableOpexPsf * billGrow
  const billedTaxPsf = (o.taxInsurancePsf ?? 0) * taxInsGrow
  const adminFee = 1 + Math.max(0, o.adminFeePct ?? 0)
  const grossUp = Math.min(1, Math.max(0, o.grossUpPct ?? 0))
  const salesGrow = Math.pow(1 + (o.salesGrowthPct ?? o.opexGrowthPct), yr0)

  let baseRent = 0, recoveries = 0, pctRent = 0, capital = 0
  for (const l of m.leases) {
    const y = leaseMonth(l, m.rollover, mAbs)
    baseRent += y.rent
    capital += y.capital
    const fullSf = l.proRataSharePct != null ? l.proRataSharePct * m.glaSf : l.sf
    const occSf = l.proRataSharePct != null ? l.proRataSharePct * m.glaSf * y.occFrac : y.occupiedSf
    const billSf = grossUp > 0 ? Math.min(fullSf, Math.max(occSf, grossUp * fullSf)) : occSf
    if (l.recovery === 'nnn') {
      recoveries += billSf * (billedCtrlPsf * adminFee + billedTaxPsf) / 12
    } else if (l.recovery === 'base_year') {
      const stop = l.baseYearOpexPsf ?? (o.recoverableOpexPsf + (o.taxInsurancePsf ?? 0))
      recoveries += occSf * Math.max(0, (billedCtrlPsf + billedTaxPsf) - stop) / 12
    }
    const rate = l.pctRentRate ?? 0
    if (rate > 0 && (l.salesPsf ?? 0) > 0) {
      const sales = (l.salesPsf as number) * l.sf * salesGrow                        // annual sales
      const bp = l.breakpointPsf != null ? l.breakpointPsf * l.sf : (y.rent * 12) / rate  // annual base
      pctRent += Math.max(0, rate * (sales - bp)) * y.occFrac / 12
    }
  }
  const egi = baseRent + recoveries + pctRent + otherIncome
  const vacancyCredit = egi * (o.generalVacancyPct + o.creditLossPct)
  const opex = controllableOpex + taxInsExpense + nonRecoverableOpex
  return { baseRent, recoveries, pctRent, otherIncome, opex, vacancyCredit, capital }
}

/** Year t (1-indexed) NOI built by aggregating its 12 months. */
function propertyYearMonthly(m: TenantModelAssumptions, t: number): TenantYearBreakdown {
  let baseRent = 0, recoveries = 0, pctRent = 0, otherIncome = 0, opex = 0, vacancyCredit = 0, capital = 0
  for (let k = 1; k <= 12; k++) {
    const a = propertyMonth(m, (t - 1) * 12 + k)
    baseRent += a.baseRent; recoveries += a.recoveries; pctRent += a.pctRent; otherIncome += a.otherIncome
    opex += a.opex; vacancyCredit += a.vacancyCredit; capital += a.capital
  }
  const noi = baseRent + recoveries + pctRent + otherIncome - opex - vacancyCredit
  return { year: t, baseRent, recoveries, pctRent, otherIncome, opex, vacancyCredit, noi, capital: capital + m.opex.capitalReservePsf * m.glaSf }
}
// ───────────────────────────────────────────────────────────────────────────

export function underwriteTenant(m: TenantModelAssumptions): TenantUnderwriteResult {
  const hold = Math.max(1, Math.round(m.holdYears))
  const py = m.periodicity === 'monthly' ? propertyYearMonthly : propertyYear
  const breakdown: TenantYearBreakdown[] = []
  const noiByYear: number[] = []
  const capitalByYear: number[] = []
  for (let t = 1; t <= hold; t++) {
    const y = py(m, t)
    breakdown.push(y)
    noiByYear.push(y.noi)
    capitalByYear.push(y.capital)
  }
  const exitYearNoi = py(m, hold + 1).noi   // forward NOI at sale

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
