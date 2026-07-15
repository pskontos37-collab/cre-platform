// acqUnderwriting.ts — first-pass ("napkin") acquisition returns engine.
//
// This is the quick levered underwrite an acquisitions team runs BEFORE building
// the full tenant-level ARGUS model: a direct-cap, NOI-growth cash flow with
// financing, an exit at a chosen cap, and levered/unlevered IRR, equity multiple,
// cash-on-cash, DSCR and debt yield. Pure functions on top of the validated
// Actual/365 `xirr` in waterfall.ts — zero DB calls, fully testable.
//
// Fidelity note: NOI grows at a single blended rate here. Tenant-level fidelity
// (rollover, mark-to-market, recoveries, TI/LC, downtime) is the planned v2 that
// PRODUCES the NOI stream — it then flows through this same returns math.

import { xirr, type DatedFlow } from './waterfall'

const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface AcqAssumptions {
  purchasePrice: number
  acqCostsPct?: number        // closing/acquisition costs as % of price (default 2%)
  capexUpfront?: number       // day-one capital added to basis + equity (default 0)
  inPlaceNoi: number          // year-1 (going-in) NOI, dollars
  noiGrowthPct?: number       // annual NOI growth (default 3%)
  holdYears: number           // whole years
  exitCapPct: number          // exit cap rate (decimal, e.g. 0.0675)
  sellingCostsPct?: number    // disposition costs as % of gross sale (default 2%)
  // financing (omit / ltv 0 => all-cash)
  ltvPct?: number             // loan sized as % of purchase price (default 0)
  loanRatePct?: number        // annual interest rate (decimal)
  amortYears?: number         // amortization term; 0/undefined => interest-only
  closeDate: string           // ISO 'yyyy-mm-dd' — anchors the dated IRR
}

export interface AcqResult {
  totalBasis: number
  loanAmount: number
  equity: number
  goingInCapPct: number
  yearlyNoi: number[]              // t=1..hold
  yearlyDebtService: number[]      // t=1..hold
  yearlyOperatingCf: number[]      // levered, before sale
  exitYearNoi: number              // forward NOI at sale
  exitValue: number
  loanPayoff: number
  netSaleProceeds: number
  leveredIrr: number | null
  unleveredIrr: number | null
  equityMultiple: number
  avgCashOnCash: number
  yearOneDscr: number | null
  yearOneDebtYield: number | null
  stabilizedYieldOnCostPct: number // exit-year NOI / total basis
}

const clampInt = (n: number) => Math.max(1, Math.round(n))
const iso = (base: string, years: number): string =>
  new Date(new Date(base).getTime() + Math.round(years * 365) * MS_PER_DAY).toISOString().slice(0, 10)

/** Annual amortizing payment (0 rate => straight-line; IO handled by caller). */
function annualPayment(loan: number, rate: number, amortYears: number): number {
  if (loan <= 0) return 0
  if (rate <= 0) return loan / amortYears
  return (loan * rate) / (1 - Math.pow(1 + rate, -amortYears))
}
/** Remaining balance after `k` years of amortization at annual `rate`. */
function balanceAfter(loan: number, rate: number, amortYears: number, k: number): number {
  if (loan <= 0) return 0
  const pmt = annualPayment(loan, rate, amortYears)
  if (rate <= 0) return Math.max(0, loan - pmt * k)
  const f = Math.pow(1 + rate, k)
  return Math.max(0, loan * f - pmt * (f - 1) / rate)
}

