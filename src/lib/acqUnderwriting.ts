// acqUnderwriting.ts — acquisition returns engine.
//
// `computeReturns` is the shared core: given a NOI stream + leasing-capital
// stream + financing/exit assumptions it returns levered/unlevered IRR, equity
// multiple, cash-on-cash, DSCR, debt yield and yield-on-cost, on top of the
// validated Actual/365 `xirr` in waterfall.ts. Two front-ends feed it:
//   • `underwrite`  — a quick blended direct-cap NOI-growth model (Phase 1).
//   • tenantUnderwriting.ts — a bottoms-up, lease-by-lease NOI stream (v2).
// Pure functions, zero DB calls, fully testable.

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
  ltvPct?: number             // loan sized as % of purchase price (default 0 = all cash)
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
  yearlyCapital: number[]          // t=1..hold leasing/reserve capital
  yearlyDebtService: number[]      // t=1..hold
  yearlyOperatingCf: number[]      // levered, after capital + debt, before sale
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

export interface ReturnsInput {
  noiByYear: number[]         // t=1..hold operating NOI (after OpEx, before capital + debt)
  capitalByYear: number[]     // t=1..hold TI/LC/reserve capital (>=0 outflow); same length as noiByYear
  exitYearNoi: number         // forward NOI at sale (year hold+1)
  purchasePrice: number
  acqCostsPct: number
  capexUpfront: number
  exitCapPct: number
  sellingCostsPct: number
  ltvPct: number
  loanRatePct: number
  amortYears: number
  closeDate: string
}

const clampInt = (n: number) => Math.max(1, Math.round(n))
const iso = (base: string, years: number): string =>
  new Date(new Date(base).getTime() + Math.round(years * 365) * MS_PER_DAY).toISOString().slice(0, 10)

function annualPayment(loan: number, rate: number, amortYears: number): number {
  if (loan <= 0) return 0
  if (rate <= 0) return loan / amortYears
  return (loan * rate) / (1 - Math.pow(1 + rate, -amortYears))
}
function balanceAfter(loan: number, rate: number, amortYears: number, k: number): number {
  if (loan <= 0) return 0
  const pmt = annualPayment(loan, rate, amortYears)
  if (rate <= 0) return Math.max(0, loan - pmt * k)
  const f = Math.pow(1 + rate, k)
  return Math.max(0, loan * f - pmt * (f - 1) / rate)
}

/** Shared returns core — NOI + capital streams -> levered returns. */
export function computeReturns(inp: ReturnsInput): AcqResult {
  const hold = inp.noiByYear.length
  const totalBasis = inp.purchasePrice * (1 + inp.acqCostsPct) + inp.capexUpfront
  const loanAmount = Math.max(0, inp.purchasePrice * inp.ltvPct)
  const equity = totalBasis - loanAmount
  const io = !(inp.amortYears > 0 && inp.loanRatePct > 0)
  const annualDs = loanAmount > 0 ? (io ? loanAmount * inp.loanRatePct : annualPayment(loanAmount, inp.loanRatePct, inp.amortYears)) : 0

  const yearlyDebtService: number[] = []
  const yearlyOperatingCf: number[] = []
  for (let t = 1; t <= hold; t++) {
    yearlyDebtService.push(annualDs)
    yearlyOperatingCf.push(inp.noiByYear[t - 1] - (inp.capitalByYear[t - 1] ?? 0) - annualDs)
  }

  const exitValue = inp.exitCapPct > 0 ? inp.exitYearNoi / inp.exitCapPct : 0
  const loanPayoff = loanAmount > 0 ? (io ? loanAmount : balanceAfter(loanAmount, inp.loanRatePct, inp.amortYears, hold)) : 0
  const netSaleProceeds = exitValue * (1 - inp.sellingCostsPct) - loanPayoff

  const lev: DatedFlow[] = [{ date: inp.closeDate, amount: -equity }]
  const unlev: DatedFlow[] = [{ date: inp.closeDate, amount: -totalBasis }]
  for (let t = 1; t <= hold; t++) {
    const d = iso(inp.closeDate, t)
    const cap = inp.capitalByYear[t - 1] ?? 0
    lev.push({ date: d, amount: yearlyOperatingCf[t - 1] + (t === hold ? netSaleProceeds : 0) })
    unlev.push({ date: d, amount: inp.noiByYear[t - 1] - cap + (t === hold ? exitValue * (1 - inp.sellingCostsPct) : 0) })
  }

  const invested = -lev.filter(f => f.amount < 0).reduce((s, f) => s + f.amount, 0)
  const returned = lev.filter(f => f.amount > 0).reduce((s, f) => s + f.amount, 0)
  const equityMultiple = invested > 0 ? returned / invested : 0
  const avgCashOnCash = equity > 0 ? yearlyOperatingCf.reduce((s, c) => s + c, 0) / hold / equity : 0

  return {
    totalBasis, loanAmount, equity,
    goingInCapPct: inp.purchasePrice > 0 ? inp.noiByYear[0] / inp.purchasePrice : 0,
    yearlyNoi: inp.noiByYear.slice(), yearlyCapital: inp.capitalByYear.slice(), yearlyDebtService, yearlyOperatingCf,
    exitYearNoi: inp.exitYearNoi, exitValue, loanPayoff, netSaleProceeds,
    leveredIrr: xirr(lev), unleveredIrr: xirr(unlev),
    equityMultiple, avgCashOnCash,
    yearOneDscr: annualDs > 0 ? inp.noiByYear[0] / annualDs : null,
    yearOneDebtYield: loanAmount > 0 ? inp.noiByYear[0] / loanAmount : null,
    stabilizedYieldOnCostPct: totalBasis > 0 ? inp.exitYearNoi / totalBasis : 0,
  }
}

/** Quick blended direct-cap NOI-growth model (Phase 1). */
export function underwrite(a: AcqAssumptions): AcqResult {
  const g = a.noiGrowthPct ?? 0.03
  const hold = clampInt(a.holdYears)
  const noiByYear: number[] = []
  for (let t = 1; t <= hold; t++) noiByYear.push(a.inPlaceNoi * Math.pow(1 + g, t - 1))
  return computeReturns({
    noiByYear, capitalByYear: noiByYear.map(() => 0),
    exitYearNoi: a.inPlaceNoi * Math.pow(1 + g, hold),
    purchasePrice: a.purchasePrice, acqCostsPct: a.acqCostsPct ?? 0.02, capexUpfront: a.capexUpfront ?? 0,
    exitCapPct: a.exitCapPct, sellingCostsPct: a.sellingCostsPct ?? 0.02,
    ltvPct: a.ltvPct ?? 0, loanRatePct: a.loanRatePct ?? 0, amortYears: a.amortYears ?? 0, closeDate: a.closeDate,
  })
}

export interface SensitivityGrid {
  exitCaps: number[]
  growths: number[]
  leveredIrr: (number | null)[][]   // [growthRow][exitCapCol]
}

/** Levered-IRR sensitivity over exit cap (cols) x NOI growth (rows) — simple model. */
export function sensitivity(base: AcqAssumptions, exitCaps: number[], growths: number[]): SensitivityGrid {
  return {
    exitCaps, growths,
    leveredIrr: growths.map(g => exitCaps.map(ec => underwrite({ ...base, noiGrowthPct: g, exitCapPct: ec }).leveredIrr)),
  }
}

// re-exported so the tenant engine can build dated exit sensitivity too
export { iso as _isoAddYears }
