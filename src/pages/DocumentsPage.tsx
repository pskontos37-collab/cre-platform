import { useState, useEffect } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { viewHref, locatorFromQuery } from '../lib/viewer'
import { Badge } from '../components/ui/Badge'
import { EmptyState } from '../components/ui/EmptyState'
import { loadCache, saveCache } from '../lib/uiCache'

const FN_BASE = import.meta.env.VITE_SUPABASE_URL + '/functions/v1'
const CACHE_KEY = 'docsearch:last'   // restore the last search when returning to this page

interface SearchHit {
  similarity: number | null          // null for keyword/title ("targeted") hits — no cosine score
  match?: 'targeted' | 'semantic'
  snippet: string
  document: { id: string; doc_type?: string; title?: string; file_path?: string; view_url?: string | null }
}

const EXAMPLES = [
  'co-tenancy clause anchor tenant',
  'lease extension option notice deadline',
  'estoppel certificate',
  'environmental site assessment',
  'guaranty of lease',
  'CAM reconciliation true-up',
]

// documents.file_path is stored as "drive:<driveId>" — turn it into a Drive link.
function driveLink(filePath?: string): string | null {
  if (!filePath?.startsWith('drive:')) return null
  return `https://drive.google.com/file/d/${filePath.slice('drive:'.length)}/view`
}

// "file:V:\..." / "file:\\server\..." docs live on the company file server — browsers
// can't open them from an https page, so offer the UNC path for pasting into Explorer.
function filePath(fp?: string): string | null {
  if (!fp?.startsWith('file:')) return null
  return fp.slice('file:'.length).replace(/#pages.*$/, '')
}

function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(path)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch { /* clipboard unavailable */ }
      }}
      title={path}
      style={{
        fontSize: 11, color: copied ? 'var(--green)' : 'var(--text-muted)',
        background: 'var(--surface-2)', border: '1px solid var(--border-2)',
        borderRadius: 6, padding: '3px 9px', cursor: 'pointer', whiteSpace: 'nowrap',
      }}
    >
      {copied ? '✓ Copied' : 'Copy path'}
    </button>
  )
}

const DOC_TYPE_VARIANT: Record<string, 'blue' | 'green' | 'amber' | 'gray'> = {
  lease: 'blue', estoppel: 'green', loan_agreement: 'amber', operating_statement: 'gray',
}

// Results are grouped into sections for the viewer. Most docs are doc_type='other',
// so the section is derived from doc_type first, then from the folder path + filename
// prefix codes the file room uses (LSE-, NTC LTR-, AGR-, etc.). Array order = display order.
const SECTIONS = [
  'Site Plans',
  'Leases & Amendments',
  'Estoppels & SNDAs',
  'Notices & Correspondence',
  'Service Agreements',
  'Insurance',
  'Taxes',
  'Sales Reports',
  'Inspections & Building',
  'Financials & Accounting',
  'Legal & Deal Docs',
  'Other',
] as const

