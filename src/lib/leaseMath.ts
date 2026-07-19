// src/lib/leaseMath.ts — DETERMINISTIC lease / option / sales / contract math.
//
// The audit's central rule (Phase 1): dates, option windows, rent, annualization,
// period coverage, ratios, and lifecycle status are COMPUTED BY CODE — never by
// an AI model. Every function here is pure and total: the same inputs always
// give the same result, and it returns an explicit "cannot determine" state
// rather than a wrong number when inputs are missing or incomplete.
//
// These functions are the executable specifications behind the audit's
// VALIDATED-ACCEPTANCE-TESTS (see leaseMath.test.ts) — the numbers the review
// found WRONG in the live app (Starbucks's option date, Dave & Buster's ratio,
// the service-contract total) are locked in here as golden-set regressions.
//
// Percentages follow the repo convention: decimals (0.329 = 32.9%).

// ── Dates ────────────────────────────────────────────────────────────────────
// All date math is UTC: a lease date is a calendar day, not an instant, so we
// never let a local timezone / DST shift a deadline by a day. ISO = 'YYYY-MM-DD'.

const DAY_MS = 86_400_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Parse 'YYYY-MM-DD' to a UTC epoch (ms), or null if malformed / not a real day. */
export function parseISODate(iso: string | null | undefined): number | null {
  if (!iso || !ISO_DATE.test(iso)) return null
  const [y, m, d] = iso.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d)
  // Reject calendar overflow (e.g. 2025-02-30 would roll to March): the parsed
  // parts must round-trip exactly.
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null
  return t
}

