/** Build the href that opens a document at the cited section.
 *
 * Storage-mirrored PDFs open in the bundled pdf.js viewer (/public/pdfjs), which
 * accepts a cross-origin file URL (origin check patched) and a #search fragment —
 * the find bar highlights every occurrence of the locator phrase and jumps to the
 * first match, landing the reader on the clause instead of page 1.
 * Non-storage links (Google Drive) open natively.
 */
export function viewHref(link: string, locator?: string | null): string {
  if (!link) return link
  if (!link.includes('/storage/v1/')) return link
  const base = `/pdfjs/web/viewer.html?file=${encodeURIComponent(link)}`
  return locator ? `${base}#search=${encodeURIComponent(locator)}&phrase=true` : base
}

const STOP = new Set(['the','a','an','and','or','of','to','in','at','is','are','what','which','for','with','does','do','have','has','clause','lease','document','show','me'])

/** Derive a short locator phrase from a free-text search query (fallback when the
 *  AI didn't supply one): the first couple of domain-significant words. */
export function locatorFromQuery(q: string): string | null {
  const words = q.toLowerCase().replace(/[^\w\s-]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 3 && !STOP.has(w))
  return words.length ? words.slice(0, 2).join(' ') : null
}
