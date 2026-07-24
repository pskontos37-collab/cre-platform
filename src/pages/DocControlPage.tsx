import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { supabase } from '../lib/supabase'

// ── Document Control (audit Phase 2) ─────────────────────────────────────────
// The register's "100% document accountability" surface: every file is KNOWN
// and is either processed, a duplicate, superseded, irrelevant with a reason,
// unreadable, or awaiting review — never silently missing. Three views:
//   Overview    — per-property rollup from document_accountability (v2 adds
//                 register coverage: hashed / paged / statused)
//   Duplicates  — exact-duplicate groups (same content_sha256)
//   Register    — filterable per-document register browser
// Read-only; population comes from the deterministic backfill
// (scripts/backfill_doc_hashes.ps1 + SQL derivations). AI classification of
// doc_subtype / families is a separate, flagged pass.

interface Rollup {
  property_id: string | null
  total: number
  indexed: number
  exceptions: number
  reconciliation_required: number
  superseded: number
  duplicates: number
  low_ocr: number
  irrelevant: number
  unaccounted: number
  hashed: number
  paged: number
  statused: number
}

interface DocRow {
  id: string
  title: string | null
  file_name: string | null
  doc_type: string | null
  doc_subtype: string | null
  processing_status: string | null
  ocr_quality: string | null
  page_count: number | null
  content_sha256: string | null
  duplicate_group_id: string | null
  effective_date: string | null
  stated_date: string | null
  is_indexed: boolean
  property_id: string | null
  file_size_bytes: number | null
}

const STATUS_COLOR: Record<string, string> = {
  extracted: 'var(--green, #22c55e)',
  ingested: 'var(--accent)',
  classified: 'var(--accent)',
  pending: 'var(--amber, #f59e0b)',
  reconciliation_required: 'var(--amber, #f59e0b)',
  exception: 'var(--red, #ef4444)',
  superseded: 'var(--text-muted)',
  irrelevant: 'var(--text-muted)',
}
const fmtN = (n: unknown) => (n == null ? '—' : Number(n).toLocaleString('en-US'))
const fmtMB = (b: number | null) => (b == null ? '—' : `${(b / 1048576).toFixed(1)} MB`)
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—')

const th: CSSProperties = { padding: '4px 8px', textAlign: 'left', whiteSpace: 'nowrap' }
const td: CSSProperties = { padding: '4px 8px', whiteSpace: 'nowrap' }