function sectionFor(doc: SearchHit['document']): string {
  const dt = doc.doc_type ?? ''
  // Structured doc_type is authoritative when it's set to something specific.
  if (dt === 'site_plan') return 'Site Plans'
  if (dt === 'lease') return 'Leases & Amendments'
  if (dt === 'estoppel') return 'Estoppels & SNDAs'
  if (dt === 'tax') return 'Taxes'
  if (dt === 'inspection') return 'Inspections & Building'
  if (dt === 'jv_agreement' || dt === 'psa' || dt === 'loan_agreement' || dt === 'title') return 'Legal & Deal Docs'

  const path = (doc.file_path ?? '').toLowerCase()
  const base = path.split(/[\\/]/).pop() ?? ''      // filename — carries prefix codes
  const hay  = path + ' ' + (doc.title ?? '').toLowerCase()
  const has     = (...w: string[]) => w.some(s => hay.includes(s))
  const baseHas = (...w: string[]) => w.some(s => base.includes(s))

  if (baseHas('lse-', 'lease', 'amend', 'amd', 'guaranty') ||
      has('lease agreement', 'amendment to lease', 'memorandum of lease', 'guaranty of lease')) return 'Leases & Amendments'
  if (has('estoppel', 'subordination, non-disturbance', 'snda', 'non-disturbance and attornment')) return 'Estoppels & SNDAs'
  if (baseHas('ntc', 'ltr-', 'notice', 'em-') ||
      has('demand letter', 'past due notice', 'default notice', '\\correspondence\\')) return 'Notices & Correspondence'
  if (baseHas('agr-') || has('service agreement', '\\service agreements\\')) return 'Service Agreements'
  // Financials first: CAM/tax/insurance reconciliations mention "insurance" and
  // "real estate taxes" in passing but are accounting docs, not insurance/tax filings.
  if (has('cam reconciliation', 'reconciliation statement', 'cam close', 'close statement', 'cam charge', 'cam allocation',
          'income statement', 'balance sheet', 'trial balance', 'ledger', 'bank statement', 'reconciliation',
          'rent roll', 'invoice', 'budget', 'operating statement', 'general ledger', 'accounting')) return 'Financials & Accounting'
  // Insurance/Taxes require a filing-specific signal, not just a passing mention.
  if (has('acord', 'certificate of insurance', 'evidence of commercial property', 'evidence of insurance',
          'insurance policy', 'insurance binder', '\\insurance\\')) return 'Insurance'
  if (has('\\real estate taxes\\', 'assessor', 'ret lump', 'tax bill', 'tax collector', 'tax appeal', 'tax return') ||
      baseHas('tax')) return 'Taxes'
  if (has('sales report', 'monthly sales', 'percentage rent', '\\sales\\')) return 'Sales Reports'
  if (has('inspection', 'fire alarm', 'fire sprinkler', 'hvac', 'permit', 'zoning', 'architectural', 'construction', 'test, adjust')) return 'Inspections & Building'
  return 'Other'
}

type DocSearchCache = { query: string; searched: string; hits: SearchHit[] }

