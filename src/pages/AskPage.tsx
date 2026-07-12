import { FormEvent, useState } from 'react'
import { supabase } from '../lib/supabase'
import { viewHref } from '../lib/viewer'
import { useProperties } from '../hooks/useProperties'
import { loadCache, saveCache } from '../lib/uiCache'

const FN_BASE = import.meta.env.VITE_SUPABASE_URL + '/functions/v1'
const CACHE_KEY = 'docask:last'   // restore the last question + answer when returning to this page

interface AskSource {
  n: number
  match: 'targeted' | 'keyword' | 'semantic'
  similarity: number | null
  document_id: string
  title: string
  doc_type: string
  property: string | null
  link?: string | null
  path?: string | null
  locator?: string | null
}

interface AskDocument {
  id: string
  title: string
  doc_type: string
  property: string | null
  link: string | null
  path: string | null
  locator?: string | null
}


interface AskResponse {
  success?: boolean
  query?: string
  answer?: string
  sources?: AskSource[]
  documents?: AskDocument[]
  error?: string
}

const SAMPLE_QUESTIONS = [
  'Pull up the lease and all amendments for Staples at Gateway Port Chester',
  'What is the current property management fee at Magnolia Park, and how did it change over time?',
  'What did the Gateway ground lease buyout cost, and how was it funded?',
  'Summarize the Knightdale JV promote structure.',
  'What are the covenants on the New York Life loan at Gateway?',
]

type AskCache = { q: string; propertyId: string; asked: string | null; resp: AskResponse }

