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

// citation_check is stamped by the deterministic citation validator in
// abstract-verify. Measured 2026-08-02: 210 field_checks read verdict='confirmed'
// while their "verbatim" quote could not be located in the sources (94 high
// severity), and the single abstract that reached 'verified' carried 11 such
// quotes. The rate is the same (20.5% vs 20.7%) whether or not the full source
// text fit the verifier's window, so truncation does not explain it.
describe('deriveStatus — CITATION INTEGRITY (a quote that cannot be found is not evidence)', () => {
  it('a HIGH-severity confirmation with an unlocatable quote is issues', () => {
    expect(deriveStatus({ ...clean, field_checks: [
      { field: 'term.expiration', verdict: 'confirmed', severity: 'high', source_quote: 'the Term shall expire', citation_check: 'not_found' },
    ] })).toBe('issues')
  })
  it('a medium/low confirmation with an unlocatable quote is review, not issues', () => {
    expect(deriveStatus({ ...clean, field_checks: [
      { field: 'suite', verdict: 'confirmed', severity: 'medium', citation_check: 'not_found' },
    ] })).toBe('review')
  })
  it('an unverifiably short quote holds the abstract in review', () => {
    expect(deriveStatus({ ...clean, field_checks: [
      { field: 'suite', verdict: 'confirmed', severity: 'low', citation_check: 'quote_too_short' },
    ] })).toBe('review')
  })
  it('never reaches verified while ANY cited quote is unlocatable, even at low severity', () => {
    expect(deriveStatus({ ...clean, field_checks: [
      { field: 'expiration', verdict: 'confirmed', severity: 'high', citation_check: 'confirmed' },
      { field: 'parking', verdict: 'confirmed', severity: 'low', citation_check: 'not_found' },
    ] })).toBe('review')
  })
  it('the real-world regression: the one abstract that went green on 11 unlocatable quotes', () => {
    // Every field confirmed, nothing else wrong — previously 'verified'.
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      field: `f${i}`, verdict: 'confirmed', severity: i < 3 ? 'high' : 'medium',
      source_quote: 'text that is not in the document', citation_check: 'not_found',
    }))
    expect(deriveStatus({ ...clean, field_checks: eleven })).toBe('issues')  // high-severity ones dominate
  })
  it('located citations do not degrade anything', () => {
    expect(deriveStatus({ ...clean, field_checks: [
      { field: 'expiration', verdict: 'confirmed', severity: 'high', citation_check: 'confirmed' },
    ] })).toBe('verified')
  })
  it('off_cited_page (found in the doc, wrong page) is not a fabrication and stays clean', () => {
    expect(deriveStatus({ ...clean, field_checks: [
      { field: 'expiration', verdict: 'confirmed', severity: 'high', citation_check: 'off_cited_page' },
    ] })).toBe('verified')
  })
})

describe('deriveStatus — VERIFIED (clean AND backed by evidence)', () => {
  it('a clean verdict with real field evidence is verified', () => {
    expect(deriveStatus(clean)).toBe('verified')
  })
  it('verdicts predating citation_check are unaffected (backward compatible)', () => {
    // 69 stored verdicts have no citation_check on some rows; absence must be inert.
    expect(deriveStatus({ ...clean, field_checks: [
      { field: 'expiration', verdict: 'confirmed', severity: 'high', source_quote: '...' },
    ] })).toBe('verified')
  })
})