export function DocumentsPage() {
  const [searchParams] = useSearchParams()
  const initialQ = searchParams.get('q') ?? ''
  // Restore the last search so leaving to another page and coming back keeps results.
  const [query, setQuery]     = useState(() => initialQ || loadCache<DocSearchCache>(CACHE_KEY)?.query || '')
  const [hits, setHits]       = useState<SearchHit[] | null>(() => loadCache<DocSearchCache>(CACHE_KEY)?.hits ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [searched, setSearched] = useState(() => loadCache<DocSearchCache>(CACHE_KEY)?.searched ?? '')

  // Auto-run a query passed in via ?q= (e.g. from the dashboard corpus widget),
  // unless it's the same query we already have restored from the last visit.
  useEffect(() => {
    const cached = loadCache<DocSearchCache>(CACHE_KEY)
    if (initialQ && initialQ !== (cached?.searched ?? '')) runSearch(initialQ)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runSearch(q: string) {
    const term = q.trim()
    if (!term) return
    setLoading(true); setError(null); setSearched(term)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${FN_BASE}/doc-search?q=${encodeURIComponent(term)}&k=12`, {
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
      })
      const json = await res.json()
      if (json.error) throw new Error(String(json.error))
      const results = (json.results as SearchHit[]) ?? []
      setHits(results)
      saveCache<DocSearchCache>(CACHE_KEY, { query: term, searched: term, hits: results })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed')
      setHits(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: 900 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>Documents</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Semantic search across the document corpus — ask in plain language, not just keywords.
        </p>
      </div>

      {/* Search box */}
      <form
        onSubmit={e => { e.preventDefault(); runSearch(query) }}
        style={{ display: 'flex', gap: 8, marginBottom: 12 }}
      >
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="e.g. which leases have a co-tenancy clause?"
          style={{
            flex: 1,
            background:   'var(--surface)',
            border:       '1px solid var(--border-2)',
            borderRadius: 8,
            color:        'var(--text)',
            fontSize:     14,
            padding:      '10px 14px',
            outline:      'none',
          }}
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          style={{
            background:   loading || !query.trim() ? 'var(--surface-2)' : 'var(--accent)',
            color:        loading || !query.trim() ? 'var(--text-muted)' : '#fff',
            border:       'none',
            borderRadius: 8,
            padding:      '10px 20px',
            fontSize:     13,
            fontWeight:   600,
            cursor:       loading || !query.trim() ? 'default' : 'pointer',
            whiteSpace:   'nowrap',
          }}
        >
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {/* Example chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 24 }}>
        {EXAMPLES.map(ex => (
          <button
            key={ex}
            onClick={() => { setQuery(ex); runSearch(ex) }}
            style={{
              background:   'var(--surface-2)',
              border:       '1px solid var(--border)',
              borderRadius: 20,
              color:        'var(--text-muted)',
              fontSize:     12,
              padding:      '4px 12px',
              cursor:       'pointer',
            }}
          >
            {ex}
          </button>
        ))}
      </div>

      {/* Financial-statement queries: the corpus holds legal/lease/closing docs;
          statements are generated live from the GL on the Financials page. */}
      {searched && /income statement|balance sheet|financial statement|trial balance|general ledger|budget|p&l|profit.{0,3}loss|operating statement/i.test(searched) && (
        <div style={{ padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16,
          background: 'var(--accent-dim)', border: '1px solid var(--accent)', color: 'var(--text)' }}>
          Looking for financial statements? Those are generated live from the general ledger —{' '}
          <Link to="/financials" style={{ color: 'var(--accent)', fontWeight: 600 }}>
            open Financials
          </Link>{' '}
          and pick the property and month (income statement with budget, balance sheet, and GL drill-down).
        </div>
      )}

      {/* Results */}
      {error && (
        <div style={{ padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16,
          background: 'var(--red-bg)', border: '1px solid var(--red-border)', color: 'var(--red)' }}>
          {error}
        </div>
      )}

      {loading && (
        <div style={{ color: 'var(--text-faint)', fontSize: 13, padding: '12px 0' }}>
          Embedding your query and ranking documents…
        </div>
      )}

      {!loading && hits && hits.length === 0 && (
        <EmptyState title="No matches" subtitle={`Nothing found for “${searched}”`} />
      )}

      {!loading && hits && hits.length > 0 && (() => {
        // Bucket results into sections, preserving SECTIONS display order and the
        // within-section relevance ranking the edge function already applied.
        const groups = SECTIONS
          .map(label => ({ label, items: hits.filter(h => sectionFor(h.document) === label) }))
          .filter(g => g.items.length > 0)

        const renderCard = (h: SearchHit, i: number) => {
          const link = driveLink(h.document.file_path)
          const dt   = h.document.doc_type ?? 'other'
          return (
            <div
              key={h.document.id + i}
              style={{
                background:   'var(--surface)',
                border:       '1px solid var(--border)',
                borderRadius: 10,
                padding:      '14px 16px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <Badge variant={DOC_TYPE_VARIANT[dt] ?? 'gray'}>{dt.replace(/_/g, ' ')}</Badge>
                  {h.similarity != null ? (
                    <span style={{ fontSize: 11, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
                      {Math.round(h.similarity * 100)}% match
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--accent)', whiteSpace: 'nowrap' }}>
                      keyword match
                    </span>
                  )}
                </div>
                {h.document.view_url && (
                  <a
                    href={viewHref(h.document.view_url, locatorFromQuery(searched))}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', whiteSpace: 'nowrap', fontWeight: 650 }}
                  >
                    View PDF ↗
                  </a>
                )}
                {!h.document.view_url && link && (
                  <a
                    href={link}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', whiteSpace: 'nowrap' }}
                  >
                    Open in Drive ↗
                  </a>
                )}
                {filePath(h.document.file_path) && (
                  <CopyPathButton path={filePath(h.document.file_path)!} />
                )}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5 }}>
                {h.document.title || h.snippet}
              </div>
              {h.document.title && h.snippet && (
                <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 6, lineHeight: 1.5 }}>
                  {h.snippet}
                </div>
              )}
            </div>
          )
        }

        return (
          <>
            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 14 }}>
              {hits.length} results for “{searched}”
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              {groups.map(g => (
                <div key={g.label}>
                  <div style={{
                    display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10,
                    paddingBottom: 6, borderBottom: '1px solid var(--border)',
                  }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{g.label}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{g.items.length}</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {g.items.map(renderCard)}
                  </div>
                </div>
              ))}
            </div>
          </>
        )
      })()}
    </div>
  )
}
