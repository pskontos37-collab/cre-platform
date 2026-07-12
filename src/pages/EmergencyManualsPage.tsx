import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useQuery } from '../hooks/useQuery'
import { supabase } from '../lib/supabase'
import { Widget, WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'

// Firm-wide reference library of the annual emergency-preparedness deliverables
// each managed property completes: the Emergency Procedures Manual and its Active
// Shooter training/drill recap (emergency_manuals table, doc_kind column, storage
// keys under emergency-manuals/ in the documents bucket). Read-only: view the PDF
// in the browser or download the original. Grouped by property, each doc kind
// showing the current file on top with prior years folded underneath.

type DocKind = 'manual' | 'active_shooter'

interface ManualRow {
  id: string
  property_name: string
  portfolio: string | null
  doc_kind: DocKind
  manual_year: number | null
  is_current: boolean
  version_label: string | null
  file_name: string
  file_path: string
  pdf_path: string | null
  source_path: string | null
  updated_at: string
  pdfUrl: string | null
  downloadUrl: string | null
}

const KIND_LABEL: Record<DocKind, string> = {
  manual: 'Emergency Procedures Manual',
  active_shooter: 'Active Shooter Training',
}
// display order of the kinds within a property card
const KIND_ORDER: DocKind[] = ['manual', 'active_shooter']

function useEmergencyManuals() {
  return useQuery<ManualRow[]>(async () => {
    const { data, error } = await supabase
      .from('emergency_manuals')
      .select('id, property_name, portfolio, doc_kind, manual_year, is_current, version_label, file_name, file_path, pdf_path, source_path, updated_at')
      .eq('is_active', true)
      .order('property_name')
      .order('doc_kind')
      .order('manual_year', { ascending: false })
      .order('sort_order')
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as Omit<ManualRow, 'pdfUrl' | 'downloadUrl'>[]

    const paths = [...new Set(rows.flatMap(r => [r.file_path, r.pdf_path]).filter((p): p is string => !!p))]
    const signed = new Map<string, string>()
    // sign in chunks so a big library stays under any URL/body limits
    for (let i = 0; i < paths.length; i += 80) {
      const slice = paths.slice(i, i + 80)
      const { data: s } = await supabase.storage.from('documents').createSignedUrls(slice, 3600)
      for (const it of s ?? []) if (it.path && it.signedUrl) signed.set(it.path, it.signedUrl)
    }

    return rows.map(r => ({
      ...r,
      pdfUrl: r.pdf_path ? signed.get(r.pdf_path) ?? null : null,
      downloadUrl: signed.has(r.file_path) ? `${signed.get(r.file_path)}&download=${encodeURIComponent(r.file_name)}` : null,
    }))
  }, [])
}

const btnStyle = (primary: boolean): CSSProperties => ({
  fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, textDecoration: 'none',
  border: primary ? 'none' : '1px solid var(--border-2)',
  background: primary ? 'var(--accent)' : 'var(--surface-2)',
  color: primary ? '#fff' : 'var(--text)', whiteSpace: 'nowrap',
})

const badgeStyle: CSSProperties = {
  fontSize: 10, color: 'var(--text-faint)', border: '1px solid var(--border-2)',
  borderRadius: 10, padding: '1px 8px', whiteSpace: 'nowrap',
}

function ManualLinks({ r }: { r: ManualRow }) {
  const isPdfSource = /\.pdf$/i.test(r.file_name)
  // The raw file name is kept off the screen for a cleaner layout; surface it on
  // hover of the links (title tooltip) for anyone who wants to confirm the file.
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {r.pdfUrl && <a href={r.pdfUrl} target="_blank" rel="noopener noreferrer" title={r.file_name} style={btnStyle(true)}>View PDF</a>}
      {r.downloadUrl && (
        <a href={r.downloadUrl} title={r.file_name} style={btnStyle(false)}>{isPdfSource ? 'Download PDF' : 'Download Word'}</a>
      )}
    </div>
  )
}

