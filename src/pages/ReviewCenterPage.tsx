import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { viewHref, resolvePage } from '../lib/viewer'

// ── Review Center (audit Phase 2) ─────────────────────────────────────────────
// One screen for working verification flags portfolio-wide: queue of unresolved
// items (left) | the finding with its evidence and decision verbs (middle) |
// the cited source document embedded at the cited page (right).
//
// Slice 2: the queue now merges THREE detection layers, keyed identically to the
// per-tenant Abstracts worklist so one resolution clears an item everywhere:
//   · generator open items + verifier field checks (v_abstract_open_items)
//   · clause-specialist findings (lease_abstracts.clause_findings, revise /
//     cannot_verify; enrich shown under "All severities")
//   · cross-check disagreements (lease_abstracts.field_confidence)
// Plus bulk Accept/Waive over a checkbox selection and a group-by-tenant view.
// Human decisions carry resolved_by.

type Source = 'worklist' | 'clause' | 'crosscheck'

interface QueueItem {
  abstract_id: string
  property_id: string | null
  tenant_name: string
  ord: number
  txt: string
  severity: string       // discrepancy | confirm | missing | info | enrich
  field: string | null
  item_key: string
  source: Source
  evidence?: any          // clause finding / disagreement object for the middle pane
}

interface AbstractRowLite {
  id: string
  tenant_name: string
  property_id: string | null
  qa: any
  abstract: any
  overrides: Record<string, unknown> | null
  field_approvals: Record<string, { by?: string | null; at?: string; note?: string | null }> | null
  source_doc_ids: string[] | null
  human_verified: boolean
  locked: boolean
}

interface DocLite { id: string; title: string | null; storage_path: string | null; doc_type: string | null }

const SEV_COLOR: Record<string, string> = {
  discrepancy: 'var(--red, #ef4444)',
  confirm: 'var(--red, #ef4444)',
  revise: 'var(--red, #ef4444)',
  cannot_verify: 'var(--amber, #f59e0b)',
  missing: 'var(--amber, #f59e0b)',
  enrich: 'var(--text-muted)',
  info: 'var(--text-muted)',
}
const SEV_ICON: Record<string, string> = {
  discrepancy: '✗', confirm: '⚑', revise: '✗', cannot_verify: '?', missing: '◌', enrich: '＋', info: 'ℹ',
}
const SOURCE_LABEL: Record<Source, string> = { worklist: 'Verifier', clause: 'Clause specialist', crosscheck: 'Cross-check' }
const RED = new Set(['discrepancy', 'confirm', 'revise'])

// Dotted-path getter (array indices work: "options.0.notice_by"); mirrors the
// override layer's path semantics so the approve button shows the effective value.
function getAbstractPath(obj: any, path: string | null): unknown {
  if (!obj || !path) return null
  let cur: any = obj
  for (const seg of path.split('.')) {
    if (cur == null) return null
    cur = cur[seg]
  }
  return typeof cur === 'object' && cur !== null ? null : cur
}

function checkFor(qa: any, field: string | null) {
  if (!qa?.field_checks || !field) return null
  const arr = Array.isArray(qa.field_checks) ? qa.field_checks : []
  return arr.find((c: any) => (c?.field ?? '') === field) ?? null
}

