import { describe, it, expect } from 'vitest'
// Pure recurrence engine, shared with the Deno edge generator
// (supabase/functions/_shared/recurrence). Locks in the date math (next
// occurrence on/after an explicit as-of date, UTC, day-clamped) and the
// CONSERVATIVE prose parser (never fabricates a date from an underspecified rule).
import { nextOccurrence, parseRecurrence, type RecurrenceSpec } from '../../../supabase/functions/_shared/recurrence'

describe('nextOccurrence — next due date on/after the as-of date (UTC)', () => {
  it('monthly: this month if the day is still ahead, else next month', () => {
    expect(nextOccurrence({ frequency: 'monthly', dayOfMonth: 15 }, '2026-07-01')).toBe('2026-07-15')
    expect(nextOccurrence({ frequency: 'monthly', dayOfMonth: 15 }, '2026-07-15')).toBe('2026-07-15') // inclusive
    expect(nextOccurrence({ frequency: 'monthly', dayOfMonth: 15 }, '2026-07-20')).toBe('2026-08-15')
  })
  it('monthly: day clamps to the month length (31 -> Feb 28)', () => {
    expect(nextOccurrence({ frequency: 'monthly', dayOfMonth: 31 }, '2026-02-05')).toBe('2026-02-28')
  })
  it('quarterly: steps 3 months from the anchor month', () => {
    // Anchor Feb -> Feb, May, Aug, Nov.
    expect(nextOccurrence({ frequency: 'quarterly', month: 2, dayOfMonth: 1 }, '2026-02-01')).toBe('2026-02-01')
    expect(nextOccurrence({ frequency: 'quarterly', month: 2, dayOfMonth: 1 }, '2026-03-01')).toBe('2026-05-01')
    expect(nextOccurrence({ frequency: 'quarterly', month: 2, dayOfMonth: 1 }, '2026-12-01')).toBe('2027-02-01')
  })
  it('annual: the anchor month/day this year or next', () => {
    expect(nextOccurrence({ frequency: 'annual', month: 6, dayOfMonth: 30 }, '2026-01-01')).toBe('2026-06-30')
    expect(nextOccurrence({ frequency: 'annual', month: 6, dayOfMonth: 30 }, '2026-07-01')).toBe('2027-06-30')
  })
  it('returns null on an insufficient spec', () => {
    expect(nextOccurrence(null, '2026-01-01')).toBeNull()
    expect(nextOccurrence({ frequency: 'monthly', dayOfMonth: 40 }, '2026-01-01')).toBeNull()   // bad day
    expect(nextOccurrence({ frequency: 'annual', dayOfMonth: 15 }, '2026-01-01')).toBeNull()    // annual w/o anchor month
    expect(nextOccurrence({ frequency: 'monthly', dayOfMonth: 15 }, 'not-a-date')).toBeNull()
  })
})

describe('parseRecurrence — parses the clear rules, refuses the underspecified', () => {
  it('parses "Nth of each month"', () => {
    expect(parseRecurrence('monthly', '15th of each month')).toEqual({ frequency: 'monthly', dayOfMonth: 15, month: undefined })
  })
  it('parses a quarterly rule with a named anchor month (year is not a day)', () => {
    expect(parseRecurrence('quarterly', 'Feb 2015 and every third month thereafter')).toEqual({ frequency: 'quarterly', dayOfMonth: 1, month: 2 })
  })
  it('parses "<Month> <day>" annual rules', () => {
    expect(parseRecurrence('annual', 'due each year on March 15')).toEqual({ frequency: 'annual', dayOfMonth: 15, month: 3 })
  })
  it('REFUSES underspecified rules (no fabricated date)', () => {
    expect(parseRecurrence('annual', 'within 90 days of agreement; annually thereafter')).toBeNull()  // anchor-relative, no month
    expect(parseRecurrence('monthly', 'per owner-provided annual schedule')).toBeNull()               // monthly, no day
    expect(parseRecurrence(null, 'sometime')).toBeNull()                                              // no frequency
  })
  it('prose frequency: "every third month" reads as quarterly, not monthly', () => {
    const spec = parseRecurrence(null, 'on the 10th, Jan and every third month thereafter')
    expect(spec?.frequency).toBe('quarterly')
    expect(spec?.month).toBe(1)
    expect(spec?.dayOfMonth).toBe(10)
  })
})

describe('end-to-end: parse then compute', () => {
  it('"15th of each month" as of mid-month rolls to next month', () => {
    const spec = parseRecurrence('monthly', 'report due the 15th of each month') as RecurrenceSpec
    expect(nextOccurrence(spec, '2026-07-16')).toBe('2026-08-15')
  })
})
