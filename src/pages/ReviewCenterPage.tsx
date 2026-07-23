import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { viewHref, resolvePage } from '../lib/viewer'

// ── Review Center (audit Phase 2) ─────────────────────────────────────────────
// One screen for working verification flags portfolio-wide: queue of unresolved
// items (left) | the finding with its evidence and decision verbs (middle) |
// the cited source document embedded at the cited page (right). Reads the same
// worklist the per-tenant Abstracts view uses (v_abstract_open_items) and writes
// the same resolution rows (abstract_item_resolutions) + override layer, so a
// decision made here shows up everywhere. Human decisions carry resolved_by.

interface QueueItem {
  abstract_id: string
  property_id: string | null
  tenant_name: string
  ord: number
  txt: string
  severity: string       // discrepancy | confirm | missing | info…
  field: string | null
  item_key: string
}

interface AbstractRowLite {
  id: string
  tenant_name: string
  property_id: string | null
  qa: any
  abstract: any
  overrides: Record<string, unknown> | null
  source_doc_ids: string[] | null
  human_verified: boolean
  locked: boolean
}

interface DocLite { id: string; title: string | null; storage_path: string | null; doc_type: string | null }

const SEV_COLOR: Record<string, string> = {
  discrepancy: 'var(--red, #ef4444)',
  confirm: 'var(--red, #ef4444)',
  missing: 'var(--amber, #f59e0b)',
  info: 'var(--text-muted)',
}
const SEV_ICON: Record<string, string> = { discrepancy: '✗', confirm: '⚑', missing: '◌', info: 'ℹ' }

// The qa field_check backing an item (evidence: verdict/note/quote/citation).
function checkFor(qa: any, field: string | null) {
  if (!qa?.field_checks || !field) return null
  const arr = Array.isArray(qa.field_checks) ? qa.field_checks : []
  return arr.find((c: any) => (c?.field ?? '') === field) ?? null
}

// Light citation→document ranking (slim cousin of the Abstracts page ranker):
// prefer docs whose title shares tokens with the citation, then lease instruments.
function rankDocs(docs: DocLite[], citation: string | null): DocLite[] {
  const tokens = (citation ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 3)
  const score = (d: DocLite) => {
    const t = (d.title ?? '').toLowerCase()
    let s = 0
    for (const tok of tokens) if (t.includes(tok)) s += 2
    if (/amendment/.test(t) && /amend/.test((citation ?? '').toLowerCase())) s += 3
    if (d.doc_type === 'lease') s += 1
    return s
  }
  return [...docs].sort((a, b) => score(b) - score(a))
}

