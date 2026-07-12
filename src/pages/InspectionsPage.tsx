import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useProperties } from '../hooks/useProperties'
import { useAuth } from '../contexts/AuthContext'
import { useIsPhone } from '../hooks/useMediaQuery'
import { Widget, WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'
import {
  useInspections, persistInspection, fetchInspectionForEdit,
  type InspectionListRow, type EditableInspection,
} from '../hooks/useInspections'
import { useInspectionTrends } from '../hooks/useInspectionTrends'
import {
  blankResponses, scoreOf, scoreColor, type SectionResponse, type YesNo,
} from '../lib/inspection'
import { INSTRUCTIONS, SCORE_LEGEND, type FormKind } from '../lib/inspectionTemplates'

const today = () => new Date().toISOString().slice(0, 10)

// A photo is either newly attached (has a File) or already stored (has a key).
interface PhotoRef { id: string; url: string; file?: File; key?: string }

type Mode = 'history' | 'trends' | 'edit'

export function InspectionsPage() {
  const { appUser } = useAuth()
  const { data: properties } = useProperties()
  const isPhone = useIsPhone()
  const [propertyId, setPropertyId] = useState<string | null>(null)
  useEffect(() => { if (!propertyId && properties?.length) setPropertyId(properties[0].id) }, [properties, propertyId])

  const property = useMemo(() => properties?.find(p => p.id === propertyId) ?? null, [properties, propertyId])
  const [mode, setMode] = useState<Mode>('history')
  const [bump, setBump] = useState(0)
  const [editInitial, setEditInitial] = useState<EditableInspection | null>(null)
  const [loadingEdit, setLoadingEdit] = useState<string | null>(null)
  const history = useInspections(propertyId, bump)

  async function resume(id: string) {
    setLoadingEdit(id)
    try {
      const e = await fetchInspectionForEdit(id)
      setEditInitial(e)
      setMode('edit')
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingEdit(null)
    }
  }

  const pad = isPhone ? '16px 14px' : '24px 32px'

  return (
    <div style={{ padding: pad, maxWidth: 1000 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: isPhone ? 18 : 20, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Property Inspections</div>
          {!isPhone && (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 620 }}>
              Complete an inspection in the browser — score each item, add photos, save a draft or submit. Submitting
              generates a presentation-quality PDF, files it to the property's documents, and updates the score history.
            </div>
          )}
          <Link to="/inspect" style={{ display: 'inline-block', marginTop: 6, fontSize: 12, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none' }}>
            📱 Open the phone-friendly version →
          </Link>
        </div>
        {mode !== 'edit' && (
          <button onClick={() => { setEditInitial(null); setMode('edit') }} disabled={!propertyId}
            style={{ fontSize: 12.5, fontWeight: 600, padding: '9px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', cursor: propertyId ? 'pointer' : 'default', whiteSpace: 'nowrap' }}>
            + New
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '14px 0 18px', flexWrap: 'wrap' }}>
        <select value={propertyId ?? ''} onChange={e => { setPropertyId(e.target.value); setMode('history') }}
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 6, color: 'var(--text)', fontSize: 13, padding: '9px 10px', flex: isPhone ? 1 : undefined, minWidth: 220 }}>
          {(properties ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {mode !== 'edit' && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 16, borderBottom: '1px solid var(--border)' }}>
          <Tab active={mode === 'history'} onClick={() => setMode('history')}>History</Tab>
          <Tab active={mode === 'trends'} onClick={() => setMode('trends')}>Trends</Tab>
        </div>
      )}

      {mode === 'edit' && property && (
        <Composer
          key={editInitial?.id ?? 'new'}
          isPhone={isPhone}
          propertyId={property.id}
          propertyName={property.name}
          initial={editInitial}
          defaultKind={property.asset_type === 'office' ? 'office' : 'retail'}
          defaultInspector={appUser?.full_name ?? appUser?.email ?? ''}
          uploadedBy={appUser?.id ?? null}
          onCancel={() => setMode('history')}
          onDone={() => { setMode('history'); setBump(b => b + 1) }}
        />
      )}

      {mode === 'history' && <HistoryList q={history} onResume={resume} loadingEdit={loadingEdit} />}
      {mode === 'trends' && <TrendsPanel propertyId={propertyId} bump={bump} isPhone={isPhone} />}
    </div>
  )
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} style={{
      fontSize: 13, fontWeight: 600, padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer',
      color: active ? 'var(--accent)' : 'var(--text-muted)',
      borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`, marginBottom: -1,
    }}>{children}</button>
  )
}

// ── history ──────────────────────────────────────────────────────────────────

function HistoryList({ q, onResume, loadingEdit }: { q: ReturnType<typeof useInspections>; onResume: (id: string) => void; loadingEdit: string | null }) {
  if (q.loading) return <Widget title="Inspection history"><WidgetSkeleton rows={4} /></Widget>
  if (q.error) return <div style={{ fontSize: 12, color: 'var(--red)' }}>{q.error}</div>
  const rows = q.data ?? []
  if (!rows.length) {
    return (
      <Widget title="Inspection history">
        <EmptyState icon="📋" title="No inspections yet" subtitle="Tap “+ New” to complete the first one for this property" />
      </Widget>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map(r => <HistoryRow key={r.id} r={r} onResume={onResume} loading={loadingEdit === r.id} />)}
    </div>
  )
}

function HistoryRow({ r, onResume, loading }: { r: InspectionListRow; onResume: (id: string) => void; loading: boolean }) {
  const avg = r.average_score != null ? Number(r.average_score) : null
  const draft = r.status === 'draft'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}>
      <ScoreBadge avg={avg} muted={draft} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {new Date(r.inspection_date + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
          {draft && <span style={{ fontSize: 10, fontWeight: 700, color: '#c2a35a', border: '1px solid #c2a35a', borderRadius: 10, padding: '1px 7px' }}>DRAFT</span>}
          <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-faint)', textTransform: 'capitalize' }}>{r.form_kind ?? ''}{r.form_version ? ` · ${r.form_version}` : ''}</span>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>
          {[r.inspected_by || 'Unknown inspector', r.items_scored != null ? `${r.items_scored} scored` : null, r.items_flagged ? `${r.items_flagged} flagged` : null].filter(Boolean).join(' · ')}
        </div>
      </div>
      {draft
        ? <button onClick={() => onResume(r.id)} disabled={loading}
            style={{ fontSize: 12, fontWeight: 600, padding: '7px 14px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', cursor: loading ? 'default' : 'pointer' }}>
            {loading ? 'Opening…' : 'Resume'}
          </button>
        : r.pdfUrl
          ? <a href={r.pdfUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, fontWeight: 600, padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text)', textDecoration: 'none' }}>View report</a>
          : <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>No report</span>}
    </div>
  )
}

function ScoreBadge({ avg, muted }: { avg: number | null; muted?: boolean }) {
  const color = muted ? 'var(--border-2)' : scoreColor(avg == null ? null : Math.round(avg))
  return (
    <div style={{ width: 44, height: 44, borderRadius: 8, background: color, color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <span style={{ fontSize: 15, fontWeight: 700, lineHeight: 1 }}>{avg == null ? '—' : avg.toFixed(1)}</span>
      <span style={{ fontSize: 7.5, opacity: 0.85 }}>/ 5</span>
    </div>
  )
}

// ── trends ───────────────────────────────────────────────────────────────────

function TrendsPanel({ propertyId, bump, isPhone }: { propertyId: string | null; bump: number; isPhone: boolean }) {
  const trends = useInspectionTrends(propertyId, bump)
  if (trends.loading) return <Widget title="Score trends"><WidgetSkeleton rows={5} /></Widget>
  if (trends.error) return <div style={{ fontSize: 12, color: 'var(--red)' }}>{trends.error}</div>
  const t = trends.data
  if (!t || t.count === 0) {
    return <Widget title="Score trends"><EmptyState icon="📈" title="No submitted inspections yet" subtitle="Trends appear once inspections are submitted for this property" /></Widget>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Widget title="Overall score over time">
        {t.points.length < 2
          ? <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '8px 4px' }}>
              One inspection so far (overall {t.points[0].overall?.toFixed(2) ?? '—'}). A trend line appears after the second submitted inspection.
            </div>
          : <><LineChart points={t.points.map(p => ({ x: p.date, y: p.overall }))} height={isPhone ? 150 : 190} />
              {t.overallDelta != null && <DeltaLine label="vs previous inspection" delta={t.overallDelta} />}
            </>}
      </Widget>

      {t.sections.length > 0 && (
        <Widget title="By section (latest vs previous)">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {t.sections.map(s => (
              <div key={s.title} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: 'var(--text)', marginBottom: 3 }}>{s.title}</div>
                  <div style={{ height: 8, borderRadius: 3, background: 'var(--surface-2)', overflow: 'hidden' }}>
                    {s.latest != null && <div style={{ width: `${(s.latest / 5) * 100}%`, height: 8, background: scoreColor(Math.round(s.latest)) }} />}
                  </div>
                </div>
                <div style={{ width: 42, textAlign: 'right', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{s.latest == null ? 'N/A' : s.latest.toFixed(1)}</div>
                <div style={{ width: 54, textAlign: 'right' }}>{s.delta == null ? <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>—</span> : <DeltaChip delta={s.delta} />}</div>
              </div>
            ))}
          </div>
        </Widget>
      )}
    </div>
  )
}

function DeltaChip({ delta }: { delta: number }) {
  const flat = Math.abs(delta) < 0.05
  const color = flat ? 'var(--text-faint)' : delta > 0 ? '#4e8f60' : '#c25b52'
  const arrow = flat ? '→' : delta > 0 ? '▲' : '▼'
  return <span style={{ fontSize: 11.5, fontWeight: 700, color }}>{arrow} {delta > 0 ? '+' : ''}{delta.toFixed(1)}</span>
}
function DeltaLine({ label, delta }: { label: string; delta: number }) {
  return <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>Change {label}: <DeltaChip delta={delta} /></div>
}

// lightweight SVG line chart (0–5 scale)
function LineChart({ points, height }: { points: { x: string; y: number | null }[]; height: number }) {
  const W = 600, H = height, padL = 26, padB = 22, padT = 10, padR = 10
  const xs = points.length
  const px = (i: number) => padL + (xs <= 1 ? 0 : (i / (xs - 1)) * (W - padL - padR))
  const py = (v: number) => padT + (1 - v / 5) * (H - padT - padB)
  const pts = points.map((p, i) => ({ i, v: p.y, cx: px(i), cy: p.y == null ? null : py(p.y), label: p.x }))
  const path = pts.filter(p => p.cy != null).map((p, k) => `${k === 0 ? 'M' : 'L'} ${p.cx.toFixed(1)} ${(p.cy as number).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} preserveAspectRatio="xMidYMid meet">
      {[0, 1, 2, 3, 4, 5].map(g => (
        <g key={g}>
          <line x1={padL} y1={py(g)} x2={W - padR} y2={py(g)} stroke="var(--border)" strokeWidth={0.5} />
          <text x={padL - 5} y={py(g) + 3} textAnchor="end" fontSize={8} fill="var(--text-faint)">{g}</text>
        </g>
      ))}
      {path && <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} />}
      {pts.map(p => p.cy != null && (
        <circle key={p.i} cx={p.cx} cy={p.cy} r={3} fill="var(--accent)" />
      ))}
      {pts.map(p => (
        <text key={`t${p.i}`} x={p.cx} y={H - 7} textAnchor="middle" fontSize={7.5} fill="var(--text-faint)">
          {new Date(p.label + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </text>
      ))}
    </svg>
  )
}

// ── composer ─────────────────────────────────────────────────────────────────

export function Composer({ isPhone, propertyId, propertyName, initial, defaultKind, defaultInspector, uploadedBy, onCancel, onDone, doneLabel = 'Back to history' }: {
  isPhone: boolean
  propertyId: string
  propertyName: string
  initial: EditableInspection | null
  defaultKind: FormKind
  defaultInspector: string
  uploadedBy: string | null
  onCancel: () => void
  onDone: () => void
  doneLabel?: string
}) {
  const startKind = initial?.kind ?? defaultKind
  const [kind, setKind] = useState<FormKind>(startKind)
  const [sections, setSections] = useState<SectionResponse[]>(() =>
    (initial ? initial.sections : blankResponses(startKind)).map(s => ({ title: s.title, items: s.items.map(it => ({ ...it, photos: [] })) })))
  const [photos, setPhotos] = useState<Record<number, PhotoRef[]>>(() => {
    if (!initial) return {}
    const m: Record<number, PhotoRef[]> = {}
    for (const sec of initial.sections) for (const it of sec.items) {
      if (it.photos?.length) m[it.n] = it.photos.map(k => ({ id: k, key: k, url: initial.photoUrls[k] ?? '' }))
    }
    return m
  })
  const [date, setDate] = useState(initial?.inspectionDate ?? today())
  const [inspector, setInspector] = useState(initial?.inspectedBy ?? defaultInspector)
  const [weather, setWeather] = useState(initial?.weather ?? '')
  const [events, setEvents] = useState(initial?.specialEvents ?? '')
  const [comments, setComments] = useState(initial?.comments ?? '')
  const [actions, setActions] = useState(initial?.actionItems ?? '')
  const [open, setOpen] = useState<number | null>(isPhone ? 0 : null)   // accordion index on phone; null = all open (desktop)

  const [busy, setBusy] = useState<null | 'draft' | 'submit'>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ pdfUrl: string | null } | null>(null)

  const score = useMemo(() => scoreOf(sections), [sections])

  function switchKind(next: FormKind) {
    if (next === kind) return
    const hasData = score.scored > 0 || Object.keys(photos).length > 0
    if (hasData && !window.confirm('Switching the form type clears entries so far. Continue?')) return
    Object.values(photos).flat().forEach(p => { if (p.file) URL.revokeObjectURL(p.url) })
    setKind(next); setSections(blankResponses(next)); setPhotos({})
  }

  function patchItem(si: number, ii: number, patch: Partial<SectionResponse['items'][number]>) {
    setSections(prev => prev.map((s, i) => i !== si ? s : { ...s, items: s.items.map((it, j) => j !== ii ? it : { ...it, ...patch }) }))
  }
  function addPhotos(n: number, files: FileList | null) {
    if (!files?.length) return
    const drafts = Array.from(files).filter(f => f.type.startsWith('image/')).map(f => ({ id: crypto.randomUUID(), url: URL.createObjectURL(f), file: f }))
    setPhotos(prev => ({ ...prev, [n]: [...(prev[n] ?? []), ...drafts] }))
  }
  function removePhoto(n: number, id: string) {
    setPhotos(prev => {
      const arr = prev[n] ?? []
      const t = arr.find(r => r.id === id)
      if (t?.file) URL.revokeObjectURL(t.url)
      return { ...prev, [n]: arr.filter(r => r.id !== id) }
    })
  }

  async function save(status: 'draft' | 'submitted') {
    if (busy) return
    if (status === 'submitted' && score.scored === 0) { setError('Score at least one item before submitting.'); return }
    if (status === 'submitted' && score.needNote > 0 && !window.confirm(`${score.needNote} item(s) scored 1, 2 or 5 have no note. Submit anyway?`)) return
    setError(null); setBusy(status === 'draft' ? 'draft' : 'submit')
    try {
      const sectionsForPersist: SectionResponse[] = sections.map(sec => ({
        title: sec.title,
        items: sec.items.map(it => ({ ...it, photos: (photos[it.n] ?? []).filter(r => r.key).map(r => r.key as string) })),
      }))
      const newPhotos: Record<number, File[]> = {}
      for (const [n, refs] of Object.entries(photos)) {
        const files = refs.filter(r => r.file).map(r => r.file as File)
        if (files.length) newPhotos[Number(n)] = files
      }
      const res = await persistInspection({
        id: initial?.id, status, propertyId, propertyName, kind,
        inspectionDate: date, inspectedBy: inspector, weather, specialEvents: events,
        comments, actionItems: actions, sections: sectionsForPersist, newPhotos, uploadedBy,
      })
      Object.values(photos).flat().forEach(p => { if (p.file) URL.revokeObjectURL(p.url) })
      if (status === 'draft') onDone()
      else setDone({ pdfUrl: res.pdfUrl })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (done) {
    return (
      <Widget title="Inspection submitted">
        <div style={{ padding: '8px 4px' }}>
          <div style={{ fontSize: 14, color: 'var(--text)', marginBottom: 6 }}>✓ Recorded for <strong>{propertyName}</strong> — overall {score.average?.toFixed(2) ?? '—'}/5.</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 16 }}>The PDF report was filed to the property's documents and the score history was updated.</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {done.pdfUrl && <a href={done.pdfUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12.5, fontWeight: 600, padding: '9px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', textDecoration: 'none' }}>View PDF report</a>}
            <button onClick={onDone} style={{ fontSize: 12.5, fontWeight: 600, padding: '9px 16px', borderRadius: 8, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer' }}>{doneLabel}</button>
          </div>
        </div>
      </Widget>
    )
  }

  const actionBar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <ScoreBadge avg={score.average} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text)' }}>
          <strong>{score.average != null ? score.average.toFixed(2) : '—'}</strong> · {score.scored} scored
          {score.flagged ? <span style={{ color: '#c25b52' }}> · {score.flagged} flagged</span> : null}
        </div>
        {score.needNote > 0 && <div style={{ fontSize: 10.5, color: '#c2a35a' }}>{score.needNote} need a note</div>}
      </div>
      <button onClick={() => void save('draft')} disabled={!!busy}
        style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 7, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text)', cursor: busy ? 'default' : 'pointer' }}>
        {busy === 'draft' ? 'Saving…' : 'Save draft'}
      </button>
      <button onClick={() => void save('submitted')} disabled={!!busy}
        style={{ fontSize: 12.5, fontWeight: 700, padding: '9px 18px', borderRadius: 7, border: 'none', background: busy ? 'var(--surface-2)' : 'var(--accent)', color: busy ? 'var(--text-muted)' : '#fff', cursor: busy ? 'default' : 'pointer' }}>
        {busy === 'submit' ? 'Submitting…' : 'Submit'}
      </button>
    </div>
  )

  return (
    <div style={{ paddingBottom: isPhone ? 84 : 0 }}>
      {/* header card */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)', padding: 16, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['retail', 'office'] as FormKind[]).map(k => (
              <button key={k} onClick={() => switchKind(k)}
                style={{ fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 999, textTransform: 'capitalize',
                  border: `1px solid ${kind === k ? 'var(--accent)' : 'var(--border-2)'}`, background: kind === k ? 'var(--accent-dim)' : 'transparent', color: kind === k ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer' }}>
                {k}
              </button>
            ))}
          </div>
          <button onClick={onCancel} disabled={!!busy} style={{ fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border-2)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>Cancel</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
          <Field label="Date of inspection"><input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} /></Field>
          <Field label="Inspected by"><input value={inspector} onChange={e => setInspector(e.target.value)} placeholder="Name" style={inputStyle} /></Field>
          <Field label="Weather conditions"><input value={weather} onChange={e => setWeather(e.target.value)} placeholder="e.g. Clear, 72°" style={inputStyle} /></Field>
          <Field label="Special events / promotions"><input value={events} onChange={e => setEvents(e.target.value)} placeholder="Optional" style={inputStyle} /></Field>
        </div>
        {!isPhone && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.5, marginTop: 14 }}>{INSTRUCTIONS}</div>}
        {!isPhone && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
            {SCORE_LEGEND.map(l => (
              <span key={l.score} style={{ fontSize: 10.5, color: 'var(--text-faint)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 14, height: 14, borderRadius: 3, background: scoreColor(l.score), color: '#fff', fontSize: 8.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{l.score}</span>
                {l.label}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* desktop: top sticky bar */}
      {!isPhone && (
        <div style={{ position: 'sticky', top: 8, zIndex: 5, padding: '10px 16px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-2)', marginBottom: 14, boxShadow: '0 1px 6px rgba(0,0,0,0.08)' }}>
          {actionBar}
        </div>
      )}

      {error && <div style={{ fontSize: 12.5, color: 'var(--red)', marginBottom: 12, padding: '8px 12px', border: '1px solid var(--red)', borderRadius: 6 }}>{error}</div>}

      {/* sections */}
      {sections.map((sec, si) => {
        const secScored = sec.items.filter(it => !it.na && it.score != null).length
        const collapsed = isPhone && open !== si
        return (
          <div key={sec.title} style={{ marginBottom: isPhone ? 8 : 18 }}>
            <div
              onClick={isPhone ? () => setOpen(open === si ? -1 : si) : undefined}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: isPhone ? 'pointer' : 'default',
                fontSize: 12.5, fontWeight: 700, letterSpacing: 0.4, color: 'var(--text-muted)', padding: isPhone ? '12px 12px' : '4px 2px 8px',
                borderBottom: isPhone ? 'none' : '2px solid var(--border)', border: isPhone ? '1px solid var(--border)' : undefined,
                borderRadius: isPhone ? 8 : 0, background: isPhone ? 'var(--surface)' : undefined, marginBottom: isPhone ? 0 : 8 }}>
              <span style={{ textTransform: 'uppercase' }}>{sec.title}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)' }}>{secScored}/{sec.items.length}{isPhone ? (collapsed ? '  ▸' : '  ▾') : ''}</span>
            </div>
            {!collapsed && sec.items.map((it, ii) => (
              <ItemRow key={it.n} isPhone={isPhone} n={it.n} label={it.label}
                na={it.na} yn={it.yn} scoreVal={it.score} detail={it.detail}
                photos={photos[it.n] ?? []}
                onChange={patch => patchItem(si, ii, patch)}
                onAddPhotos={files => addPhotos(it.n, files)}
                onRemovePhoto={id => removePhoto(it.n, id)} />
            ))}
          </div>
        )
      })}

      <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginTop: 8, marginBottom: 16 }}>
        <Field label="Comments"><textarea value={comments} onChange={e => setComments(e.target.value)} rows={4} style={{ ...inputStyle, resize: 'vertical' }} /></Field>
        <Field label="Action items"><textarea value={actions} onChange={e => setActions(e.target.value)} rows={4} style={{ ...inputStyle, resize: 'vertical' }} /></Field>
      </div>

      {/* desktop bottom buttons */}
      {!isPhone && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingBottom: 40 }}>
          <button onClick={() => void save('draft')} disabled={!!busy} style={{ fontSize: 12.5, fontWeight: 600, padding: '9px 18px', borderRadius: 8, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer' }}>{busy === 'draft' ? 'Saving…' : 'Save draft'}</button>
          <button onClick={() => void save('submitted')} disabled={!!busy} style={{ fontSize: 12.5, fontWeight: 700, padding: '9px 22px', borderRadius: 8, border: 'none', background: busy ? 'var(--surface-2)' : 'var(--accent)', color: busy ? 'var(--text-muted)' : '#fff', cursor: 'pointer' }}>{busy === 'submit' ? 'Submitting…' : 'Submit'}</button>
        </div>
      )}

      {/* phone: sticky bottom action bar */}
      {isPhone && (
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 20, padding: '10px 14px', background: 'var(--surface)', borderTop: '1px solid var(--border)', boxShadow: '0 -2px 10px rgba(0,0,0,0.12)' }}>
          {actionBar}
        </div>
      )}
    </div>
  )
}

