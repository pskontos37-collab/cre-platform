import { useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { useQuery } from '../hooks/useQuery'
import { Widget, WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'
import { CLAUSES } from './AbstractsPage'
import { RightsRadar } from '../components/RightsRadar'

// /clauses — PORTFOLIO clause intelligence. The per-property clause matrix on
// /abstracts, lifted portfolio-wide: pick a clause type, see every tenant's
// language side-by-side across ALL properties, filter by text, and read the
// prevalence stat (e.g. "co-tenancy: 31 of 98 leases"). Negotiation leverage:
// benchmark a proposed clause against what the rest of the portfolio signed.

interface Row {
  id: string
  tenant_name: string
  property_name: string
  abstract: any
}

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`

interface SemHit {
  passage: string
  similarity: number
  doc_title: string
  doc_type: string
  storage_path: string | null
  property_name: string | null
  page_number: number | null
}

// Semantic mode: natural-language clause search over the verbatim-text corpus
// (clause-search edge fn → Voyage query embedding → HNSW match). Finds the
// actual clause passages — "tenant may go dark without consent" — with a
// deep link into the PDF at the matched page.
function SemanticSearch() {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [hits, setHits] = useState<SemHit[] | null>(null)

  async function run() {
    if (q.trim().length < 4 || busy) return
    setBusy(true); setErr(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${FN_BASE}/clause-search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q.trim(), count: 25 }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`)
      setHits(json.results ?? [])
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  async function openPdf(h: SemHit) {
    if (!h.storage_path) return
    const { data } = await supabase.storage.from('documents').createSignedUrl(h.storage_path, 3600)
    if (data?.signedUrl) window.open(data.signedUrl + (h.page_number ? `#page=${h.page_number}` : ''), '_blank')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void run() }}
          placeholder='Describe the clause… e.g. "tenant can terminate if anchor closes" or "CAM capped at 5% annually"'
          style={{ flex: 1, fontSize: 13, padding: '9px 12px', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }} />
        <button onClick={() => void run()} disabled={busy || q.trim().length < 4}
          style={{ fontSize: 13, fontWeight: 600, padding: '9px 18px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer' }}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--red)' }}>{err}</div>}
      {hits && (
        <Widget title="Matching clause passages" chip={`${hits.length}`} fullWidth>
          {hits.length === 0 && <EmptyState title="No matches" subtitle="Try different phrasing — the search is semantic, not keyword" />}
          {hits.map((h, i) => (
            <div key={i} style={{ padding: '9px 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 3 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{h.property_name ?? '—'}</span>
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)', flex: 1, minWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.doc_title}</span>
                {h.page_number != null && <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>p.{h.page_number}</span>}
                {h.storage_path && (
                  <button onClick={() => void openPdf(h)}
                    style={{ fontSize: 10, fontWeight: 600, padding: '1px 8px', borderRadius: 9, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--accent)', cursor: 'pointer' }}>
                    open PDF ↗
                  </button>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{h.passage}</div>
            </div>
          ))}
        </Widget>
      )}
    </div>
  )
}

// Rights radar mode: the live co-tenancy + early-termination risk engines
// (co_tenancy_risk / termination_risk RPCs, migration 20240072), portfolio-wide.
function RadarSection() {
  const props = useQuery<Record<string, string>>(async () => {
    const { data, error } = await supabase.from('properties').select('id, name').limit(200)
    if (error) throw new Error(error.message)
    const m: Record<string, string> = {}
    for (const p of (data ?? []) as { id: string; name: string }[]) m[p.id] = p.name
    return m
  }, [])
  return <RightsRadar propertyNames={props.data ?? {}} />
}

export function ClausesPage() {
  const { appUser } = useAuth()
  const [mode, setMode] = useState<'matrix' | 'semantic' | 'radar'>('matrix')
  const [clause, setClause] = useState('co_tenancy')
  const [text, setText] = useState('')
  const [propFilter, setPropFilter] = useState('')

  const rows = useQuery<Row[]>(async () => {
    const { data, error } = await supabase.from('lease_abstracts')
      .select('id, tenant_name, abstract, overrides, properties(name)')
      .not('abstract', 'is', null)
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(r => ({
      id: r.id, tenant_name: r.tenant_name, abstract: r.abstract,
      property_name: r.properties?.name ?? '—',
    }))
  }, [])

  const def = CLAUSES.find(c => c.key === clause)!
  const props = useMemo(() => [...new Set((rows.data ?? []).map(r => r.property_name))].sort(), [rows.data])

  const rendered = useMemo(() => (rows.data ?? [])
    .map(r => ({ ...r, value: def.render(r.abstract) || '—' }))
    .filter(r => !propFilter || r.property_name === propFilter)
    .filter(r => !text || r.value.toLowerCase().includes(text.toLowerCase()) || r.tenant_name.toLowerCase().includes(text.toLowerCase()))
    .sort((a, b) => a.property_name.localeCompare(b.property_name) || a.tenant_name.localeCompare(b.tenant_name)),
  [rows.data, def, propFilter, text])

  const prevalence = useMemo(() => {
    const all = (rows.data ?? []).map(r => def.render(r.abstract) || '—')
    const has = all.filter(v => v !== '—' && !/^(none|does not report)$/i.test(v.trim())).length
    return { has, total: all.length }
  }, [rows.data, def])

  if (appUser?.role !== 'admin' && appUser?.role !== 'asset_manager') {
    return <div style={{ padding: '40px 32px', color: 'var(--text-muted)', fontSize: 14 }}>You need admin or asset manager access to view clause intelligence.</div>
  }

  function exportCsv() {
    const esc = (s: any) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const head = `property,tenant,${def.key}`
    const lines = rendered.map(r => [r.property_name, r.tenant_name, r.value].map(esc).join(','))
    const blob = new Blob([[head, ...lines].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `clauses_${def.key}.csv`
    a.click()
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Clause Intelligence</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18 }}>
        Every lease's clause language side-by-side, portfolio-wide — built from the verified abstracts.
        Benchmark a proposed clause against what the portfolio has already signed.
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {(['matrix', 'semantic', 'radar'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)}
            style={{ padding: '5px 14px', borderRadius: 20, fontSize: 12, cursor: 'pointer', fontWeight: mode === m ? 600 : 400,
              border: `1px solid ${mode === m ? 'var(--accent)' : 'var(--border)'}`,
              background: mode === m ? 'var(--accent-dim)' : 'transparent',
              color: mode === m ? 'var(--accent)' : 'var(--text-muted)' }}>
            {m === 'matrix' ? 'Clause matrix' : m === 'semantic' ? 'Semantic search' : 'Rights radar'}
          </button>
        ))}
      </div>

      {mode === 'semantic' && <SemanticSearch />}
      {mode === 'radar' && <RadarSection />}

      {mode === 'matrix' && <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <select value={clause} onChange={e => setClause(e.target.value)}
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 6, color: 'var(--text)', fontSize: 13, padding: '7px 10px' }}>
          {CLAUSES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <select value={propFilter} onChange={e => setPropFilter(e.target.value)}
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '7px 9px' }}>
          <option value="">All properties</option>
          {props.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Filter language or tenant…"
          style={{ flex: 1, minWidth: 180, maxWidth: 340, fontSize: 12, padding: '7px 10px', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>
          {def.label}: {prevalence.has} of {prevalence.total} leases
        </span>
        <button onClick={exportCsv}
          style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer' }}>
          Export CSV ({rendered.length})
        </button>
      </div>

      <Widget title={`${def.label} — across the portfolio`} chip={`${rendered.length} leases`} fullWidth>
        {rows.loading && <WidgetSkeleton rows={10} />}
        {!rows.loading && rendered.length === 0 && <EmptyState title="No matches" subtitle="Adjust the filters" />}
        {rendered.length > 0 && (
          // Same overflow guard as MriReconPage: the Widget card clips
          // (overflow:hidden), so an unbreakable token in the clause text would
          // silently push columns out of reach without this wrapper.
          <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ textAlign: 'left', color: 'var(--text-faint)', fontSize: 11 }}>
              <th style={{ padding: '4px 8px', width: 180 }}>Property</th>
              <th style={{ padding: '4px 8px', width: 200 }}>Tenant</th>
              <th style={{ padding: '4px 8px' }}>{def.label}</th>
            </tr></thead>
            <tbody>
              {rendered.map(r => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border)', verticalAlign: 'top' }}>
                  <td style={{ padding: '6px 8px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{r.property_name}</td>
                  <td style={{ padding: '6px 8px', color: 'var(--text)', fontWeight: 600 }}>{r.tenant_name}</td>
                  <td style={{ padding: '6px 8px', color: 'var(--text-muted)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Widget>
      </>}
    </div>
  )
}