export function ReviewCenterPage() {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [propNames, setPropNames] = useState<Record<string, string>>({})
  const [propFilter, setPropFilter] = useState<string>('all')
  const [sevFilter, setSevFilter] = useState<'red' | 'all'>('red')
  const [search, setSearch] = useState('')
  const [selKey, setSelKey] = useState<string | null>(null)     // abstract_id|item_key
  const [reviewerId, setReviewerId] = useState<string | null>(null)

  // middle-pane state for the selected item
  const [row, setRow] = useState<AbstractRowLite | null>(null)
  const [docs, setDocs] = useState<DocLite[]>([])
  const [note, setNote] = useState('')
  const [correctVal, setCorrectVal] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)

  // right-pane state
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [pdfDocId, setPdfDocId] = useState<string | null>(null)
  const [pdfLoading, setPdfLoading] = useState(false)

  const listRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const { data: auth } = await supabase.auth.getUser()
      setReviewerId(auth?.user?.id ?? null)
      const { data, error: qErr } = await supabase
        .from('v_abstract_open_items')
        .select('abstract_id, property_id, tenant_name, ord, txt, severity, field, item_key, resolved')
        .order('tenant_name').order('ord')
        .limit(2000)
      if (qErr) throw new Error(qErr.message)
      const open = ((data ?? []) as any[]).filter(r => !r.resolved) as QueueItem[]
      setQueue(open)
      const pids = [...new Set(open.map(o => o.property_id).filter(Boolean))] as string[]
      if (pids.length) {
        const { data: props } = await supabase.from('properties').select('id, name').in('id', pids)
        setPropNames(Object.fromEntries(((props ?? []) as any[]).map(p => [p.id, p.name])))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const visible = useMemo(() => {
    const s = search.trim().toLowerCase()
    return queue.filter(q =>
      (propFilter === 'all' || q.property_id === propFilter) &&
      (sevFilter === 'all' || q.severity === 'discrepancy' || q.severity === 'confirm') &&
      (!s || q.tenant_name.toLowerCase().includes(s) || q.txt.toLowerCase().includes(s) || (q.field ?? '').toLowerCase().includes(s)))
  }, [queue, propFilter, sevFilter, search])

  const selected = useMemo(
    () => visible.find(q => `${q.abstract_id}|${q.item_key}` === selKey) ?? null,
    [visible, selKey])

  // Load the abstract row + its documents when the selection's tenant changes.
  useEffect(() => {
    if (!selected) { setRow(null); setDocs([]); setPdfUrl(null); return }
    let live = true
    ;(async () => {
      if (row?.id !== selected.abstract_id) {
        const { data } = await supabase.from('lease_abstracts')
          .select('id, tenant_name, property_id, qa, abstract, overrides, source_doc_ids, human_verified, locked')
          .eq('id', selected.abstract_id).maybeSingle()
        if (!live) return
        setRow((data ?? null) as AbstractRowLite | null)
        const ids = ((data as any)?.source_doc_ids ?? []) as string[]
        if (ids.length) {
          const { data: dd } = await supabase.from('documents')
            .select('id, title, storage_path, doc_type').in('id', ids.slice(0, 60))
          if (!live) return
          setDocs(((dd ?? []) as DocLite[]))
        } else setDocs([])
      }
      setNote(''); setCorrectVal(''); setSaveErr(null)
    })()
    return () => { live = false }
  }, [selected?.abstract_id, selected?.item_key])   // eslint-disable-line react-hooks/exhaustive-deps

  const check = useMemo(() => checkFor(row?.qa, selected?.field ?? null), [row, selected])

  // Right pane: open the best-cited document at the cited page.
  const showDoc = useCallback(async (doc: DocLite | null, quote?: string | null, citation?: string | null) => {
    if (!doc?.storage_path) { setPdfUrl(null); setPdfDocId(null); return }
    setPdfLoading(true)
    try {
      const { data: signed } = await supabase.storage.from('documents').createSignedUrl(doc.storage_path, 3600)
      if (!signed?.signedUrl) { setPdfUrl(null); return }
      const page = await resolvePage(doc.id, quote ?? null, citation ?? null)
      const locator = (quote ?? '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 8).join(' ') || null
      setPdfUrl(viewHref(signed.signedUrl, locator, page))
      setPdfDocId(doc.id)
    } finally {
      setPdfLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!selected || !docs.length) { setPdfUrl(null); return }
    const best = rankDocs(docs, (check?.citation as string | undefined) ?? selected.txt)[0] ?? null
    void showDoc(best, check?.source_quote as string | undefined, check?.citation as string | undefined)
  }, [selected?.item_key, docs, check, showDoc])   // eslint-disable-line react-hooks/exhaustive-deps

  // ── decisions ──
  async function decide(status: 'accepted' | 'waived' | 'needs_doc' | 'corrected', extra?: { value?: string }) {
    if (!selected || !row) return
    setSaving(true); setSaveErr(null)
    try {
      if (status === 'corrected') {
        const field = selected.field
        if (!field) throw new Error('This item has no field path to correct — use Accept/Waive with a note.')
        const val = (extra?.value ?? '').trim()
        if (!val) throw new Error('Enter the corrected value first.')
        const merged = { ...(row.overrides ?? {}), [field]: val }
        const { error: oErr } = await supabase.from('lease_abstracts')
          .update({ overrides: merged, updated_at: new Date().toISOString() }).eq('id', row.id)
        if (oErr) throw new Error(oErr.message)
      }
      const { error: rErr } = await supabase.from('abstract_item_resolutions').upsert({
        abstract_id: row.id,
        item_key: selected.item_key,
        kind: 'open_item',
        status,
        note: note.trim() || null,
        resolved_by: reviewerId,
        resolved_at: new Date().toISOString(),
        archived: false,
      }, { onConflict: 'abstract_id,item_key' })
      if (rErr) throw new Error(rErr.message)
      // optimistic: drop from queue, advance selection
      const idx = visible.findIndex(q => `${q.abstract_id}|${q.item_key}` === selKey)
      const next = visible[idx + 1] ?? visible[idx - 1] ?? null
      setQueue(qs => qs.filter(q => !(q.abstract_id === selected.abstract_id && q.item_key === selected.item_key)))
      setSelKey(next ? `${next.abstract_id}|${next.item_key}` : null)
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // keyboard: ↑/↓ moves the selection through the visible queue
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const idx = visible.findIndex(q => `${q.abstract_id}|${q.item_key}` === selKey)
      const next = e.key === 'ArrowDown' ? visible[Math.min(idx + 1, visible.length - 1)] : visible[Math.max(idx - 1, 0)]
      if (next) setSelKey(`${next.abstract_id}|${next.item_key}`)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [visible, selKey])

  const btn = (bg: string, fg = '#fff'): React.CSSProperties => ({
    fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: 'none',
    background: bg, color: fg, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1,
  })

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 60px)', gap: 0, overflow: 'hidden' }}>
      {/* ── left: queue ── */}
      <div style={{ width: 330, minWidth: 280, borderRight: '1px solid var(--border-2)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Review queue</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{visible.length} open</span>
            <button onClick={() => void load()} title="Refresh"
              style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px', borderRadius: 5, border: '1px solid var(--border-2)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>↻</button>
          </div>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="filter tenants / fields / text"
            style={{ fontSize: 12, padding: '5px 8px', borderRadius: 5, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }} />
          <div style={{ display: 'flex', gap: 6 }}>
            <select value={propFilter} onChange={e => setPropFilter(e.target.value)}
              style={{ flex: 1, fontSize: 11, padding: '4px 6px', borderRadius: 5, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }}>
              <option value="all">All properties</option>
              {Object.entries(propNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <select value={sevFilter} onChange={e => setSevFilter(e.target.value as 'red' | 'all')}
              style={{ fontSize: 11, padding: '4px 6px', borderRadius: 5, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }}>
              <option value="red">Red only</option>
              <option value="all">All severities</option>
            </select>
          </div>
        </div>
        <div ref={listRef} style={{ overflowY: 'auto', flex: 1 }}>
          {loading && <div style={{ padding: 14, fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>}
          {error && <div style={{ padding: 14, fontSize: 12, color: 'var(--red)' }}>{error}</div>}
          {!loading && !visible.length && <div style={{ padding: 14, fontSize: 12, color: 'var(--text-muted)' }}>Queue is clear. ✅</div>}
          {visible.map(q => {
            const k = `${q.abstract_id}|${q.item_key}`
            const sel = k === selKey
            return (
              <div key={k} onClick={() => setSelKey(k)}
                style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-1, rgba(128,128,128,0.15))', cursor: 'pointer', background: sel ? 'var(--surface-2)' : 'transparent', borderLeft: sel ? '3px solid var(--accent)' : '3px solid transparent' }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                  <span style={{ color: SEV_COLOR[q.severity] ?? 'var(--text-muted)', fontSize: 11 }}>{SEV_ICON[q.severity] ?? '•'}</span>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{q.tenant_name}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-faint)', marginLeft: 'auto' }}>{q.property_id ? (propNames[q.property_id] ?? '').split('—')[0].trim() : ''}</span>
                </div>
                {q.field && <div style={{ fontSize: 10, color: 'var(--accent)', marginTop: 1 }}>{q.field}</div>}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{q.txt}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── middle: finding + decision ── */}
      <div style={{ flex: 1, minWidth: 340, display: 'flex', flexDirection: 'column', overflowY: 'auto', padding: '14px 18px', gap: 12 }}>
        {!selected && <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 40, textAlign: 'center' }}>Select an item from the queue.<br /><span style={{ fontSize: 11 }}>↑/↓ to move · decisions save to the same worklist the Abstracts page uses.</span></div>}
        {selected && (
          <>
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 16, fontWeight: 700 }}>{selected.tenant_name}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{selected.property_id ? propNames[selected.property_id] : ''}</span>
                {row?.locked && <span style={{ fontSize: 10, color: 'var(--amber, #f59e0b)', fontWeight: 700 }}>🔒 locked — unlock in Abstracts to change</span>}
              </div>
              {selected.field && <div style={{ fontSize: 12, color: 'var(--accent)', marginTop: 2 }}>{selected.field}</div>}
            </div>

            <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.5, borderLeft: `3px solid ${SEV_COLOR[selected.severity] ?? 'var(--border-2)'}` }}>
              {selected.txt}
            </div>

            {check && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                <div><span style={{ color: 'var(--text-faint)', textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>Verifier</span> — verdict <b style={{ color: check.verdict === 'confirmed' ? 'var(--green, #22c55e)' : 'var(--red, #ef4444)' }}>{check.verdict}</b>{check.severity ? ` · ${check.severity}` : ''}</div>
                {check.note && <div style={{ color: 'var(--text-muted)' }}>{check.note}</div>}
                {check.abstract_value != null && <div>AI value: <b>{String(check.abstract_value)}</b></div>}
                {check.source_quote && (
                  <blockquote style={{ margin: 0, padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 6, fontStyle: 'italic', color: 'var(--text-muted)' }}>
                    “{check.source_quote}”
                    {check.citation && <div style={{ fontStyle: 'normal', fontSize: 10, marginTop: 4, color: 'var(--text-faint)' }}>{check.citation}</div>}
                  </blockquote>
                )}
              </div>
            )}

            <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 10, borderTop: '1px solid var(--border-2)' }}>
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="decision note (kept in the audit trail)"
                style={{ width: '100%', fontSize: 12, padding: '6px 8px', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)', resize: 'vertical' }} />
              {selected.field && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={correctVal} onChange={e => setCorrectVal(e.target.value)} placeholder={`corrected value for ${selected.field}`}
                    style={{ flex: 1, fontSize: 12, padding: '6px 8px', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }} />
                  <button disabled={saving || row?.locked} onClick={() => void decide('corrected', { value: correctVal })} style={btn('var(--accent)')}>Correct</button>
                </div>
              )}
              {saveErr && <div style={{ fontSize: 12, color: 'var(--red)' }}>{saveErr}</div>}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button disabled={saving || row?.locked} onClick={() => void decide('accepted')} style={btn('var(--green, #22c55e)')}>{saving ? '…' : 'Accept'}</button>
                <button disabled={saving || row?.locked} onClick={() => void decide('waived')} style={btn('var(--surface-2)', 'var(--text)')}>Waive</button>
                <button disabled={saving || row?.locked} onClick={() => void decide('needs_doc')} style={btn('var(--surface-2)', 'var(--text)')}>Needs document</button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── right: source document ── */}
      <div style={{ width: '42%', minWidth: 380, borderLeft: '1px solid var(--border-2)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-2)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={pdfDocId ?? ''} onChange={e => { const d = docs.find(x => x.id === e.target.value) ?? null; void showDoc(d, check?.source_quote as string | undefined, check?.citation as string | undefined) }}
            style={{ flex: 1, fontSize: 11, padding: '4px 6px', borderRadius: 5, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }}>
            <option value="">{docs.length ? 'Pick a source document…' : 'No documents attached'}</option>
            {docs.map(d => <option key={d.id} value={d.id}>{(d.title ?? d.id).slice(0, 90)}</option>)}
          </select>
          {pdfUrl && <a href={pdfUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: 'var(--accent)', whiteSpace: 'nowrap' }}>open ↗</a>}
        </div>
        <div style={{ flex: 1, background: 'var(--surface-2)' }}>
          {pdfLoading && <div style={{ padding: 14, fontSize: 12, color: 'var(--text-muted)' }}>Loading document…</div>}
          {!pdfLoading && pdfUrl && <iframe title="source document" src={pdfUrl} style={{ width: '100%', height: '100%', border: 'none' }} />}
          {!pdfLoading && !pdfUrl && <div style={{ padding: 14, fontSize: 12, color: 'var(--text-muted)' }}>The cited document renders here when an item is selected.</div>}
        </div>
      </div>
    </div>
  )
}