// ── item row ─────────────────────────────────────────────────────────────────

function ItemRow({ isPhone, n, label, na, yn, scoreVal, detail, photos, onChange, onAddPhotos, onRemovePhoto }: {
  isPhone: boolean
  n: number
  label: string
  na: boolean
  yn: YesNo | null
  scoreVal: number | null
  detail: string
  photos: PhotoRef[]
  onChange: (patch: Partial<SectionResponse['items'][number]>) => void
  onAddPhotos: (files: FileList | null) => void
  onRemovePhoto: (id: string) => void
}) {
  const needNote = !na && (scoreVal === 1 || scoreVal === 2 || scoreVal === 5) && !detail.trim()
  const sBtn = isPhone ? 42 : 30
  return (
    <div style={{ padding: isPhone ? '12px' : '10px 12px', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 6, background: na ? 'var(--surface-2)' : 'var(--surface)', opacity: na ? 0.7 : 1 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <span style={{ fontSize: 11, color: 'var(--text-faint)', width: 18, flexShrink: 0, paddingTop: 2 }}>{n}</span>
        <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text)', lineHeight: 1.45 }}>{label}</span>
      </div>
      <div style={{ display: 'flex', gap: isPhone ? 10 : 16, alignItems: 'center', flexWrap: 'wrap', marginTop: 10, marginLeft: isPhone ? 0 : 28 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['yes', 'no'] as YesNo[]).map(v => (
            <button key={v} disabled={na} onClick={() => onChange({ yn: yn === v ? null : v })}
              style={{ fontSize: 12, fontWeight: 600, padding: isPhone ? '8px 16px' : '4px 12px', borderRadius: 6, textTransform: 'uppercase', cursor: na ? 'default' : 'pointer',
                border: `1px solid ${yn === v ? 'var(--accent)' : 'var(--border-2)'}`, background: yn === v ? 'var(--accent-dim)' : 'transparent', color: yn === v ? 'var(--accent)' : 'var(--text-faint)' }}>
              {v === 'yes' ? 'Y' : 'N'}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {[1, 2, 3, 4, 5].map(s => (
            <button key={s} disabled={na} onClick={() => onChange({ score: scoreVal === s ? null : s })}
              style={{ width: sBtn, height: sBtn, borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: na ? 'default' : 'pointer',
                border: scoreVal === s ? 'none' : '1px solid var(--border-2)', background: scoreVal === s ? scoreColor(s) : 'transparent', color: scoreVal === s ? '#fff' : 'var(--text-faint)' }}>
              {s}
            </button>
          ))}
        </div>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          <input type="checkbox" checked={na} onChange={e => onChange({ na: e.target.checked, ...(e.target.checked ? { score: null, yn: null } : {}) })} style={{ width: 16, height: 16 }} />
          N/A
        </label>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          📷 Photo
          <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => { onAddPhotos(e.target.files); e.currentTarget.value = '' }} />
        </label>
      </div>

      {needNote && <div style={{ fontSize: 10.5, color: '#c2a35a', marginLeft: isPhone ? 0 : 28, marginTop: 6 }}>A score of {scoreVal} should include a note.</div>}

      <div style={{ marginLeft: isPhone ? 0 : 28, marginTop: 8 }}>
        <textarea value={detail} onChange={e => onChange({ detail: e.target.value })} placeholder="Detail / notes" rows={2}
          style={{ ...inputStyle, width: '100%', resize: 'vertical', borderColor: needNote ? '#c2a35a' : 'var(--border-2)' }} />
      </div>

      {photos.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginLeft: isPhone ? 0 : 28, marginTop: 8 }}>
          {photos.map(p => (
            <div key={p.id} style={{ position: 'relative' }}>
              {p.url
                ? <img src={p.url} alt="" style={{ width: isPhone ? 96 : 84, height: isPhone ? 72 : 63, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border-2)' }} />
                : <div style={{ width: isPhone ? 96 : 84, height: isPhone ? 72 : 63, borderRadius: 6, border: '1px solid var(--border-2)', background: 'var(--surface-2)' }} />}
              <button onClick={() => onRemovePhoto(p.id)} title="Remove"
                style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 999, border: 'none', background: 'var(--red)', color: '#fff', fontSize: 12, lineHeight: '20px', cursor: 'pointer', padding: 0 }}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 5 }}>{label}</div>
      {children}
    </label>
  )
}

const inputStyle: CSSProperties = {
  background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 6,
  color: 'var(--text)', fontSize: 13, padding: '9px 10px', width: '100%', fontFamily: 'inherit',
}