export function AskPage() {
  const { data: properties } = useProperties()
  // Restore the last question + answer so leaving to another page and coming back keeps it.
  const [q, setQ] = useState(() => loadCache<AskCache>(CACHE_KEY)?.q ?? '')
  const [propertyId, setPropertyId] = useState<string>(() => loadCache<AskCache>(CACHE_KEY)?.propertyId ?? '')
  const [loading, setLoading] = useState(false)
  const [resp, setResp] = useState<AskResponse | null>(() => loadCache<AskCache>(CACHE_KEY)?.resp ?? null)
  const [asked, setAsked] = useState<string | null>(() => loadCache<AskCache>(CACHE_KEY)?.asked ?? null)

  async function ask(question: string) {
    if (!question.trim() || loading) return
    setLoading(true)
    setResp(null)
    setAsked(question)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${FN_BASE}/doc-ask`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: question, property_id: propertyId || undefined, k: 8 }),
      })
      const json = (await res.json().catch(() => ({}))) as AskResponse
      if (!res.ok && !json.error) {
        setResp({ error: `Request failed (${res.status}) — try signing out and back in.` })
      } else {
        setResp(json)
        // Only cache a real answer, not an error response.
        if (json.answer) saveCache<AskCache>(CACHE_KEY, { q: question, propertyId, asked: question, resp: json })
      }
    } catch (e) {
      setResp({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setLoading(false)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void ask(q)
  }

  return (
    <div style={{ maxWidth: 860 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Ask the Portfolio</h1>
      <p style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 16 }}>
        Cited answers from the document corpus — leases, amendments, JV agreements, loan documents,
        management agreements, and closing binders.
      </p>

      <form onSubmit={onSubmit} style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="e.g. What is the current management fee at Magnolia Park?"
          style={{
            flex: 1, padding: '10px 12px', fontSize: 13,
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
            color: 'var(--text)', outline: 'none',
          }}
        />
        <select
          value={propertyId}
          onChange={e => setPropertyId(e.target.value)}
          style={{
            padding: '10px 10px', fontSize: 12,
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
            color: 'var(--text-muted)', maxWidth: 200,
          }}
        >
          <option value="">All properties</option>
          {(properties ?? []).map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <button
          type="submit"
          disabled={loading || !q.trim()}
          style={{
            padding: '10px 18px', fontSize: 13, fontWeight: 650, borderRadius: 8, border: 'none',
            background: loading ? 'var(--surface-2)' : 'var(--accent)',
            color: loading ? 'var(--text-faint)' : 'var(--bg)', cursor: loading ? 'default' : 'pointer',
          }}
        >
          {loading ? 'Thinking…' : 'Ask'}
        </button>
      </form>

      {/* Sample questions */}
      {!resp && !loading && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
          {SAMPLE_QUESTIONS.map(s => (
            <button
              key={s}
              onClick={() => { setQ(s); void ask(s) }}
              style={{
                fontSize: 11.5, color: 'var(--text-muted)', background: 'var(--surface)',
                border: '1px solid var(--border)', borderRadius: 99, padding: '5px 12px',
                cursor: 'pointer', textAlign: 'left',
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div style={{ fontSize: 12.5, color: 'var(--text-faint)', padding: '20px 0' }}>
          Searching {asked && propertyId ? 'this property' : 'the corpus'} and synthesizing an answer…
        </div>
      )}

      {resp?.error && (
        <div style={{ fontSize: 12.5, color: '#e5484d', padding: '12px 0' }}>Error: {resp.error}</div>
      )}

      {resp?.answer && (
        <div>
          <div
            style={{
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14,
              padding: '16px 18px', fontSize: 13, lineHeight: 1.65, color: 'var(--text)',
              whiteSpace: 'pre-wrap', boxShadow: 'var(--shadow, none)',
            }}
          >
            <AnswerText text={resp.answer} />
          </div>

          {(resp.documents ?? []).length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 8 }}>
                Matched documents · {(resp.documents ?? []).length}
              </div>
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', boxShadow: 'var(--shadow, none)' }}>
                {(resp.documents ?? []).map((d, i) => <DocRow key={d.id} doc={d} first={i === 0} />)}
              </div>
            </div>
          )}

          {(resp.sources ?? []).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-faint)', marginBottom: 6 }}>
                Sources
              </div>
              {(resp.sources ?? []).map(s => (
                <div key={s.n} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0', borderTop: '1px solid var(--border)', fontSize: 11.5 }}>
                  <span style={{ color: 'var(--accent)', fontWeight: 700, flexShrink: 0 }}>[{s.n}]</span>
                  {s.link ? (
                    <a
                      href={viewHref(s.link, s.locator)}
                      target="_blank"
                      rel="noreferrer"
                      title={s.locator ? `Opens at "${s.locator}"` : 'Open PDF'}
                      style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'underline', textDecorationColor: 'var(--border-2)' }}
                    >
                      {s.title}
                    </a>
                  ) : (
                    <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                  )}
                  <span style={{ color: 'var(--text-faint)', flexShrink: 0, marginLeft: 'auto' }}>
                    {s.property ? `${s.property} · ` : ''}{s.doc_type}
                    {s.similarity != null ? ` · ${(s.similarity * 100).toFixed(0)}%` : ' · title match'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DocRow({ doc, first }: { doc: AskDocument; first: boolean }) {
  const [copied, setCopied] = useState(false)

  async function copyPath() {
    if (!doc.path) return
    try {
      await navigator.clipboard.writeText(doc.path)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch { /* clipboard unavailable */ }
  }

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px',
        borderTop: first ? 'none' : '1px solid var(--border)', fontSize: 12,
      }}
    >
      <span
        style={{
          fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
          color: 'var(--accent)', background: 'var(--accent-dim)', padding: '2px 8px',
          borderRadius: 99, flexShrink: 0,
        }}
      >
        {doc.doc_type.replace(/_/g, ' ')}
      </span>
      <span
        title={doc.path ?? doc.title}
        style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
      >
        {doc.title}
      </span>
      {doc.link && (
        <a
          href={viewHref(doc.link, doc.locator)}
          target="_blank"
          rel="noreferrer"
          title={doc.locator ? `Opens at "${doc.locator}"` : 'Open PDF'}
          style={{ fontSize: 11.5, color: 'var(--accent)', textDecoration: 'none', whiteSpace: 'nowrap', flexShrink: 0, fontWeight: 650 }}
        >
          {doc.locator ? 'View § ↗' : 'View ↗'}
        </a>
      )}
      {doc.path && (
        <button
          onClick={copyPath}
          title={doc.path}
          style={{
            fontSize: 11, color: copied ? 'var(--green)' : 'var(--text-muted)',
            background: 'var(--surface-2)', border: '1px solid var(--border-2)',
            borderRadius: 6, padding: '3px 9px', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
          }}
        >
          {copied ? '✓ Copied' : 'Copy path'}
        </button>
      )}
    </div>
  )
}

/** Render the answer with **bold** and [n] citation highlighting (no markdown lib needed). */
function AnswerText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\[\d+\])/g)
  return (
    <>
      {parts.map((p, i) => {
        if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={i}>{p.slice(2, -2)}</strong>
        if (/^\[\d+\]$/.test(p)) return <sup key={i} style={{ color: 'var(--accent)', fontWeight: 700 }}>{p}</sup>
        return <span key={i}>{p}</span>
      })}
    </>
  )
}
