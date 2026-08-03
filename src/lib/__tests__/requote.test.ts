import { describe, it, expect } from 'vitest'
// Pure reject-and-re-quote logic, shared verbatim with the Deno edge function
// `supabase/functions/abstract-verify`. These tests lock in two contracts:
//   1. a re-quote is only ever attempted when the source corpus was COMPLETE, and
//   2. a confirmation that cannot produce a locatable quote is DOWNGRADED, never left
//      standing as 'confirmed' with an amber chip.
import { applyRequotes, selectForRequote } from '../../../supabase/functions/_shared/requote'

const complete = { corpus_complete: true, unsearchable_docs: 0 }
const incomplete = { corpus_complete: false, unsearchable_docs: 7 }

const qaWith = (checks: any[], summary: any = complete) =>
  ({ field_checks: checks, citation_summary: { located: 0, not_located: 0, too_short: 0, ...summary } })

const bad = (field: string, severity = 'high') => ({
  field, verdict: 'confirmed', severity, source_quote: 'text that is not in the document',
  citation: 'Lease Art. 1', citation_check: 'not_found',
})

describe('selectForRequote — only challenge what the validator could actually see', () => {
  it('selects confirmed + not_found checks when the corpus was complete', () => {
    const r = selectForRequote(qaWith([bad('term.expiration')]))
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ index: 0, field: 'term.expiration', severity: 'high' })
    expect(r[0].failed_quote).toContain('not in the document')
  })
  it('NEVER challenges when the corpus was incomplete (would invent findable text)', () => {
    expect(selectForRequote(qaWith([bad('term.expiration')], incomplete))).toEqual([])
  })
  it('ignores checks that are fine, or unlocatable for a non-confirmed verdict', () => {
    expect(selectForRequote(qaWith([
      { field: 'a', verdict: 'confirmed', source_quote: 'x', citation_check: 'confirmed' },
      { field: 'b', verdict: 'discrepancy', source_quote: 'y', citation_check: 'not_found' },
      { field: 'c', verdict: 'confirmed', source_quote: 'z', citation_check: 'quote_too_short' },
    ]))).toEqual([])
  })
  it('orders high severity first and honours the cap', () => {
    const r = selectForRequote(qaWith([bad('low1', 'low'), bad('hi', 'high'), bad('med', 'medium')]), 2)
    expect(r.map(x => x.field)).toEqual(['hi', 'med'])
  })
  it('is inert on malformed input', () => {
    expect(selectForRequote(null)).toEqual([])
    expect(selectForRequote({})).toEqual([])
    expect(selectForRequote({ field_checks: 'oops', citation_summary: complete })).toEqual([])
  })
})

describe('applyRequotes — FAIL CLOSED on anything still unlocatable', () => {
  const locate = (q: string) => q.includes('REAL')

  it('accepts a re-quote that validates, and keeps the verdict', () => {
    const qa = qaWith([bad('term.expiration')])
    const reqs = selectForRequote(qa)
    const out = applyRequotes(qa, reqs, [{ index: 0, action: 're_quote', source_quote: 'a REAL clause', citation: 'Amd 4 §2' }], locate)
    expect(out).toMatchObject({ attempted: 1, re_quoted: 1, withdrawn: 0, failed: 0 })
    const c = qa.field_checks[0]
    expect(c.verdict).toBe('confirmed')
    expect(c.source_quote).toBe('a REAL clause')
    expect(c.citation).toBe('Amd 4 §2')
    expect(c.citation_check).toBe('confirmed')
    expect(c.requote).toBe('re_quoted')
  })

  it('DOWNGRADES a re-quote that still cannot be located', () => {
    const qa = qaWith([bad('base_rent_schedule')])
    const out = applyRequotes(qa, selectForRequote(qa), [{ index: 0, action: 're_quote', source_quote: 'still invented' }], locate)
    expect(out).toMatchObject({ re_quoted: 0, failed: 1 })
    const c = qa.field_checks[0]
    expect(c.verdict).toBe('needs_source')
    expect(c.source_quote).toBe('')
    expect(c.requote).toBe('failed')
    expect(c.note).toMatch(/DOWNGRADED/)
  })

  it('records a withdrawal and clears the quote', () => {
    const qa = qaWith([bad('guarantor')])
    const out = applyRequotes(qa, selectForRequote(qa), [{ index: 0, action: 'withdraw' }], locate)
    expect(out).toMatchObject({ withdrawn: 1, failed: 0 })
    expect(qa.field_checks[0].verdict).toBe('needs_source')
    expect(qa.field_checks[0].requote).toBe('withdrawn')
    expect(qa.field_checks[0].note).toMatch(/WITHDRAWN/)
  })

  it('an absent answer fails closed rather than leaving the confirmation standing', () => {
    const qa = qaWith([bad('cam')])
    const out = applyRequotes(qa, selectForRequote(qa), [], locate)
    expect(out).toMatchObject({ attempted: 1, failed: 1 })
    expect(qa.field_checks[0].verdict).toBe('needs_source')
  })

  it('matches answers by field name when the model omits the index', () => {
    const qa = qaWith([bad('suite')])
    const out = applyRequotes(qa, selectForRequote(qa), [{ field: 'suite', action: 're_quote', source_quote: 'the REAL suite clause' }], locate)
    expect(out.re_quoted).toBe(1)
    expect(qa.field_checks[0].citation_check).toBe('confirmed')
  })

  it('an empty re_quote string is treated as a failure, not a pass', () => {
    const qa = qaWith([bad('insurance')])
    const out = applyRequotes(qa, selectForRequote(qa), [{ index: 0, action: 're_quote', source_quote: '   ' }], locate)
    expect(out.failed).toBe(1)
    expect(qa.field_checks[0].verdict).toBe('needs_source')
  })

  it('preserves an existing note instead of clobbering it', () => {
    const qa = qaWith([{ ...bad('term.expiration'), note: 'MRI holds 2031-01-31' }])
    applyRequotes(qa, selectForRequote(qa), [{ index: 0, action: 'withdraw' }], locate)
    expect(qa.field_checks[0].note).toMatch(/^MRI holds 2031-01-31 \[/)
  })

  it('leaves untouched every check that was not challenged', () => {
    const good = { field: 'ok', verdict: 'confirmed', source_quote: 'a REAL thing', citation_check: 'confirmed' }
    const qa = qaWith([good, bad('bad')])
    applyRequotes(qa, selectForRequote(qa), [{ index: 1, action: 'withdraw' }], locate)
    expect(qa.field_checks[0]).toEqual(good)
  })
})
