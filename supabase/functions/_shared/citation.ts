// _shared/citation.ts — pure citation VALIDATION. NO imports (Deno OR Node): it
// is imported by the Deno edge verifier AND by a Vitest unit test in src/, so it
// must stay runtime-agnostic.
//
// The audit's rule: every material quote must be programmatically confirmed to
// appear in the cited source, tolerant of OCR spacing, punctuation, and
// hyphenation; a quote that cannot be located is "citation not confirmed", NOT
// shown as sourced. Models are told to quote verbatim — this catches the ones
// that paraphrase or fabricate a citation.
//
// Strategy: reduce BOTH the quote and the source to a canonical form — accent-
// folded, lowercased, with ALL separators removed (spaces, punctuation, hyphens,
// newlines). That makes OCR spacing, line-break hyphenation ("obliga-\ntion"),
// smart quotes/dashes, and punctuation differences all vanish, so a genuine quote
// matches its source even through messy extraction. A minimum canonical length
// guards against trivially-short strings "confirming" against anything.

// Minimum canonical (alphanumeric) length for a quote to be verifiable — ~4-5
// words. Below this, a substring match is not meaningful evidence.
export const MIN_CANON_LEN = 20

// Combining diacritical marks block (U+0300..U+036F): what NFKD splits an accent
// into. Written as escapes so the source stays plain ASCII / unambiguous.
const COMBINING_MARKS = /[̀-ͯ]/g

/**
 * Canonical match form: NFKD (decompose accents) -> strip combining marks ->
 * lowercase -> drop everything that is not [a-z0-9]. "Non-Disturbance",
 * "non-disturbance", "non disturbance", and "non- disturbance" (OCR line split)
 * all become "nondisturbance"; "café" -> "cafe".
 */
export function canonicalize(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')        // drop ALL separators/punctuation -> OCR/hyphenation/spacing tolerant
}

/** Is `quote` present in `sourceText` under canonical matching? (min-length gated.) */
export function locateQuote(quote: string | null | undefined, sourceText: string | null | undefined): boolean {
  const q = canonicalize(quote)
  if (q.length < MIN_CANON_LEN) return false
  return canonicalize(sourceText).includes(q)
}

export type CitationStatus =
  | 'confirmed'        // found on the cited page (or anywhere in the doc when no page given)
  | 'off_cited_page'   // found in the document, but not on the cited page
  | 'not_found'        // not in the document at all -> "citation not confirmed"
  | 'quote_too_short'  // quote too short to verify meaningfully

export interface CitationResult {
  status: CitationStatus
  found: boolean               // present anywhere in the document
  onCitedPage: boolean | null  // null when no page text was supplied
}

/**
 * Verify a quote against its source. Pass `pageText` (the cited page's text) when
 * a page is cited to confirm page-level placement; omit it to confirm presence
 * anywhere in the document.
 */
export function verifyCitation(input: {
  quote: string | null | undefined
  docText: string | null | undefined
  pageText?: string | null
}): CitationResult {
  const q = canonicalize(input.quote)
  if (q.length < MIN_CANON_LEN) return { status: 'quote_too_short', found: false, onCitedPage: null }
  const inDoc = canonicalize(input.docText).includes(q)
  if (!inDoc) return { status: 'not_found', found: false, onCitedPage: null }
  if (input.pageText != null && input.pageText !== '') {
    const onPage = canonicalize(input.pageText).includes(q)
    return { status: onPage ? 'confirmed' : 'off_cited_page', found: true, onCitedPage: onPage }
  }
  return { status: 'confirmed', found: true, onCitedPage: null }
}
