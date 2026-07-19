import { describe, it, expect } from 'vitest'
import {
  parseISODate, formatISODate, addDays, daysBetween,
  optionNoticeDeadline, termStatus,
  annualizeMonthly, validateColumnTotal, occupancyCostRatio,
} from '../leaseMath'

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN SET — the audit's VALIDATED-ACCEPTANCE-TESTS as permanent regressions.
// Each of these encodes a value the review found WRONG in the live app; the
// deterministic library must produce the RIGHT one and never drift back.
// ─────────────────────────────────────────────────────────────────────────────

describe('GOLDEN — Starbucks option-notice deadline', () => {
  it('270 days before 2031-07-31 is 2030-11-03', () => {
    const r = optionNoticeDeadline('2031-07-31', 270)
    expect(r.deadline).toBe('2030-11-03')
  })
  it('is NEITHER of the two wrong values the app/specialist held', () => {
    const r = optionNoticeDeadline('2031-07-31', 270)
    expect(r.deadline).not.toBe('2030-10-05')   // stored value — wrong
    expect(r.deadline).not.toBe('2030-11-04')   // specialist proposal — wrong
  })
  it('the window is exactly 270 days wide', () => {
    expect(daysBetween('2030-11-03', '2031-07-31')).toBe(270)
  })
  it('fails closed on a missing/malformed reference date', () => {
    expect(optionNoticeDeadline(null, 270).deadline).toBeNull()
    expect(optionNoticeDeadline('2031-13-01', 270).deadline).toBeNull()
    expect(optionNoticeDeadline('2031-07-31', -5).deadline).toBeNull()
  })
})

describe('GOLDEN — service-contract annualization', () => {
  it('7641 + 5524 = 13165/mo → 157980/yr (not 158220)', () => {
    const { monthly, annual } = annualizeMonthly([7641, 5524])
    expect(monthly).toBe(13165)
    expect(annual).toBe(157980)
    expect(annual).not.toBe(158220)   // the hand-entry error the system must not reproduce
  })
})

describe('GOLDEN — Yard House workbook total validation', () => {
  // A `=D201:O201` cell returned only January (494,991.46) instead of the
  // Jan–Jun sum (3,831,672.61). Jan is real; the other five are representative
  // values chosen to sum to the audited total — the point is the shape:
  // stated-total == first-cell-only must be flagged.
  const months = [494991.46, 601000, 655000, 700000, 680681.15, 700000]  // sums to 3,831,672.61
  it('flags a stated total that equals only the first month', () => {
    const check = validateColumnTotal(months, 494991.46)
    expect(check.ok).toBe(false)
    expect(check.computed).toBeCloseTo(3831672.61, 2)   // to the cent (avoid float-equality footgun)
    expect(check.delta).toBeCloseTo(3336681.15, 2)
  })
  it('passes when the stated total matches the sum', () => {
    expect(validateColumnTotal(months, 3831672.61).ok).toBe(true)
  })
})

describe("GOLDEN — Dave & Buster's occupancy-cost coverage", () => {
  it('7 of 12 months → insufficient coverage, NO 32.9% ratio', () => {
    const r = occupancyCostRatio({ occupancyCost: 853153, sales: 2596475.95, monthsCovered: 7, monthsRequired: 12 })
    expect(r.status).toBe('insufficient_coverage')
    expect(r.ratio).toBeNull()
    expect(r.missingMonths).toBe(5)
  })
  it('the naive (wrong) ratio it replaced would have been ~32.9%', () => {
    // Documents what the app showed: 853153 / 2596475.95 ≈ 0.3286. We compute it
    // here only to prove our function refuses to report it.
    expect(853153 / 2596475.95).toBeCloseTo(0.329, 3)
    expect(occupancyCostRatio({ occupancyCost: 853153, sales: 2596475.95, monthsCovered: 7, monthsRequired: 12 }).ratio).toBeNull()
  })
  it('computes the ratio only with full coverage', () => {
    const r = occupancyCostRatio({ occupancyCost: 853153, sales: 4400000, monthsCovered: 12, monthsRequired: 12 })
    expect(r.status).toBe('ok')
    expect(r.ratio).toBeCloseTo(853153 / 4400000, 6)
  })
  it('distinguishes ZERO sales from MISSING sales', () => {
    const zero = occupancyCostRatio({ occupancyCost: 100000, sales: 0, monthsCovered: 12, monthsRequired: 12 })
    expect(zero.status).toBe('zero_sales')
    expect(zero.ratio).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Unit coverage for the primitives the golden cases rest on.
// ─────────────────────────────────────────────────────────────────────────────

describe('date primitives (UTC, no timezone drift)', () => {
  it('parses and rejects', () => {
    expect(parseISODate('2031-07-31')).toBe(Date.UTC(2031, 6, 31))
    expect(parseISODate('2025-02-30')).toBeNull()   // calendar overflow
    expect(parseISODate('not-a-date')).toBeNull()
    expect(parseISODate(null)).toBeNull()
    expect(parseISODate('2031-7-31')).toBeNull()     // must be zero-padded
  })
  it('round-trips format', () => {
    expect(formatISODate(Date.UTC(2030, 10, 3))).toBe('2030-11-03')
  })
  it('adds/subtracts calendar days across a leap boundary', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')   // 2028 is a leap year
    expect(addDays('2029-03-01', -1)).toBe('2029-02-28')  // 2029 is not
    expect(addDays('2031-07-31', -270)).toBe('2030-11-03')
    expect(addDays(null, 5)).toBeNull()
  })
})

describe('termStatus (explicit as-of, never the wall clock)', () => {
  it('classifies active / expired / future', () => {
    expect(termStatus('2026-08-01', '2031-07-31', '2028-01-01')).toBe('active')
    expect(termStatus('2020-01-01', '2025-12-31', '2026-07-19')).toBe('expired')
    expect(termStatus('2027-01-01', '2032-01-01', '2026-07-19')).toBe('future')
  })
  it('unknown when it cannot be determined', () => {
    expect(termStatus(null, null, '2026-07-19')).toBe('unknown')
    expect(termStatus('2026-01-01', '2031-01-01', 'bad')).toBe('unknown')
  })
})
