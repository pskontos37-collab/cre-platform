import { supabase } from './supabase'

/** Build the href that opens a document at the cited section.
 *
 * Storage-mirrored PDFs open in the bundled pdf.js viewer (/public/pdfjs), which
 * accepts a cross-origin file URL (origin check patched) and honors BOTH a
 * `#page=N` fragment (jump straight to the page the clause lives on) AND a
 * `#search=` fragment (the find bar highlights every occurrence of the locator
 * phrase). We send both when we have them, so the reader lands on the right page
 * with the clause highlighted instead of on page 1.
 * Non-storage links (Google Drive) open natively; the browser viewer still honors
 * `#page=N`, but not `#search=`.
 */
export function viewHref(link: string, locator?: string | null, page?: number | null): string {
  if (!link) return link
  if (!link.includes('/storage/v1/')) {
    // Native browser PDF viewer: honors #page=N, ignores #search.
    return page ? `${link}#page=${page}` : link
  }
  const base = `/pdfjs/web/viewer.html?file=${encodeURIComponent(link)}`
  const frag: string[] = []
  if (page) frag.push(`page=${page}`)
  if (locator) { frag.push(`search=${encodeURIComponent(locator)}`); frag.push('phrase=true') }
  return frag.length ? `${base}#${frag.join('&')}` : base
}

const STOP = new Set(['the','a','an','and','or','of','to','in','at','is','are','what','which','for','with','does','do','have','has','clause','lease','document','show','me'])

/** Derive a short locator phrase from a free-text search query (fallback when the
 *  AI didn't supply one): the first couple of domain-significant words. */
export function locatorFromQuery(q: string): string | null {
  const words = q.toLowerCase().replace(/[^\w\s-]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 3 && !STOP.has(w))
  return words.length ? words.slice(0, 2).join(' ') : null
}

/** Resolve the PDF page a passage lives on.
 *
 * Only `text` chunks carry a page number (100% coverage); `summary` chunks —
 * which the semantic search also matches — almost never do, so a citation that
 * resolves to a summary chunk would otherwise open at page 1. Given the document
 * and one or more candidate texts (the matched passage, the locator phrase, the
 * raw query…), we probe the document's verbatim `text` chunks for the passage and
 * return the earliest page it appears on. Distinctive-first, looser fallback —
 * the same laddered match the abstract source-locator uses. Returns null when
 * nothing matches (scanned wording mismatch / paraphrase); callers then fall back
 * to opening the document without a page (prior behavior — no regression).
 */
export async function resolvePage(documentId: string, ...texts: Array<string | null | undefined>): Promise<number | null> {
  if (!documentId) return null
  for (const text of texts) {
    if (!text) continue
    const words = text.replace(/[%_]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(w => w.length >= 3)
    for (const n of [12, 8, 4]) {                 // distinctive first, looser fallback
      if (words.length < Math.min(n, 3)) continue
      const pat = '%' + words.slice(0, n).join('%') + '%'
      const { data } = await supabase.from('document_chunks')
        .select('page_number')
        .eq('document_id', documentId)
        .eq('kind', 'text')
        .ilike('content', pat)
        .not('page_number', 'is', null)
        .order('page_number', { ascending: true })
        .limit(1)
      if (data?.length) return data[0].page_number as number
    }
  }
  return null
}

/** Resolve the page (unless already known) and open the source PDF in a new tab,
 *  landing on that page with the clause highlighted. The single entry point every
 *  "view source" button should call so the behavior is identical everywhere. */
export async function openSourceAt(opts: {
  link: string
  documentId?: string | null
  locator?: string | null
  page?: number | null
  /** Verbatim text to locate the page with when `page` is unknown (defaults to `locator`). */
  probeText?: string | null
}): Promise<void> {
  if (!opts.link) return
  let page = opts.page ?? null
  if (!page && opts.documentId) {
    page = await resolvePage(opts.documentId, opts.probeText, opts.locator)
  }
  window.open(viewHref(opts.link, opts.locator, page), '_blank', 'noopener')
}