export function underwrite(a: AcqAssumptions): AcqResult {
  const acqCostsPct = a.acqCostsPct ?? 0.02
  const capexUpfront = a.capexUpfront ?? 0
  const g = a.noiGrowthPct ?? 0.03
  const sellPct = a.sellingCostsPct ?? 0.02
  const hold = clampInt(a.holdYears)
  const ltv = a.ltvPct ?? 0
  const rate = a.loanRatePct ?? 0
  const amort = a.amortYears ?? 0
  const io = !(amort > 0 && rate > 0)

  const totalBasis = a.purchasePrice * (1 + acqCostsPct) + capexUpfront
  const loanAmount = Math.max(0, a.purchasePrice * ltv)
  const equity = totalBasis - loanAmount

  const yearlyNoi: number[] = []
  const yearlyDebtService: number[] = []
  const yearlyOperatingCf: number[] = []
  const annualDs = loanAmount > 0 ? (io ? loanAmount * rate : annualPayment(loanAmount, rate, amort)) : 0
  for (let t = 1; t <= hold; t++) {
    const noi = a.inPlaceNoi * Math.pow(1 + g, t - 1)
    yearlyNoi.push(noi)
    yearlyDebtService.push(annualDs)
    yearlyOperatingCf.push(noi - annualDs)
  }

  const exitYearNoi = a.inPlaceNoi * Math.pow(1 + g, hold)   // forward 12-mo NOI at sale
  const exitValue = a.exitCapPct > 0 ? exitYearNoi / a.exitCapPct : 0
  const loanPayoff = loanAmount > 0 ? (io ? loanAmount : balanceAfter(loanAmount, rate, amort, hold)) : 0
  const netSaleProceeds = exitValue * (1 - sellPct) - loanPayoff

  // dated levered flows: -equity at close, operating CF each year, + sale in final year
  const lev: DatedFlow[] = [{ date: a.closeDate, amount: -equity }]
  const unlev: DatedFlow[] = [{ date: a.closeDate, amount: -totalBasis }]
  for (let t = 1; t <= hold; t++) {
    const d = iso(a.closeDate, t)
    const sale = t === hold ? netSaleProceeds : 0
    const saleUnlev = t === hold ? exitValue * (1 - sellPct) : 0
    lev.push({ date: d, amount: yearlyOperatingCf[t - 1] + sale })
    unlev.push({ date: d, amount: yearlyNoi[t - 1] + saleUnlev })
  }

  // equity multiple = total cash returned / total cash invested (from the levered flows)
  const invested = -lev.filter(f => f.amount < 0).reduce((s, f) => s + f.amount, 0)
  const returned = lev.filter(f => f.amount > 0).reduce((s, f) => s + f.amount, 0)
  const equityMultiple = invested > 0 ? returned / invested : 0
  // operating cash-on-cash (excludes the sale) averaged over the hold
  const avgCashOnCash = equity > 0 ? yearlyOperatingCf.reduce((s, c) => s + c, 0) / hold / equity : 0

  return {
    totalBasis, loanAmount, equity,
    goingInCapPct: a.purchasePrice > 0 ? a.inPlaceNoi / a.purchasePrice : 0,
    yearlyNoi, yearlyDebtService, yearlyOperatingCf,
    exitYearNoi, exitValue, loanPayoff, netSaleProceeds,
    leveredIrr: xirr(lev),
    unleveredIrr: xirr(unlev),
    equityMultiple,
    avgCashOnCash,
    yearOneDscr: annualDs > 0 ? yearlyNoi[0] / annualDs : null,
    yearOneDebtYield: loanAmount > 0 ? a.inPlaceNoi / loanAmount : null,
    stabilizedYieldOnCostPct: totalBasis > 0 ? exitYearNoi / totalBasis : 0,
  }
}

export interface SensitivityGrid {
  exitCaps: number[]
  growths: number[]
  leveredIrr: (number | null)[][]   // [growthRow][exitCapCol]
}

/** Levered-IRR sensitivity over exit cap (cols) x NOI growth (rows). */
export function sensitivity(base: AcqAssumptions, exitCaps: number[], growths: number[]): SensitivityGrid {
  return {
    exitCaps, growths,
    leveredIrr: growths.map(g => exitCaps.map(ec => underwrite({ ...base, noiGrowthPct: g, exitCapPct: ec }).leveredIrr)),
  }
}
