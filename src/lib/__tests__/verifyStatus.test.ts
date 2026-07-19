import { describe, it, expect } from 'vitest'
// Pure verifier status logic, shared verbatim with the Deno edge function
// `supabase/functions/abstract-verify`. These tests lock in the FAIL-CLOSED
// contract: a verdict the verifier didn't actually produce (empty/malformed/
// no field evidence) must never read as 'verified'. This is the regression
// guard for the audit's false-green finding (#1).
import { deriveStatus, hasFieldEvidence } from '../../../supabase/functions/_shared/verifyStatus'

// A minimal clean verdict: one examined field, confirmed, nothing wrong.
const clean = {
  field_checks: [{ field: 'expiration', verdict: 'confirmed', severity: 'high', source_quote: '...' }],
  arithmetic: [{ check: 'monthly*12 vs annual', ok: true, detail: '' }],
  amendment_currency: { current: true, note: '' },
  fabrication_risk: [],
}

describe('hasFieldEvidence — a verdict must carry real field evidence', () => {
  it('rejects non-objects and empties', () => {
    expect(hasFieldEvidence(null)).toBe(false)
    expect(hasFieldEvidence(undefined)).toBe(false)
    expect(hasFieldEvidence({})).toBe(false)
    expect(hasFieldEvidence([])).toBe(false)                       // array is not a verdict object
    expect(hasFieldEvidence('verified')).toBe(false)
    expect(hasFieldEvidence({ field_checks: [] })).toBe(false)     // examined nothing
    expect(hasFieldEvidence({ field_checks: 'oops' })).toBe(false) // malformed
  })
  it('accepts a verdict with at least one recognized-verdict field_check', () => {
    expect(hasFieldEvidence(clean)).toBe(true)
    expect(hasFieldEvidence({ field_checks: [{ field: 'x', verdict: 'confirmed' }] })).toBe(true)
  })
  it('rejects rows that carry no recognized verdict (review finding #3)', () => {
    expect(hasFieldEvidence({ field_checks: [{ field: 'rent' }] })).toBe(false)            // truncated: no verdict
    expect(hasFieldEvidence({ field_checks: [{ field: 'rent', verdict: 'mismatch' }] })).toBe(false) // off-vocabulary
    expect(hasFieldEvidence({ field_checks: [{ verdict: 'confirm' }] })).toBe(false)       // typo, not 'confirmed'
  })
})

describe('deriveStatus — FAIL CLOSED (never green without evidence)', () => {
  it('empty / null / malformed verdicts are NOT verified (the false-green fix)', () => {
    // Before the fix each of these fell through to 'verified'.
    expect(deriveStatus({})).toBe('issues')
    expect(deriveStatus(null)).toBe('issues')
    expect(deriveStatus(undefined)).toBe('issues')
    expect(deriveStatus([])).toBe('issues')
    expect(deriveStatus('verified')).toBe('issues')
    expect(deriveStatus({ field_checks: [] })).toBe('issues')       // examined nothing
    expect(deriveStatus({ field_checks: null })).toBe('issues')
    expect(deriveStatus({ notField: 1 })).toBe('issues')
  })
  it('field_checks with no/off-vocabulary verdicts are NOT verified (review finding #3)', () => {
    expect(deriveStatus({ ...clean, field_checks: [{ field: 'rent' }] })).toBe('issues')                 // no verdict
    expect(deriveStatus({ ...clean, field_checks: [{ field: 'rent', verdict: 'mismatch' }] })).toBe('issues') // off-vocabulary
    // one valid row + one uninterpretable row → still fails closed
    expect(deriveStatus({ ...clean, field_checks: [
      { field: 'expiration', verdict: 'confirmed', severity: 'high' },
      { field: 'rent' },
    ] })).toBe('issues')
  })
})

describe('deriveStatus — ISSUES (a human must fix before relying)', () => {
  it('flags a HIGH-severity discrepancy', () => {
    expect(deriveStatus({ ...clean, field_checks: [
      { field: 'expiration', verdict: 'discrepancy', severity: 'high' },
    ] })).toBe('issues')
  })
  it('flags a HIGH-severity unsupported value', () => {
    expect(deriveStatus({ ...clean, field_checks: [
      { field: 'exclusives', verdict: 'unsupported', severity: 'high' },
    ] })).toBe('issues')
  })
  it('flags failed arithmetic', () => {
    expect(deriveStatus({ ...clean, arithmetic: [{ check: 'x', ok: false, detail: 'contradiction' }] })).toBe('issues')
  })
  it('flags a stale (superseded-amendment) term', () => {
    expect(deriveStatus({ ...clean, amendment_currency: { current: false, note: 'Fourth Amendment extended term' } })).toBe('issues')
  })
})

describe('deriveStatus — REVIEW (softer flags worth a look)', () => {
  it('medium/low discrepancy is review, not issues', () => {
    expect(deriveStatus({ ...clean, field_checks: [
      { field: 'suite', verdict: 'discrepancy', severity: 'medium' },
    ] })).toBe('review')
  })
  it('needs_source is review', () => {
    expect(deriveStatus({ ...clean, field_checks: [
      { field: 'ti_allowance', verdict: 'needs_source', severity: 'low' },
    ] })).toBe('review')
  })
  it('fabrication_risk present (otherwise clean) is review', () => {
    expect(deriveStatus({ ...clean, fabrication_risk: ['base rent computed, not quoted'] })).toBe('review')
  })
})

describe('deriveStatus — VERIFIED (clean AND backed by evidence)', () => {
  it('a clean verdict with real field evidence is verified', () => {
    expect(deriveStatus(clean)).toBe('verified')
  })
})
