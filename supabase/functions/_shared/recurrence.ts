// _shared/recurrence.ts — pure recurrence engine. NO imports (Deno OR Node):
// imported by a Deno edge generator AND a Vitest test in src/, so runtime-agnostic.
//
// Two pieces, both deterministic:
//   nextOccurrence(spec, asOf) — the NEXT concrete due date on/after an EXPLICIT
//     as-of date (never the wall clock). UTC-only (a due date is a calendar day).
//   parseRecurrence(frequency, dueRule) — a CONSERVATIVE parser of the common
//     prose due-rules ("15th of each month", "Feb ... every third month"). It
//     returns null when a rule is underspecified (e.g. "within 90 days of
//     agreement", "per owner-provided schedule") rather than fabricate a date —
//     the generator then emits an informational (dateless) obligation instead.

const ISO = /^\d{4}-\d{2}-\d{2}$/
function parseISO(s: string | null | undefined): number | null {
  if (!s || !ISO.test(s)) return null
  const [y, m, d] = s.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d)
  const b = new Date(t)
  return (b.getUTCFullYear() === y && b.getUTCMonth() === m - 1 && b.getUTCDate() === d) ? t : null
}
function fmt(t: number): string {
  const d = new Date(t)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
function daysInMonth(y: number, m0: number): number { return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate() }
function makeDate(y: number, m0: number, day: number): number { return Date.UTC(y, m0, Math.min(day, daysInMonth(y, m0))) }  // clamp (31 -> Feb 28/29)

export type Frequency = 'monthly' | 'quarterly' | 'semiannual' | 'annual'
export interface RecurrenceSpec {
  frequency: Frequency
  dayOfMonth?: number   // 1-31 (clamped to month length); defaults to 1
  month?: number        // 1-12 anchor month for the cycle (required for non-monthly)
}
const STEP: Record<Frequency, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 }

/** Earliest occurrence date (ISO) on/after `asOfISO`, or null if the spec is insufficient. */
export function nextOccurrence(spec: RecurrenceSpec | null | undefined, asOfISO: string): string | null {
  const asOf = parseISO(asOfISO)
  if (asOf == null || !spec) return null
  const step = STEP[spec.frequency]
  if (!step) return null
  const day = spec.dayOfMonth ?? 1
  if (!(day >= 1 && day <= 31)) return null
  const a = new Date(asOf)
  // Cycle phase: for monthly every month hosts; otherwise months congruent to the
  // anchor month (mod the step) host an occurrence.
  const phase = spec.frequency === 'monthly' ? 0 : ((spec.month ?? 0) - 1)
  if (spec.frequency !== 'monthly' && !(phase >= 0 && phase <= 11)) return null
  for (let i = 0; i <= 13; i++) {
    const idx = a.getUTCMonth() + i
    const y = a.getUTCFullYear() + Math.floor(idx / 12)
    const mm = ((idx % 12) + 12) % 12
    const hosts = spec.frequency === 'monthly' || ((mm - phase + 12) % 12) % step === 0
    if (!hosts) continue
    const cand = makeDate(y, mm, day)
    if (cand >= asOf) return fmt(cand)
  }
  return null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function normalizeFrequency(frequency: string | null | undefined, dueRule: string | null | undefined): Frequency | null {
  const f = (frequency ?? '').toLowerCase().trim()
  if (f === 'monthly') return 'monthly'
  if (f === 'quarterly') return 'quarterly'
  if (f === 'semiannual' || f === 'semi-annual' || f === 'semi_annual') return 'semiannual'
  if (f === 'annual' || f === 'annually' || f === 'yearly') return 'annual'
  // Fall back to the prose. Check the longer cycles before "month" so
  // "every third month" reads as quarterly, not monthly.
  const s = (dueRule ?? '').toLowerCase()
  if (/quarter|every\s+(third|3rd|3)\s+month/.test(s)) return 'quarterly'
  if (/semi.?annual|every\s+(sixth|6th|6)\s+month/.test(s)) return 'semiannual'
  if (/annual|yearly|per\s+year|each\s+year/.test(s)) return 'annual'
  if (/month/.test(s)) return 'monthly'
  return null
}

/**
 * Best-effort parse of a management-agreement deadline into a RecurrenceSpec, or
 * null when it cannot be placed concretely (no day for a monthly rule; no anchor
 * month for a longer cycle; an anchor-relative or external-schedule rule). Never
 * guesses a date.
 */
export function parseRecurrence(frequency: string | null | undefined, dueRule: string | null | undefined): RecurrenceSpec | null {
  const freq = normalizeFrequency(frequency, dueRule)
  if (!freq) return null
  const rule = (dueRule ?? '').toLowerCase()

  // Day: an ordinal ("15th"), an explicit "day N", or a day trailing a month
  // name ("March 15"). The \b after (\d{1,2}) makes a 4-digit YEAR ("Feb 2015")
  // fail to match, so a year is never mistaken for a day.
  let dayOfMonth: number | undefined
  const dRaw =
    rule.match(/\b(\d{1,2})\s*(?:st|nd|rd|th)\b/)?.[1] ??
    rule.match(/\bday\s+(\d{1,2})\b/)?.[1] ??
    rule.match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/)?.[1]
  if (dRaw) { const n = Number(dRaw); if (n >= 1 && n <= 31) dayOfMonth = n }

  let month: number | undefined
  const mn = rule.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/)
  if (mn) month = MONTHS.indexOf(mn[1]) + 1

  // Monthly needs a day to place it; a longer cycle needs an anchor month.
  if (freq === 'monthly' && dayOfMonth == null) return null
  if (freq !== 'monthly' && month == null) return null
  return { frequency: freq, dayOfMonth: dayOfMonth ?? 1, month }
}
