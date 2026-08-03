// _shared/requote.ts — pure decision logic for the citation reject-and-re-quote round.
// NO imports (Deno OR Node): imported by the Deno edge function `abstract-verify` AND
// by a Vitest unit test in src/, so it must stay runtime-agnostic.
//
// WHY THIS EXISTS. Citation validation used to end at annotation: a field_check could say
// verdict='confirmed' while its "verbatim" quote appeared nowhere in the sources, and the
// worst that happened was an amber chip. Measured 2026-08-03 after the prompt fix, 5.6%
// of quotes were still unlocatable, and the residual split cleanly:
//
//   corpus_complete=TRUE  (18 abstracts) - the FULL text of every source was searched and
//                         the quote is not in it. The confirmation is unsupported. OCR was
//                         tested and ruled out (zero unreadable pages; these abstracts
//                         average HIGHER text density than clean ones).
//   corpus_complete=FALSE (12 abstracts) - 239 source docs, 96 unbriefed, 584k chars past
//                         the text budget. The quote may sit in a document the validator
//                         could not read.
//
// ⚠️⚠️ THE ASYMMETRY IS THE WHOLE DESIGN. Re-quoting is only sound when the corpus was
// COMPLETE. On an incomplete corpus, telling a model "your quote could not be found, supply
// one that can" is an instruction to invent something findable — it would manufacture
// false precision out of a gap in OUR data, not the model's. So an incomplete corpus is
// never re-quoted; those findings stay soft and wait for the missing briefs.

export interface FieldCheck {
  field?: string
  verdict?: string
  source_quote?: string
  citation?: string
  severity?: string
  note?: string
  citation_check?: string
  requote?: string          // stamped by applyRequotes: 're_quoted' | 'withdrawn' | 'failed'
}

export interface RequoteRequest {
  index: number             // position in qa.field_checks, so the answer can be merged back
  field: string
  severity: string
  failed_quote: string
  citation: string
}

export interface RequoteAnswer {
  index?: number
  field?: string
  action?: string           // 're_quote' | 'withdraw'
  source_quote?: string
  citation?: string
  note?: string
}

// A confirmation is only worth challenging when the validator could actually see
// everything. Ordered by severity so a cap spends the budget on the money fields first.
export function selectForRequote(qa: any, cap = 12): RequoteRequest[] {
  if (!qa || typeof qa !== 'object' || !Array.isArray(qa.field_checks)) return []
  if (qa.citation_summary?.corpus_complete !== true) return []      // see the asymmetry note
  const rank = (s?: string) => (s === 'high' ? 0 : s === 'medium' ? 1 : 2)
  return (qa.field_checks as FieldCheck[])
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c?.verdict === 'confirmed' && c?.citation_check === 'not_found')
    .sort((a, b) => rank(a.c.severity) - rank(b.c.severity))
    .slice(0, Math.max(0, cap))
    .map(({ c, index }) => ({
      index,
      field: String(c.field ?? ''),
      severity: String(c.severity ?? ''),
      failed_quote: String(c.source_quote ?? ''),
      citation: String(c.citation ?? ''),
    }))
}

export interface RequoteOutcome {
  attempted: number
  re_quoted: number         // model supplied a quote that DID validate
  withdrawn: number         // model withdrew the confirmation itself
  failed: number            // model tried again and still could not be located
}

/**
 * Merge the re-quote answers back into the verdict. `locate` is the citation validator
 * (quote -> true when it can be found in the source corpus).
 *
 * FAIL CLOSED, and that is the "reject" half of reject-and-re-quote: any confirmation
 * whose quote cannot be located after a second chance is DOWNGRADED to needs_source with
 * its quote cleared. Leaving it as 'confirmed' with an amber chip is what let 210 checks
 * read as sourced while their evidence did not exist.
 */
export function applyRequotes(
  qa: any,
  requests: RequoteRequest[],
  answers: RequoteAnswer[],
  locate: (quote: string) => boolean,
): RequoteOutcome {
  const out: RequoteOutcome = { attempted: requests.length, re_quoted: 0, withdrawn: 0, failed: 0 }
  if (!qa || !Array.isArray(qa.field_checks) || !requests.length) return out
  const checks = qa.field_checks as FieldCheck[]

  // Index answers by position first, falling back to field name — a model may echo one or
  // the other, and matching on field alone would cross-apply when a field repeats.
  const byIndex = new Map<number, RequoteAnswer>()
  const byField = new Map<string, RequoteAnswer>()
  for (const a of Array.isArray(answers) ? answers : []) {
    if (typeof a?.index === 'number') byIndex.set(a.index, a)
    if (a?.field) byField.set(String(a.field), a)
  }

  for (const req of requests) {
    const c = checks[req.index]
    if (!c) continue
    const ans = byIndex.get(req.index) ?? byField.get(req.field)
    const quote = typeof ans?.source_quote === 'string' ? ans.source_quote.trim() : ''

    if (ans?.action === 're_quote' && quote && locate(quote)) {
      c.source_quote = quote
      if (typeof ans.citation === 'string' && ans.citation.trim()) c.citation = ans.citation
      c.citation_check = 'confirmed'
      c.requote = 're_quoted'
      c.note = appendNote(c.note, 'Quote replaced on re-quote; the first quote could not be located in the sources.')
      out.re_quoted++
      continue
    }

    // Withdrawn, or re-quoted and STILL not locatable: the confirmation does not stand.
    const withdrew = ans?.action === 'withdraw'
    c.verdict = 'needs_source'
    c.source_quote = ''
    c.citation_check = 'not_found'
    c.requote = withdrew ? 'withdrawn' : 'failed'
    c.note = appendNote(
      c.note,
      withdrew
        ? 'Confirmation WITHDRAWN by the verifier on challenge - it could not produce a locatable quote.'
        : 'Confirmation DOWNGRADED: given a second chance, no quote for this field could be located in the sources.')
    if (withdrew) out.withdrawn++; else out.failed++
  }
  return out
}

function appendNote(existing: string | undefined, add: string): string {
  const base = typeof existing === 'string' && existing.trim() ? existing.trim() : ''
  return base ? `${base} [${add}]` : add
}
