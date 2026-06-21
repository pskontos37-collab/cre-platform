import { describe, it, expect } from 'vitest'
import {
  computeNOI,
  computeDSCR,
  computeDSCRHeadroom,
  computeWALT,
  computePhysicalOccupancy,
  computeTrailing12NOI,
} from '../financials'
import type { LineItem } from '../financials'

// ── NOI ────────────────────────────────────────────────────────────────────

describe('computeNOI', () => {
  const lines: LineItem[] = [
    { category: 'base_rent',            amount: 500_000 },
    { category: 'cam_recovery',         amount:  80_000 },
    { category: 'other_income',         amount:  20_000 },
    { category: 'management_fee',       amount:  30_000 },
    { category: 'taxes',                amount:  60_000 },
    { category: 'insurance',            amount:  15_000 },
    { category: 'repairs_maintenance',  amount:  25_000 },
  ]

  it('sums income and expense categories correctly', () => {
    const { totalIncome, totalExpenses, noi } = computeNOI(lines)
    expect(totalIncome).toBe(600_000)
    expect(totalExpenses).toBe(130_000)
    expect(noi).toBe(470_000)
  })

  it('excludes capital_expenditure from NOI', () => {
    const withCapex: LineItem[] = [...lines, { category: 'capital_expenditure', amount: 50_000 }]
    const { totalExpenses, noi } = computeNOI(withCapex)
    expect(totalExpenses).toBe(130_000)
    expect(noi).toBe(470_000)
  })

  it('returns zero NOI for empty input', () => {
    expect(computeNOI([]).noi).toBe(0)
  })

  it('aggregates multiple lines of the same category', () => {
    const dupes: LineItem[] = [
      { category: 'base_rent', amount: 200_000 },
      { category: 'base_rent', amount: 300_000 },
    ]
    const { byCategory } = computeNOI(dupes)
    expect(byCategory.base_rent).toBe(500_000)
  })
})

// ── DSCR ───────────────────────────────────────────────────────────────────

describe('computeDSCR', () => {
  it('computes DSCR correctly', () => {
    expect(computeDSCR(470_000, 350_000)).toBeCloseTo(1.3429, 3)
  })

  it('returns null when annual debt service is zero', () => {
    expect(computeDSCR(470_000, 0)).toBeNull()
  })

  it('returns a value below 1 when NOI is less than debt service', () => {
    expect(computeDSCR(300_000, 350_000)).toBeLessThan(1)
  })
})

describe('computeDSCRHeadroom', () => {
  it('flags a breach when DSCR is below covenant', () => {
    const { dscr, headroom, isBreach } = computeDSCRHeadroom(200_000, 350_000, 1.20)
    expect(dscr).toBeCloseTo(0.5714, 3)
    expect(isBreach).toBe(true)
    expect(headroom).toBeLessThan(0)
  })

  it('reports no breach when DSCR is above covenant', () => {
    const { isBreach, headroom } = computeDSCRHeadroom(470_000, 350_000, 1.20)
    expect(isBreach).toBe(false)
    expect(headroom).toBeGreaterThan(0)
  })

  it('flags breach exactly at the covenant threshold', () => {
    // exactly 1.20 — should NOT breach (headroom = 0)
    const noi = 1.20 * 350_000
    const { isBreach } = computeDSCRHeadroom(noi, 350_000, 1.20)
    expect(isBreach).toBe(false)
  })
})

// ── WALT ───────────────────────────────────────────────────────────────────

describe('computeWALT', () => {
  it('computes weighted average lease term correctly', () => {
    const asOf = new Date('2024-01-01')
    const leases = [
      { leasedSf: 10_000, expirationDate: '2026-01-01' }, // ~2 years
      { leasedSf:  5_000, expirationDate: '2027-01-01' }, // ~3 years
    ]
    // WALT = (10000×2 + 5000×3) / 15000 = 35000/15000 ≈ 2.333
    expect(computeWALT(leases, asOf)).toBeCloseTo(2.333, 1)
  })

  it('returns 0 for an empty lease list', () => {
    expect(computeWALT([])).toBe(0)
  })

  it('clamps expired leases to zero remaining term', () => {
    const asOf = new Date('2025-01-01')
    const leases = [{ leasedSf: 10_000, expirationDate: '2020-01-01' }]
    expect(computeWALT(leases, asOf)).toBe(0)
  })

  it('weights by SF, not by lease count', () => {
    const asOf = new Date('2024-01-01')
    const leases = [
      { leasedSf: 1_000, expirationDate: '2025-01-01' }, // 1 year, small
      { leasedSf: 9_000, expirationDate: '2034-01-01' }, // 10 years, large
    ]
    // WALT = (1000×1 + 9000×10) / 10000 = 91000/10000 = 9.1
    expect(computeWALT(leases, asOf)).toBeCloseTo(9.1, 0)
  })
})

// ── Occupancy ──────────────────────────────────────────────────────────────

describe('computePhysicalOccupancy', () => {
  it('returns correct occupancy ratio', () => {
    expect(computePhysicalOccupancy(75_000, 100_000)).toBeCloseTo(0.75)
  })

  it('returns 1.0 when fully occupied', () => {
    expect(computePhysicalOccupancy(100_000, 100_000)).toBe(1)
  })

  it('returns 0 when total leasable SF is 0', () => {
    expect(computePhysicalOccupancy(0, 0)).toBe(0)
  })
})

// ── Trailing-12 ────────────────────────────────────────────────────────────

describe('computeTrailing12NOI', () => {
  const makeMonth = (baseRent: number) => ({
    isActual: true,
    lineItems: [{ category: 'base_rent' as const, amount: baseRent }],
  })

  it('sums the 12 most recent actual periods', () => {
    const periods = Array.from({ length: 12 }, () => makeMonth(10_000))
    expect(computeTrailing12NOI(periods)).toBe(120_000)
  })

  it('uses only the last 12 when more periods are supplied', () => {
    const old = Array.from({ length: 6 }, () => makeMonth(5_000))
    const recent = Array.from({ length: 12 }, () => makeMonth(10_000))
    expect(computeTrailing12NOI([...old, ...recent])).toBe(120_000)
  })

  it('skips budget periods', () => {
    const periods = [
      { isActual: false, lineItems: [{ category: 'base_rent' as const, amount: 999_999 }] },
      ...Array.from({ length: 12 }, () => makeMonth(10_000)),
    ]
    expect(computeTrailing12NOI(periods)).toBe(120_000)
  })
})