// One document kind within a property (e.g. the Manual, or Active Shooter):
// current on top, prior years collapsible.
function KindBlock({ kind, rows }: { kind: DocKind; rows: ManualRow[] }) {
  const [showHistory, setShowHistory] = useState(false)
  const current = rows.find(r => r.is_current) ?? rows[0]
  const history = rows.filter(r => r.id !== current.id)

  return (
    <div>
      <div style={{
        fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
        color: 'var(--text-faint)', marginBottom: 6,
      }}>
        {KIND_LABEL[kind]}
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 13, color: 'var(--text)' }}>
              {current.manual_year ?? current.version_label ?? 'Current document'}
            </span>
            {current.version_label && current.manual_year && current.version_label !== String(current.manual_year) &&
              <span style={badgeStyle}>{current.version_label}</span>}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
            updated {new Date(current.updated_at).toLocaleDateString()}
          </div>
        </div>
        <ManualLinks r={current} />
      </div>

      {history.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button
            onClick={() => setShowHistory(v => !v)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600,
            }}
          >
            {showHistory ? '▾' : '▸'} {history.length} prior {history.length === 1 ? 'year' : 'years'}
          </button>
          {showHistory && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {history.map(r => (
                <div key={r.id} style={{ display: 'flex', gap: 16, alignItems: 'center', paddingLeft: 4 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{r.version_label ?? r.manual_year ?? 'Prior'}</span>
                  </div>
                  <ManualLinks r={r} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PropertyCard({ property, rows }: { property: string; rows: ManualRow[] }) {
  const portfolio = rows.find(r => r.portfolio)?.portfolio
  const kinds = KIND_ORDER
    .map(k => ({ kind: k, rows: rows.filter(r => r.doc_kind === k) }))
    .filter(g => g.rows.length > 0)

  return (
    <div style={{
      padding: '14px 16px', borderRadius: 8, border: '1px solid var(--border)',
      background: 'var(--surface)', marginBottom: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{property}</span>
        {portfolio && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{portfolio}</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {kinds.map(g => <KindBlock key={g.kind} kind={g.kind} rows={g.rows} />)}
      </div>
    </div>
  )
}

export function EmergencyManualsPage() {
  const manuals = useEmergencyManuals()
  const [q, setQ] = useState('')
  const rows = manuals.data ?? []

  const groups = useMemo(() => {
    const byProp = new Map<string, ManualRow[]>()
    for (const r of rows) {
      const arr = byProp.get(r.property_name) ?? []
      arr.push(r)
      byProp.set(r.property_name, arr)
    }
    const needle = q.trim().toLowerCase()
    return [...byProp.entries()]
      .filter(([name, rs]) =>
        !needle ||
        name.toLowerCase().includes(needle) ||
        (rs[0].portfolio ?? '').toLowerCase().includes(needle))
      .sort((a, b) => a[0].localeCompare(b[0]))
  }, [rows, q])

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Emergency Manuals</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18 }}>
        The emergency-preparedness deliverables each managed property completes annually — the Emergency
        Procedures Manual and its Active Shooter training/drill recap. View the current document in the browser
        or download the original; prior years are kept as history. Need the blank manual template? It's on the{' '}
        <a href="/forms" style={{ color: 'var(--accent)' }}>Forms</a> page.
      </div>

      {manuals.loading && <Widget title="Emergency Manuals"><WidgetSkeleton rows={5} /></Widget>}
      {manuals.error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{manuals.error}</div>}

      {!manuals.loading && !manuals.error && rows.length === 0 && (
        <Widget title="Emergency Manuals">
          <EmptyState icon="🚨" title="No manuals published yet"
            subtitle="Property emergency manuals will appear here as they are added" />
        </Widget>
      )}

      {!manuals.loading && rows.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Filter by property…"
              style={{
                flex: 1, maxWidth: 320, fontSize: 13, padding: '7px 12px', borderRadius: 6,
                border: '1px solid var(--border-2)', background: 'var(--surface)', color: 'var(--text)',
              }}
            />
            <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
              {groups.length} {groups.length === 1 ? 'property' : 'properties'}
            </span>
          </div>
          {groups.map(([name, rs]) => <PropertyCard key={name} property={name} rows={rs} />)}
          {groups.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--text-faint)', padding: '8px 2px' }}>No properties match “{q}”.</div>
          )}
        </>
      )}
    </div>
  )
}