// Light citation→document ranking: prefer docs whose title shares tokens with
// the citation, then lease instruments.
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
  const [srcFilter, setSrcFilter] = useState<Source | 'all'>('all')
  const [grouped, setGrouped] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [selKey, setSelKey] = useState<string | null>(null)     // abstract_id|item_key
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [reviewerId, setReviewerId] = useState<string | null>(null)

  const [row, setRow] = useState<AbstractRowLite | null>(null)
  const [docs, setDocs] = useState<DocLite[]>([])
  const [note, setNote] = useState('')
  const [correctVal, setCorrectVal] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)

  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [pdfDocId, setPdfDocId] = useState<string | null>(null)
  const [pdfLoading, setPdfLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const { data: auth } = await supabase.auth.getUser()
      setReviewerId(auth?.user?.id ?? null)

      // 1. worklist view (already resolution-aware)
      const { data: wl, error: qErr } = await supabase
        .from('v_abstract_open_items')
        .select('abstract_id, property_id, tenant_name, ord, txt, severity, field, item_key, resolved')
        .order('tenant_name').order('ord')
        .limit(2000)
      if (qErr) throw new Error(qErr.message)
      const items: QueueItem[] = ((wl ?? []) as any[])
        .filter(r => !r.resolved)
        .map(r => ({ ...r, source: 'worklist' as Source }))

      // 2+3. clause findings + cross-check disagreements live as jsonb on the
      // abstract row; explode client-side and drop anything already resolved.
      const { data: las, error: laErr } = await supabase
        .from('lease_abstracts')
        .select('id, tenant_name, property_id, clause_findings, field_confidence')
        .or('clause_findings.not.is.null,field_confidence.not.is.null')
      if (laErr) throw new Error(laErr.message)

      const abstractIds = ((las ?? []) as any[]).map(a => a.id)
      const resolvedSet = new Set<string>()
      if (abstractIds.length) {
        const { data: res } = await supabase
          .from('abstract_item_resolutions')
          .select('abstract_id, item_key')
          .in('abstract_id', abstractIds)
          .eq('archived', false)
        for (const r of (res ?? []) as any[]) resolvedSet.add(`${r.abstract_id}|${r.item_key}`)
      }
      const seen = new Set(items.map(i => `${i.abstract_id}|${i.item_key}`))

      for (const la of (las ?? []) as any[]) {
        let ord = 10_000
        for (const f of (la.clause_findings?.findings ?? []) as any[]) {
          if (!f?.field || f.settled === true) continue
          if (!['revise', 'cannot_verify', 'enrich'].includes(f.verdict)) continue
          const key = `field:${f.field}`
          const full = `${la.id}|${key}`
          if (resolvedSet.has(full) || seen.has(full)) continue
          seen.add(full)
          items.push({
            abstract_id: la.id, property_id: la.property_id, tenant_name: la.tenant_name,
            ord: ord++, txt: f.rationale ?? f.quote ?? f.field,
            severity: f.verdict, field: f.field, item_key: key, source: 'clause', evidence: f,
          })
        }
        for (const d of (la.field_confidence?.disagreements ?? []) as any[]) {
          const fld = d?.field ?? d?.path
          if (!fld) continue
          const key = `field:${fld}`
          const full = `${la.id}|${key}`
          if (resolvedSet.has(full) || seen.has(full)) continue
          seen.add(full)
          items.push({
            abstract_id: la.id, property_id: la.property_id, tenant_name: la.tenant_name,
            ord: ord++, txt: d.reason ?? d.note ?? `Cross-check lenses disagree on ${fld}`,
            severity: 'discrepancy', field: fld, item_key: key, source: 'crosscheck', evidence: d,
          })
        }
      }

      items.sort((a, b) => a.tenant_name.localeCompare(b.tenant_name) || a.ord - b.ord)
      setQueue(items)
      setChecked(new Set())

      const pids = [...new Set(items.map(o => o.property_id).filter(Boolean))] as string[]
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
      (sevFilter === 'all' || RED.has(q.severity)) &&
      (srcFilter === 'all' || q.source === srcFilter) &&
      (!s || q.tenant_name.toLowerCase().includes(s) || q.txt.toLowerCase().includes(s) || (q.field ?? '').toLowerCase().includes(s)))
  }, [queue, propFilter, sevFilter, srcFilter, search])

  const byTenant = useMemo(() => {
    const m = new Map<string, QueueItem[]>()
    for (const q of visible) {
      const arr = m.get(q.tenant_name) ?? []
      arr.push(q); m.set(q.tenant_name, arr)
    }
    return m
  }, [visible])

  const selected = useMemo(
    () => visible.find(q => `${q.abstract_id}|${q.item_key}` === selKey) ?? null,
    [visible, selKey])

  useEffect(() => {
    if (!selected) { setRow(null); setDocs([]); setPdfUrl(null); return }
    let live = true
    ;(async () => {
      if (row?.id !== selected.abstract_id) {
        const { data } = await supabase.from('lease_abstracts')
          .select('id, tenant_name, property_id, qa, abstract, overrides, field_approvals, source_doc_ids, human_verified, locked')
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
  const clause = selected?.source === 'clause' ? selected.evidence : null
  const xcheck = selected?.source === 'crosscheck' ? selected.evidence : null
  const bestQuote: string | null = (check?.source_quote as string) ?? (clause?.quote as string) ?? null
  const bestCitation: string | null = (check?.citation as string) ?? (clause?.citation as string) ?? (xcheck?.citation as string) ?? null

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
    const best = rankDocs(docs, bestCitation ?? selected.txt)[0] ?? null
    void showDoc(best, bestQuote, bestCitation)
  }, [selected?.item_key, docs, bestQuote, bestCitation, showDoc])   // eslint-disable-line react-hooks/exhaustive-deps

  // ── decisions ──
  async function upsertResolutions(targets: QueueItem[], status: 'accepted' | 'waived' | 'needs_doc' | 'corrected', noteText: string) {
    const rows = targets.map(t => ({
      abstract_id: t.abstract_id,
      item_key: t.item_key,
      kind: t.source === 'worklist' ? 'open_item' : t.source === 'clause' ? 'clause_finding' : 'cross_check',
      status,
      note: noteText || null,
      resolved_by: reviewerId,
      resolved_at: new Date().toISOString(),
      archived: false,
    }))
    const { error: rErr } = await supabase.from('abstract_item_resolutions')
      .upsert(rows, { onConflict: 'abstract_id,item_key' })
    if (rErr) throw new Error(rErr.message)
  }

  function advanceFrom(keys: Set<string>) {
    const idx = visible.findIndex(q => `${q.abstract_id}|${q.item_key}` === selKey)
    const remaining = visible.filter(q => !keys.has(`${q.abstract_id}|${q.item_key}`))
    const next = remaining[Math.min(idx, remaining.length - 1)] ?? null
    setQueue(qs => qs.filter(q => !keys.has(`${q.abstract_id}|${q.item_key}`)))
    setChecked(new Set())
    setSelKey(next ? `${next.abstract_id}|${next.item_key}` : null)
  }

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
      await upsertResolutions([selected], status, note.trim())
      advanceFrom(new Set([`${selected.abstract_id}|${selected.item_key}`]))
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // Field-level approval: affirm the field's CURRENT value (override-aware).
  // Writes the authoritative field_approvals record + a companion 'accepted'
  // resolution so every settled-field consumer (ensemble, worklists, badges)
  // honors it without further plumbing.
  async function approveField() {
    if (!selected?.field || !row) return
    setSaving(true); setSaveErr(null)
    try {
      const approvals = { ...(row.field_approvals ?? {}) }
      approvals[selected.field] = { by: reviewerId, at: new Date().toISOString(), note: note.trim() || null }
      const { error: aErr } = await supabase.from('lease_abstracts')
        .update({ field_approvals: approvals, updated_at: new Date().toISOString() }).eq('id', row.id)
      if (aErr) throw new Error(aErr.message)
      await upsertResolutions([selected], 'accepted', `[field value approved] ${note.trim()}`.trim())
      advanceFrom(new Set([`${selected.abstract_id}|${selected.item_key}`]))
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function decideBulk(status: 'accepted' | 'waived') {
    const targets = visible.filter(q => checked.has(`${q.abstract_id}|${q.item_key}`))
    if (!targets.length) return
    setSaving(true); setSaveErr(null)
    try {
      await upsertResolutions(targets, status, note.trim())
      advanceFrom(new Set(targets.map(t => `${t.abstract_id}|${t.item_key}`)))
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

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

  const renderItem = (q: QueueItem) => {
    const k = `${q.abstract_id}|${q.item_key}`
    const sel = k === selKey
    return (
      <div key={k} onClick={() => setSelKey(k)}
        style={{ padding: '7px 10px 7px 8px', borderBottom: '1px solid var(--border-1, rgba(128,128,128,0.15))', cursor: 'pointer', display: 'flex', gap: 7, alignItems: 'flex-start', background: sel ? 'var(--surface-2)' : 'transparent', borderLeft: sel ? '3px solid var(--accent)' : '3px solid transparent' }}>
        <input type="checkbox" checked={checked.has(k)}
          onClick={e => e.stopPropagation()}
          onChange={e => setChecked(s => { const n = new Set(s); e.target.checked ? n.add(k) : n.delete(k); return n })}
          style={{ marginTop: 3 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
            <span style={{ color: SEV_COLOR[q.severity] ?? 'var(--text-muted)', fontSize: 11 }}>{SEV_ICON[q.severity] ?? '•'}</span>
            {!grouped && <span style={{ fontSize: 12, fontWeight: 600 }}>{q.tenant_name}</span>}
            {q.field && <span style={{ fontSize: 10, color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.field}</span>}
            <span style={{ fontSize: 9, color: 'var(--text-faint)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>{SOURCE_LABEL[q.source]}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{q.txt}</div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 60px)', gap: 0, overflow: 'hidden' }}>
      {/* ── left: queue ── */}
      <div style={{ width: 340, minWidth: 290, borderRight: '1px solid var(--border-2)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Review queue</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{visible.length} open</span>
            <button onClick={() => setGrouped(g => !g)} title="Toggle tenant grouping"
              style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px', borderRadius: 5, border: '1px solid var(--border-2)', background: grouped ? 'var(--surface-2)' : 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>⊟</button>
            <button onClick={() => void load()} title="Refresh"
              style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, border: '1px solid var(--border-2)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>↻</button>
          </div>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="filter tenants / fields / text"
            style={{ fontSize: 12, padding: '5px 8px', borderRadius: 5, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }} />
          <div style={{ display: 'flex', gap: 6 }}>
            <select value={propFilter} onChange={e => setPropFilter(e.target.value)}
              style={{ flex: 1, minWidth: 0, fontSize: 11, padding: '4px 6px', borderRadius: 5, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }}>
              <option value="all">All properties</option>
              {Object.entries(propNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <select value={sevFilter} onChange={e => setSevFilter(e.target.value as 'red' | 'all')}
              style={{ fontSize: 11, padding: '4px 6px', borderRadius: 5, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }}>
              <option value="red">Red only</option>
              <option value="all">All severities</option>
            </select>
            <select value={srcFilter} onChange={e => setSrcFilter(e.target.value as Source | 'all')}
              style={{ fontSize: 11, padding: '4px 6px', borderRadius: 5, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }}>
              <option value="all">All sources</option>
              <option value="worklist">Verifier</option>
              <option value="clause">Clause specialist</option>
              <option value="crosscheck">Cross-check</option>
            </select>
          </div>
          {checked.size > 0 && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', background: 'var(--surface-2)', borderRadius: 6, padding: '5px 8px' }}>
              <span style={{ fontSize: 11, fontWeight: 600 }}>{checked.size} selected</span>
              <button disabled={saving} onClick={() => void decideBulk('accepted')}
                style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 5, border: 'none', background: 'var(--green, #22c55e)', color: '#fff', cursor: 'pointer' }}>Accept</button>
              <button disabled={saving} onClick={() => void decideBulk('waived')}
                style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: '1px solid var(--border-2)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>Waive</button>
              <button onClick={() => setChecked(new Set())}
                style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>clear</button>
            </div>
          )}
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading && <div style={{ padding: 14, fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>}
          {error && <div style={{ padding: 14, fontSize: 12, color: 'var(--red)' }}>{error}</div>}
          {!loading && !visible.length && <div style={{ padding: 14, fontSize: 12, color: 'var(--text-muted)' }}>Queue is clear. ✅</div>}
          {!grouped && visible.map(renderItem)}
          {grouped && [...byTenant.entries()].map(([tenant, items]) => {
            const open = !collapsed.has(tenant)
            const reds = items.filter(i => RED.has(i.severity)).length
            return (
              <div key={tenant}>
                <div onClick={() => setCollapsed(s => { const n = new Set(s); n.has(tenant) ? n.delete(tenant) : n.add(tenant); return n })}
                  style={{ padding: '6px 10px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border-2)', cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'baseline', position: 'sticky', top: 0, zIndex: 1 }}>
                  <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{open ? '▾' : '▸'}</span>
                  <span style={{ fontSize: 12, fontWeight: 700 }}>{tenant}</span>
                  <span style={{ fontSize: 10, color: reds ? 'var(--red, #ef4444)' : 'var(--text-muted)', marginLeft: 'auto' }}>{reds ? `${reds} red · ` : ''}{items.length}</span>
                </div>
                {open && items.map(renderItem)}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── middle: finding + decision ── */}
      <div style={{ flex: 1, minWidth: 340, display: 'flex', flexDirection: 'column', overflowY: 'auto', padding: '14px 18px', gap: 12 }}>
        {!selected && <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 40, textAlign: 'center' }}>Select an item from the queue.<br /><span style={{ fontSize: 11 }}>↑/↓ to move · checkboxes for bulk Accept/Waive · decisions land in the same audit trail as the Abstracts page.</span></div>}
        {selected && (
          <>
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 16, fontWeight: 700 }}>{selected.tenant_name}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{selected.property_id ? propNames[selected.property_id] : ''}</span>
                <span style={{ fontSize: 10, padding: '1px 8px', borderRadius: 10, background: 'var(--surface-2)', color: 'var(--text-muted)' }}>{SOURCE_LABEL[selected.source]}</span>
                {row?.locked && <span style={{ fontSize: 10, color: 'var(--amber, #f59e0b)', fontWeight: 700 }}>🔒 locked — unlock in Abstracts to change</span>}
              </div>
              {selected.field && <div style={{ fontSize: 12, color: 'var(--accent)', marginTop: 2 }}>{selected.field}</div>}
              {selected.field && row?.field_approvals?.[selected.field] && (
                <div style={{ fontSize: 11, color: 'var(--green, #22c55e)', marginTop: 2 }}>
                  ✓ Field value human-approved {row.field_approvals[selected.field].at ? `on ${new Date(row.field_approvals[selected.field].at!).toLocaleDateString()}` : ''}
                  {row.field_approvals[selected.field].note ? ` — ${row.field_approvals[selected.field].note}` : ''}
                </div>
              )}
            </div>

            <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.5, borderLeft: `3px solid ${SEV_COLOR[selected.severity] ?? 'var(--border-2)'}` }}>
              {selected.txt}
            </div>

            {check && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                <div><span style={{ color: 'var(--text-faint)', textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>Verifier</span> — verdict <b style={{ color: check.verdict === 'confirmed' ? 'var(--green, #22c55e)' : 'var(--red, #ef4444)' }}>{check.verdict}</b>{check.severity ? ` · ${check.severity}` : ''}</div>
                {check.note && <div style={{ color: 'var(--text-muted)' }}>{check.note}</div>}
                {check.abstract_value != null && <div>AI value: <b>{String(check.abstract_value)}</b></div>}
              </div>
            )}

            {clause && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                <div><span style={{ color: 'var(--text-faint)', textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>{clause.specialist ?? 'clause'} specialist</span> — verdict <b style={{ color: 'var(--red, #ef4444)' }}>{clause.verdict}</b>{clause.severity ? ` · ${clause.severity}` : ''}{clause.cross_model?.verdict ? <> · cross-model <b style={{ color: clause.cross_model.verdict === 'confirm' ? 'var(--green, #22c55e)' : 'var(--amber, #f59e0b)' }}>{clause.cross_model.verdict}</b></> : null}</div>
                {clause.current_value != null && <div>Current: <b>{String(clause.current_value)}</b></div>}
                {clause.correct_value != null && <div>Specialist proposes: <b style={{ color: 'var(--green, #22c55e)' }}>{String(clause.correct_value)}</b></div>}
                {clause.missing_nuance && <div style={{ color: 'var(--text-muted)' }}>{clause.missing_nuance}</div>}
              </div>
            )}

            {xcheck && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                <div><span style={{ color: 'var(--text-faint)', textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>Cross-check</span> — independent lenses disagree with the stored value</div>
                {(xcheck.value ?? xcheck.competing_value) != null && <div>Lens value: <b>{String(xcheck.value ?? xcheck.competing_value)}</b></div>}
              </div>
            )}

            {bestQuote && (
              <blockquote style={{ margin: 0, padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 6, fontStyle: 'italic', color: 'var(--text-muted)', fontSize: 12 }}>
                “{bestQuote}”
                {bestCitation && <div style={{ fontStyle: 'normal', fontSize: 10, marginTop: 4, color: 'var(--text-faint)' }}>{bestCitation}</div>}
              </blockquote>
            )}

            <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 10, borderTop: '1px solid var(--border-2)' }}>
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="decision note (kept in the audit trail; applies to bulk actions too)"
                style={{ width: '100%', fontSize: 12, padding: '6px 8px', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)', resize: 'vertical' }} />
              {selected.field && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={correctVal} onChange={e => setCorrectVal(e.target.value)} placeholder={clause?.correct_value ? `corrected value (specialist proposes: ${String(clause.correct_value).slice(0, 60)}…)` : `corrected value for ${selected.field}`}
                    style={{ flex: 1, fontSize: 12, padding: '6px 8px', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }} />
                  <button disabled={saving || row?.locked} onClick={() => void decide('corrected', { value: correctVal })} style={btn('var(--accent)')}>Correct</button>
                </div>
              )}
              {saveErr && <div style={{ fontSize: 12, color: 'var(--red)' }}>{saveErr}</div>}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button disabled={saving || row?.locked} onClick={() => void decide('accepted')} style={btn('var(--green, #22c55e)')}>{saving ? '…' : 'Accept'}</button>
                {selected.field && (
                  <button disabled={saving || row?.locked} onClick={() => void approveField()}
                    title="Affirm this field's current value as human-approved (recorded with your user + timestamp; settles the field across all detection layers)"
                    style={{ ...btn('transparent', 'var(--green, #22c55e)'), border: '1px solid var(--green, #22c55e)' }}>
                    ✓ Approve field value{(() => { const v = selected.field ? (row?.overrides?.[selected.field] ?? getAbstractPath(row?.abstract, selected.field)) : null; return v != null && String(v).length <= 40 ? `: ${String(v)}` : '' })()}
                  </button>
                )}
                <button disabled={saving || row?.locked} onClick={() => void decide('waived')} style={btn('var(--surface-2)', 'var(--text)')}>Waive</button>
                <button disabled={saving || row?.locked} onClick={() => void decide('needs_doc')} style={btn('var(--surface-2)', 'var(--text)')}>Needs document</button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── right: source document ── */}
      <div style={{ width: '40%', minWidth: 360, borderLeft: '1px solid var(--border-2)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-2)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={pdfDocId ?? ''} onChange={e => { const d = docs.find(x => x.id === e.target.value) ?? null; void showDoc(d, bestQuote, bestCitation) }}
            style={{ flex: 1, minWidth: 0, fontSize: 11, padding: '4px 6px', borderRadius: 5, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }}>
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
