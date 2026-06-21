import type { OperatingCategory } from '../types/database'

export const INCOME_CATEGORIES: OperatingCategory[] = [
  'base_rent',
  'percentage_rent',
  'cam_recovery',
  'other_income',
]

export const EXPENSE_CATEGORIES: OperatingCategory[] = [
  'operating_expenses',
  'management_fee',
  'taxes',
  'insurance',
  'utilities',
  'repairs_maintenance',
  'other_expense',
  // capital_expenditure is tracked but excluded from NOI
]

export interface LineItem {
  category: OperatingCategory
  amount: number
}

export interface NOIResult {
  noi: number
  totalIncome: number
  totalExpenses: number
  byCategory: Partial<Record<OperatingCategory, number>>
}

/**
 * Compute Net Operating Income.
 * NOI = effective gross income − operating expenses.
 * Capital expenditures are excluded (tracked separately).
 */
export function computeNOI(lineItems: LineItem[]): NOIResult {
  const byCategory: Partial<Record<OperatingCategory, number>> = {}
  let totalIncome = 0
  let totalExpenses = 0

  for (const item of lineItems) {
    byCategory[item.category] = (byCategory[item.category] ?? 0) + item.amount
    if (INCOME_CATEGORIES.includes(item.category)) {
      totalIncome += item.amount
    } else if (EXPENSE_CATEGORIES.includes(item.category)) {
      totalExpenses += item.amount
    }
  }

  return { noi: totalIncome - totalExpenses, totalIncome, totalExpenses, byCategory }
}

/**
 * Debt Service Coverage Ratio.
 * DSCR = NOI / annual debt service.
 * Returns null when debt service is zero to avoid division by zero.
 */
export function computeDSCR(noi: number, annualDebtService: number): number | null {
  if (annualDebtService === 0) return null
  return noi / annualDebtService
}

export interface DSCRHeadroomResult {
  dscr: number | null
  headroom: number | null
  isBreach: boolean
}

/**
 * DSCR headroom = actual DSCR − covenant threshold.
 * Negative = covenant breach.
 */
export function computeDSCRHeadroom(
  noi: number,
  annualDebtService: number,
  covenantThreshold: number,
): DSCRHeadroomResult {
  const dscr = computeDSCR(noi, annualDebtService)
  if (dscr === null) return { dscr: null, headroom: null, isBreach: false }
  const headroom = dscr - covenantThreshold
  return { dscr, headroom, isBreach: headroom < 0 }
}

/**
 * Weighted Average Lease Term in years.
 * WALT = Σ(leasedSF × remainingTermYears) / totalLeasedSF
 */
export function computeWALT(
  leases: Array<{ leasedSf: number; expirationDate: string }>,
  asOfDate: Date = new Date(),
): number {
  let weightedSum = 0
  let totalSf = 0

  for (const lease of leases) {
    const remainingMs = new Date(lease.expirationDate).getTime() - asOfDate.getTime()
    const remainingYears = Math.max(0, remainingMs / (1000 * 60 * 60 * 24 * 365.25))
    weightedSum += lease.leasedSf * remainingYears
    totalSf += lease.leasedSf
  }

  return totalSf === 0 ? 0 : weightedSum / totalSf
}

/**
 * Physical occupancy by square footage. Returns 0–1.
 */
export function computePhysicalOccupancy(occupiedSf: number, totalLeasableSf: number): number {
  return totalLeasableSf === 0 ? 0 : occupiedSf / totalLeasableSf
}

/**
 * Trailing-12 NOI: sum NOI across the 12 most recent monthly periods.
 * Expects periods sorted oldest-first; filters to actuals only (is_budget = false).
 */
export function computeTrailing12NOI(
  periodsWithItems: Array<{ isActual: boolean; lineItems: LineItem[] }>,
): number {
  const actuals = periodsWithItems.filter(p => p.isActual).slice(-12)
  return actuals.reduce((sum, p) => sum + computeNOI(p.lineItems).noi, 0)
}
