import { describe, it, expect } from 'vitest'
// Pure citation matcher, shared verbatim with the Deno edge verifier
// (supabase/functions/_shared/citation). Golden set for the audit's rule: a
// verbatim quote must be confirmable in its source THROUGH messy extraction
// (OCR spacing, line-break hyphenation, smart punctuation, accents), and a quote
// that isn't there must read "not confirmed", never sourced.
import { canonicalize, locateQuote, verifyCitation, MIN_CANON_LEN } from '../../../supabase/functions/_shared/citation'

// A representative source paragraph (as it might come out of extraction).
const SRC = `Section 29(b).  Landlord represents that Tenant's permitted use will
not violate the exclusive use rights of any other tenant of the Shopping Center
as of the date of this Lease.`

describe('canonicalize — collapses everything that OCR/typography perturbs', () => {
  it('folds case, punctuation, spacing, hyphenation, accents to one form', () => {
    expect(canonicalize('Non-Disturbance')).toBe('nondisturbance')
    expect(canonicalize('non disturbance')).toBe('nondisturbance')
    expect(canonicalize('non- disturbance')).toBe('nondisturbance')   // OCR line split
    expect(canonicalize('café')).toBe('cafe')                          // accent fold
    expect(canonicalize('  “Premises,”  ')).toBe('premises')           // smart quotes + spaces
    expect(canonicalize(null)).toBe('')
  })
})

describe('GOLDEN — a verbatim quote is confirmed through messy extraction', () => {
  const quote = "Tenant's permitted use will not violate the exclusive use rights of any other tenant"
  it('exact', () => {
    expect(verifyCitation({ quote, docText: SRC }).status).toBe('confirmed')
  })
  it('OCR-mangled spacing', () => {
    expect(verifyCitation({ quote: "Tenant s permitted   use  will not violate the exclusive use rights", docText: SRC }).status).toBe('confirmed')
  })
  it('line-break hyphenation', () => {
    expect(verifyCitation({ quote: 'not violate the exclu-\nsive use rights of any other tenant', docText: SRC }).status).toBe('confirmed')
  })
  it('smart quotes / dashes / punctuation differences', () => {
    expect(verifyCitation({ quote: '“Landlord represents that Tenant’s permitted use will not violate”', docText: SRC }).status).toBe('confirmed')
  })
})

describe('GOLDEN — unlocatable or unplaceable citations do not read as sourced', () => {
  it('a quote absent from the document is not_found ("citation not confirmed")', () => {
    const r = verifyCitation({ quote: 'Tenant shall pay percentage rent of six percent of gross sales', docText: SRC })
    expect(r.status).toBe('not_found')
    expect(r.found).toBe(false)
  })
  it('found in the document but not on the cited page → off_cited_page', () => {
    const r = verifyCitation({
      quote: "Tenant's permitted use will not violate the exclusive use rights of any other tenant",
      docText: SRC,
      pageText: 'This page contains entirely unrelated boilerplate and signature blocks only.',
    })
    expect(r.status).toBe('off_cited_page')
    expect(r.found).toBe(true)
    expect(r.onCitedPage).toBe(false)
  })
  it('confirmed on the cited page when the page text contains it', () => {
    expect(verifyCitation({
      quote: 'exclusive use rights of any other tenant of the Shopping Center',
      docText: SRC, pageText: SRC,
    }).status).toBe('confirmed')
  })
  it('a too-short quote cannot be confirmed (no trivial matches)', () => {
    expect(verifyCitation({ quote: 'Section 29(b)', docText: SRC }).status).toBe('quote_too_short')
    expect(locateQuote('Lease', SRC)).toBe(false)
  })
  it('a near-miss with different words is not confirmed', () => {
    // Same opening, but the operative clause is changed — must NOT confirm.
    expect(verifyCitation({ quote: 'Landlord represents that Tenant may operate a competing restaurant next door', docText: SRC }).status).toBe('not_found')
  })
})

describe('MIN_CANON_LEN guard', () => {
  it('is the alphanumeric floor for a verifiable quote', () => {
    expect(MIN_CANON_LEN).toBeGreaterThanOrEqual(12)
    expect(locateQuote('a b c', SRC)).toBe(false)           // 3 canon chars
    expect(locateQuote('of any other tenant of the Shopping Center', SRC)).toBe(true)
  })
})