/** Format a UTC epoch (ms) as 'YYYY-MM-DD'. */
export function formatISODate(t: number): string {
  const d = new Date(t)
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}-${mm}-${dd}`
}

/** Add whole calendar days (negative subtracts). Returns null on bad input. */
export function addDays(iso: string | null | undefined, days: number): string | null {
  const t = parseISODate(iso)
  if (t == null || !Number.isInteger(days)) return null
  return formatISODate(t + days * DAY_MS)
}

/** Whole days from `fromISO` to `toISO` (positive if `to` is later). */
export function daysBetween(fromISO: string, toISO: string): number | null {
  const a = parseISODate(fromISO), b = parseISODate(toISO)
  if (a == null || b == null) return null
  return Math.round((b - a) / DAY_MS)
}

export interface OptionNotice {
  deadline: string | null       // the LAST calendar day notice may be given
  daysBefore: number
  basis: 'calendar'
  error?: string
}

/**
 * Option-notice deadline: the latest day a renewal / extension notice may be
 * given when it is due "at least N days before" a reference date (usually the
 * current-term expiration). Because the requirement is "at least N days before",
 * giving notice exactly N days before still complies, so the deadline is
 * reference − N days.
 *
 * GOLDEN (Starbucks): 270 days before 2031-07-31 = 2030-11-03. The stored value
 * (2030-10-05) and the specialist's proposal (2030-11-04) are BOTH wrong — the
 * exact reason this must be computed, not asserted by a model.
 */
export function optionNoticeDeadline(referenceDate: string | null | undefined, daysBefore: number): OptionNotice {
  const t = parseISODate(referenceDate)
  if (t == null) return { deadline: null, daysBefore, basis: 'calendar', error: 'reference date missing or malformed' }
  if (!Number.isInteger(daysBefore) || daysBefore < 0) {
    return { deadline: null, daysBefore, basis: 'calendar', error: 'daysBefore must be a non-negative integer' }
  }
  return { deadline: formatISODate(t - daysBefore * DAY_MS), daysBefore, basis: 'calendar' }
}

/**
 * Lifecycle status of a dated term, as of an EXPLICIT as-of date. Determinism
 * requires the caller to pass the as-of date — never the wall clock — so the
 * same inputs always give the same answer (and tests are stable).
 */
export function termStatus(
  startISO: string | null | undefined,
  endISO: string | null | undefined,
  asOfISO: string,
): 'active' | 'expired' | 'future' | 'unknown' {
  const asOf = parseISODate(asOfISO)
  if (asOf == null) return 'unknown'
  const start = parseISODate(startISO)
  const end = parseISODate(endISO)
  if (start != null && asOf < start) return 'future'
  if (end != null && asOf > end) return 'expired'
  if (start != null || end != null) return 'active'
  return 'unknown'
}

// ── Money ────────────────────────────────────────────────────────────────────

/** Round to cents (money is stored as dollars in this repo). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Annualize monthly line items: sum the monthly amounts, then × 12. Non-finite
 * entries are treated as 0 (a missing line is not a NaN total).
 *
 * GOLDEN (service contract): 7641 + 5524 = 13165/mo → 157980/yr. The value
 * 158220 that appeared in the source is a hand-entry error the system must not
 * reproduce.
 */
export function annualizeMonthly(monthlyLines: number[]): { monthly: number; annual: number } {
  const monthly = round2(monthlyLines.reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0))
  return { monthly, annual: round2(monthly * 12) }
}

export interface TotalCheck {
  ok: boolean
  computed: number
  stated: number
  delta: number      // computed − stated
}

/**
 * Validate a stated total against the actual sum of its cells — catch spreadsheet
 * formula errors before they reach a dashboard.
 *
 * GOLDEN (Yard House): a 2026 total cell using `=D201:O201` returned only the
 * January value (~494,991.46) instead of the Jan–Jun sum (~3,831,672.61) — a
 * >$3.3M understatement a controlled import must flag rather than publish.
 */
export function validateColumnTotal(cells: number[], statedTotal: number, tolerance = 0.5): TotalCheck {
  const computed = round2(cells.reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0))
  const delta = round2(computed - statedTotal)
  return { ok: Math.abs(delta) <= tolerance, computed, stated: statedTotal, delta }
}

// ── Sales & occupancy cost ───────────────────────────────────────────────────

export type CoverageStatus = 'ok' | 'insufficient_coverage' | 'zero_sales'

export interface CoverageResult {
  ratio: number | null           // occupancy cost / sales (decimal), or null when not computable
  status: CoverageStatus
  monthsCovered: number
  monthsRequired: number
  missingMonths: number
  sales: number
  occupancyCost: number
  note: string
}

/**
 * Occupancy-cost ratio = occupancy cost / gross sales — but ONLY when the sales
 * period is fully covered. Missing months must NEVER be treated as a valid
 * denominator, and zero sales is a DIFFERENT state from missing sales.
 *
 * GOLDEN (Dave & Buster's): occupancy cost 853,153 was divided by only the
 * available Jun–Dec 2025 sales (2,596,475.95) and shown as a 32.9% trailing-12
 * ratio while Jan–May 2026 sales were absent — which can wrongly flag a healthy
 * tenant as distressed. With 7 of 12 months, this returns `insufficient_coverage`
 * and no ratio.
 */
export function occupancyCostRatio(input: {
  occupancyCost: number
  sales: number
  monthsCovered: number
  monthsRequired: number
}): CoverageResult {
  const { occupancyCost, sales, monthsCovered, monthsRequired } = input
  const missingMonths = Math.max(0, monthsRequired - monthsCovered)
  const base = { monthsCovered, monthsRequired, missingMonths, sales, occupancyCost }
  if (monthsCovered < monthsRequired) {
    return {
      ...base, ratio: null, status: 'insufficient_coverage',
      note: `Insufficient period coverage: ${monthsCovered} of ${monthsRequired} months of sales reported (${missingMonths} missing). Ratio not computed.`,
    }
  }
  // Full coverage but genuinely zero reported sales — a real state, not missing
  // data; the ratio is undefined, so disclose rather than divide.
  if (!(sales > 0)) {
    return { ...base, ratio: null, status: 'zero_sales', note: 'Full coverage but zero reported sales; occupancy-cost ratio is undefined.' }
  }
  return { ...base, ratio: occupancyCost / sales, status: 'ok', note: `${monthsCovered}-of-${monthsRequired}-month coverage.` }
}