export function DocControlPage() {
  const [rollups, setRollups] = useState<Rollup[]>([])
  const [propNames, setPropNames] = useState<Record<string, string>>({})
  const [tab, setTab] = useState<'overview' | 'duplicates' | 'register'>('overview')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // duplicates tab
  const [dupRows, setDupRows] = useState<DocRow[]>([])
  const [dupLoaded, setDupLoaded] = useState(false)

  // register tab
  const [docs, setDocs] = useState<DocRow[]>([])
  const [docCount, setDocCount] = useState<number | null>(null)
  const [fProp, setFProp] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [fQ, setFQ] = useState('')
  const [regLoading, setRegLoading] = useState(false)

  const loadOverview = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const { data, error: e } = await supabase.from('document_accountability').select('*')
      if (e) throw new Error(e.message)
      const rows = (data ?? []) as Rollup[]
      const pids = [...new Set(rows.map(r => r.property_id).filter(Boolean))] as string[]
      if (pids.length) {
        const { data: props } = await supabase.from('properties').select('id, name').in('id', pids)
        setPropNames(Object.fromEntries(((props ?? []) as any[]).map(p => [p.id, p.name])))
      }
      setRollups(rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void loadOverview() }, [loadOverview])

  const loadDups = useCallback(async () => {
    try {
      const { data, error: e } = await supabase.from('documents')
        .select('id, title, file_name, doc_type, property_id, duplicate_group_id, file_size_bytes, content_sha256, is_indexed, doc_subtype, processing_status, ocr_quality, page_count, effective_date, stated_date')
        .not('duplicate_group_id', 'is', null)
        .order('duplicate_group_id').order('file_name')
        .limit(2000)
      if (e) throw new Error(e.message)
      setDupRows((data ?? []) as DocRow[])
      setDupLoaded(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])
  useEffect(() => { if (tab === 'duplicates' && !dupLoaded) void loadDups() }, [tab, dupLoaded, loadDups])

  const loadRegister = useCallback(async () => {
    setRegLoading(true); setError(null)
    try {
      let q = supabase.from('documents')
        .select('id, title, file_name, doc_type, doc_subtype, processing_status, ocr_quality, page_count, content_sha256, duplicate_group_id, effective_date, stated_date, is_indexed, property_id, file_size_bytes', { count: 'exact' })
      if (fProp) q = q.eq('property_id', fProp)
      if (fStatus === 'unaccounted') q = q.is('processing_status', null).eq('is_indexed', false)
      else if (fStatus === 'none') q = q.is('processing_status', null)
      else if (fStatus) q = q.eq('processing_status', fStatus)
      if (fQ.trim()) {
        const safe = fQ.trim().replace(/[(),%_]/g, ' ')
        q = q.or(`title.ilike.%${safe}%,file_name.ilike.%${safe}%`)
      }
      const { data, error: e, count } = await q.order('created_at', { ascending: false }).limit(200)
      if (e) throw new Error(e.message)
      setDocs((data ?? []) as DocRow[])
      setDocCount(count ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRegLoading(false)
    }
  }, [fProp, fStatus, fQ])
  useEffect(() => { if (tab === 'register') void loadRegister() }, [tab, loadRegister])

  const totals = useMemo(() => {
    const z = { total: 0, indexed: 0, exceptions: 0, superseded: 0, duplicates: 0, low_ocr: 0, unaccounted: 0, hashed: 0, paged: 0, statused: 0 }
    for (const r of rollups) {
      z.total += r.total; z.indexed += r.indexed; z.exceptions += r.exceptions
      z.superseded += r.superseded; z.duplicates += r.duplicates; z.low_ocr += r.low_ocr
      z.unaccounted += r.unaccounted; z.hashed += r.hashed; z.paged += r.paged; z.statused += r.statused
    }
    return z
  }, [rollups])

  const dupGroups = useMemo(() => {
    const m = new Map<string, DocRow[]>()
    for (const d of dupRows) {
      if (!d.duplicate_group_id) continue
      const arr = m.get(d.duplicate_group_id) ?? []
      arr.push(d); m.set(d.duplicate_group_id, arr)
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [dupRows])

  const propName = (pid: string | null) => (pid ? (propNames[pid] ?? pid.slice(0, 8)) : 'No property')
  const chip = (label: string, value: string, color?: string) => (
    <div key={label} style={{ border: '1px solid var(--border-2)', borderRadius: 8, padding: '6px 12px' }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-faint)' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: color ?? 'var(--text)' }}>{value}</div>
    </div>
  )

  const statusBadge = (d: DocRow) => {
    const s = d.processing_status
    if (!s && !d.is_indexed) return <span style={{ color: 'var(--red, #ef4444)', fontWeight: 600 }}>unaccounted</span>
    if (!s) return <span style={{ color: 'var(--text-faint)' }}>—</span>
    return <span style={{ color: STATUS_COLOR[s] ?? 'var(--text-muted)', fontWeight: 600 }}>{s.replace(/_/g, ' ')}</span>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Document Control</h2>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>register accountability — every file known, nothing silently missing</span>
        <button onClick={() => { setDupLoaded(false); void loadOverview(); if (tab === 'register') void loadRegister() }}
          style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px', borderRadius: 5, border: '1px solid var(--border-2)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>↻</button>
      </div>

      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {chip('Documents', fmtN(totals.total))}
        {chip('Indexed', `${fmtN(totals.indexed)} (${pct(totals.indexed, totals.total)})`)}
        {chip('Hashed', `${fmtN(totals.hashed)} (${pct(totals.hashed, totals.total)})`, totals.hashed < totals.total ? 'var(--amber, #f59e0b)' : 'var(--green, #22c55e)')}
        {chip('Duplicates', fmtN(totals.duplicates), totals.duplicates > 0 ? 'var(--amber, #f59e0b)' : undefined)}
        {chip('Exceptions', fmtN(totals.exceptions), totals.exceptions > 0 ? 'var(--red, #ef4444)' : undefined)}
        {chip('Unaccounted', fmtN(totals.unaccounted), totals.unaccounted > 0 ? 'var(--red, #ef4444)' : 'var(--green, #22c55e)')}
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        {(['overview', 'duplicates', 'register'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ fontSize: 12, fontWeight: tab === t ? 700 : 400, padding: '5px 14px', borderRadius: 6, cursor: 'pointer',
                     border: `1px solid ${tab === t ? 'var(--accent)' : 'var(--border-2)'}`,
                     background: tab === t ? 'var(--surface-2)' : 'transparent', color: 'var(--text)' }}>
            {t === 'overview' ? 'Overview' : t === 'duplicates' ? `Duplicates` : 'Register'}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div style={{ overflowX: 'auto' }}>
          {loading && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>}
          {!loading && (
            <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr style={{ color: 'var(--text-faint)' }}>
                  <th style={th}>Property</th><th style={th}>Total</th><th style={th}>Indexed</th>
                  <th style={th}>Hashed</th><th style={th}>Paged</th><th style={th}>Statused</th>
                  <th style={th}>Dupes</th><th style={th}>Low OCR</th><th style={th}>Superseded</th>
                  <th style={th}>Exceptions</th><th style={th}>Unaccounted</th>
                </tr>
              </thead>
              <tbody>
                {[...rollups].sort((a, b) => b.total - a.total).map(r => (
                  <tr key={r.property_id ?? 'none'} style={{ borderTop: '1px solid var(--border-1, rgba(128,128,128,0.15))' }}>
                    <td style={{ ...td, fontWeight: 600 }}>{propName(r.property_id)}</td>
                    <td style={td}>{fmtN(r.total)}</td>
                    <td style={td}>{fmtN(r.indexed)} <span style={{ color: 'var(--text-faint)' }}>({pct(r.indexed, r.total)})</span></td>
                    <td style={td}>{fmtN(r.hashed)} <span style={{ color: 'var(--text-faint)' }}>({pct(r.hashed, r.total)})</span></td>
                    <td style={td}>{fmtN(r.paged)}</td>
                    <td style={td}>{fmtN(r.statused)}</td>
                    <td style={{ ...td, color: r.duplicates ? 'var(--amber, #f59e0b)' : undefined }}>{fmtN(r.duplicates)}</td>
                    <td style={td}>{fmtN(r.low_ocr)}</td>
                    <td style={td}>{fmtN(r.superseded)}</td>
                    <td style={{ ...td, color: r.exceptions ? 'var(--red, #ef4444)' : undefined }}>{fmtN(r.exceptions)}</td>
                    <td style={{ ...td, color: r.unaccounted ? 'var(--red, #ef4444)' : 'var(--green, #22c55e)', fontWeight: 600 }}>{fmtN(r.unaccounted)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.5 }}>
            Hashed = content_sha256 recorded (exact-duplicate detection + change tracking). Paged = page_count known.
            Statused = processing lifecycle recorded. Unaccounted = no status and not indexed — the audit's
            "silently missing" class; the goal is zero.
          </div>
        </div>
      )}

      {tab === 'duplicates' && (
        <div>
          {!dupLoaded && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>}
          {dupLoaded && dupGroups.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No exact-duplicate groups recorded. Run the hash backfill to populate.</div>
          )}
          {dupGroups.map(([gid, members]) => (
            <div key={gid} style={{ border: '1px solid var(--border-2)', borderRadius: 8, padding: '8px 12px', marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                <b style={{ color: 'var(--text)' }}>{members.length} identical files</b>
                {' '}· sha <code style={{ fontSize: 10 }}>{members[0]?.content_sha256?.slice(0, 12)}</code>
                {' '}· {fmtMB(members[0]?.file_size_bytes ?? null)}
                {new Set(members.map(m => m.property_id)).size > 1 && (
                  <span style={{ color: 'var(--amber, #f59e0b)', fontWeight: 600 }}> · spans properties</span>
                )}
              </div>
              {members.map(m => (
                <div key={m.id} style={{ fontSize: 12, padding: '1px 0', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ color: 'var(--text-faint)', fontSize: 11, minWidth: 130 }}>{propName(m.property_id)}</span>
                  <span>{m.file_name ?? m.title ?? m.id}</span>
                  {m.is_indexed && <span style={{ fontSize: 10, color: 'var(--green, #22c55e)' }}>indexed</span>}
                </div>
              ))}
            </div>
          ))}
          {dupLoaded && dupRows.length >= 2000 && (
            <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>Showing the first 2,000 duplicate rows.</div>
          )}
        </div>
      )}

      {tab === 'register' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={fProp} onChange={e => setFProp(e.target.value)}
              style={{ fontSize: 12, padding: '5px 8px', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }}>
              <option value="">All properties</option>
              {Object.entries(propNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <select value={fStatus} onChange={e => setFStatus(e.target.value)}
              style={{ fontSize: 12, padding: '5px 8px', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }}>
              <option value="">Any status</option>
              <option value="unaccounted">unaccounted (no status, not indexed)</option>
              <option value="none">no status recorded</option>
              {['pending', 'ingested', 'classified', 'extracted', 'reconciliation_required', 'exception', 'superseded', 'irrelevant'].map(s =>
                <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
            <input value={fQ} onChange={e => setFQ(e.target.value)} placeholder="search title / file name"
              onKeyDown={e => { if (e.key === 'Enter') void loadRegister() }}
              style={{ fontSize: 12, padding: '5px 8px', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)', minWidth: 220 }} />
            <button onClick={() => void loadRegister()}
              style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border-2)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
              Apply
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
              {regLoading ? 'Loading…' : docCount != null ? `${fmtN(docCount)} matching · showing ${docs.length}` : ''}
            </span>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr style={{ color: 'var(--text-faint)' }}>
                  <th style={th}>File</th><th style={th}>Property</th><th style={th}>Type</th>
                  <th style={th}>Status</th><th style={th}>Pages</th><th style={th}>Size</th>
                  <th style={th}>SHA-256</th><th style={th}>Dup</th><th style={th}>Effective</th>
                </tr>
              </thead>
              <tbody>
                {docs.map(d => (
                  <tr key={d.id} style={{ borderTop: '1px solid var(--border-1, rgba(128,128,128,0.15))' }}>
                    <td style={{ ...td, whiteSpace: 'normal', maxWidth: 420 }}>{d.file_name ?? d.title ?? d.id}</td>
                    <td style={td}>{propName(d.property_id)}</td>
                    <td style={td}>{d.doc_subtype ?? d.doc_type ?? '—'}</td>
                    <td style={td}>{statusBadge(d)}</td>
                    <td style={td}>{d.page_count ?? '—'}</td>
                    <td style={td}>{fmtMB(d.file_size_bytes)}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 10 }}>{d.content_sha256 ? d.content_sha256.slice(0, 12) : '—'}</td>
                    <td style={td}>{d.duplicate_group_id ? <span style={{ color: 'var(--amber, #f59e0b)' }}>●</span> : ''}</td>
                    <td style={td}>{d.effective_date ?? d.stated_date ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!regLoading && docs.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>No documents match.</div>}
          </div>
        </div>
      )}
    </div>
  )
}
