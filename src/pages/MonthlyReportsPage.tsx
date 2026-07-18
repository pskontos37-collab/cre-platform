import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useQuery } from '../hooks/useQuery'
import { supabase } from '../lib/supabase'
import { Widget, WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'

// Library of each property's FINAL monthly reporting PACKAGE (the consolidated
// PDF: cover + financials + rent roll + variance narrative + schedules) so staff
// can pull up any month for reference without digging through K:\. One row per
// (property, year, month) in the monthly_reports table; files are stored under
// p/<property_id>/monthly-reports/ in the documents bucket and served via signed
// URLs. Read-only, property-scoped by the same RLS as the rest of the app.

interface ReportRow {
  id: string
  property_id: string
  property_name: string
  report_year: number
  report_month: number
  is_current: boolean
  file_name: string
  file_path: string
  file_size_bytes: number | null
  source_path: string | null
  updated_at: string
  url: string | null
}

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

function fmtSize(bytes: number | null): string {
  if (!bytes) return ''
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function useMonthlyReports() {
  return useQuery<ReportRow[]>(async () => {
    const { data, error } = await supabase
      .from('monthly_reports')
      .select('id, property_id, property_name, report_year, report_month, is_current, file_name, file_path, file_size_bytes, source_path, updated_at')
      .eq('is_active', true)
      .order('property_name')
      .order('report_year', { ascending: false })
      .order('report_month', { ascending: false })
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as Omit<ReportRow, 'url'>[]

    const paths = [...new Set(rows.map(r => r.file_path))]
    const signed = new Map<string, string>()
    for (let i = 0; i < paths.length; i += 80) {
      const slice = paths.slice(i, i + 80)
      const { data: s } = await supabase.storage.from('documents').createSignedUrls(slice, 3600)
      for (const it of s ?? []) if (it.path && it.signedUrl) signed.set(it.path, it.signedUrl)
    }

    return rows.map(r => ({ ...r, url: signed.get(r.file_path) ?? null }))
  }, [])
}

const btnStyle = (primary: boolean): CSSProperties => ({
  fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, textDecoration: 'none',
  border: primary ? 'none' : '1px solid var(--border-2)',
  background: primary ? 'var(--accent)' : 'var(--surface-2)',
  color: primary ? '#fff' : 'var(--text)', whiteSpace: 'nowrap',
})

const currentBadge: CSSProperties = {
  fontSize: 10, fontWeight: 700, color: 'var(--accent)', border: '1px solid var(--accent)',
  borderRadius: 10, padding: '1px 8px', whiteSpace: 'nowrap',
}

function ReportRowView({ r, includeYear = false }: { r: ReportRow; includeYear?: boolean }) {
  return (
    <div className="monthly-report-row" style={{ display: 'flex', gap: 16, alignItems: 'center', padding: '6px 0' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600 }}>{MONTHS[r.report_month]}{includeYear ? ` ${r.report_year}` : ''}</span>
        {r.is_current && <span style={currentBadge}>Latest</span>}
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{fmtSize(r.file_size_bytes)}</span>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {r.url && <a href={r.url} target="_blank" rel="noopener noreferrer" title={r.file_name} style={btnStyle(true)}>View PDF</a>}
        {r.url && <a href={`${r.url}&download=${encodeURIComponent(r.file_name)}`} title={r.file_name} style={btnStyle(false)}>Download</a>}
      </div>
    </div>
  )
}

function YearBlock({ year, rows }: { year: number; rows: ReportRow[] }) {
  return (
    <div>
      <div style={{
        fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, color: 'var(--text-faint)', marginBottom: 2,
      }}>
        {year}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.map(r => <ReportRowView key={r.id} r={r} />)}
      </div>
    </div>
  )
}

function PropertyCard({ property, rows }: { property: string; rows: ReportRow[] }) {
  const latest = rows.find(r => r.is_current) ?? null
  const archiveRows = latest ? rows.filter(r => r.id !== latest.id) : rows
  const years = useMemo(() => {
    const byYear = new Map<number, ReportRow[]>()
    for (const r of archiveRows) {
      const arr = byYear.get(r.report_year) ?? []
      arr.push(r)
      byYear.set(r.report_year, arr)
    }
    return [...byYear.entries()].sort((a, b) => b[0] - a[0])
  }, [archiveRows])

  return (
    <div style={{
      padding: '14px 16px', borderRadius: 8, border: '1px solid var(--border)',
      background: 'var(--surface)', marginBottom: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{property}</span>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{rows.length} published {rows.length === 1 ? 'package' : 'packages'}</span>
      </div>
      {latest && (
        <div style={{ border: '1px solid var(--border-2)', background: 'var(--surface-2)', borderRadius: 8, padding: '7px 10px' }}>
          <div style={{ fontSize: 9.5, fontWeight: 750, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
            Current reporting package
          </div>
          <ReportRowView r={latest} includeYear />
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
            Published {new Date(latest.updated_at).toLocaleDateString()}{latest.file_name ? ` · ${latest.file_name}` : ''}
          </div>
        </div>
      )}
      {archiveRows.length > 0 && (
        latest ? (
          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)' }}>
              Browse {archiveRows.length} prior {archiveRows.length === 1 ? 'package' : 'packages'}
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 10 }}>
              {years.map(([year, rs]) => <YearBlock key={year} year={year} rows={rs} />)}
            </div>
          </details>
        ) : (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 7 }}>
              Matching published packages
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {years.map(([year, rs]) => <YearBlock key={year} year={year} rows={rs} />)}
            </div>
          </div>
        )
      )}
    </div>
  )
}

function ReportLibrarySummary({ rows }: { rows: ReportRow[] }) {
  const current = rows.filter(r => r.is_current).length
  const properties = new Set(rows.map(r => r.property_id)).size
  const lastUpdated = rows.reduce<string | null>((latest, r) => !latest || r.updated_at > latest ? r.updated_at : latest, null)
  const items = [
    { label: 'Properties', value: properties },
    { label: 'Current packages', value: current },
    { label: 'Published archive', value: rows.length },
    { label: 'Library updated', value: lastUpdated ? new Date(lastUpdated).toLocaleDateString() : '—' },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', gap: 8, marginBottom: 14 }}>
      {items.map(item => (
        <div key={item.label} style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)', padding: '9px 11px' }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{item.label}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginTop: 2 }}>{item.value}</div>
        </div>
      ))}
    </div>
  )
}

// Multi-select property picker: check one property or any combination. Live —
// toggling a box updates the filter immediately (no Apply step). Mirrors the
// header's property picker idiom (click-outside to close).
function PropertyMultiSelect({ options, selected, onToggle, onClear, onSelectAll }: {
  options: string[]
  selected: Set<string>
  onToggle: (name: string) => void
  onClear: () => void
  onSelectAll: () => void
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const count = selected.size
  const allSelected = count > 0 && count === options.length
  const active = count > 0 && !allSelected
  const label = count === 0 || allSelected ? 'All properties'
    : count === 1 ? [...selected][0]
    : `${count} properties`

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: active ? 'var(--accent-dim)' : 'var(--surface-2)',
          border: active ? '1px solid var(--accent)' : '1px solid var(--border-2)',
          borderRadius: 6, color: active ? 'var(--accent)' : 'var(--text-muted)',
          fontSize: 13, padding: '7px 12px', cursor: 'pointer', whiteSpace: 'nowrap',
          maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis',
        }}
      >
        {label} ▾
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, width: 320, maxHeight: 420,
          overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border-2)',
          borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.45)', zIndex: 50, padding: 8,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 6px 8px' }}>
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Pick one property or any combination</span>
            <div style={{ display: 'flex', gap: 12 }}>
              <button
                onClick={onSelectAll}
                style={{ fontSize: 10.5, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                Select all
              </button>
              <button
                onClick={onClear}
                style={{ fontSize: 10.5, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                Clear
              </button>
            </div>
          </div>
          {options.map(name => (
            <label
              key={name}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 6,
                cursor: 'pointer', fontSize: 12.5,
                color: selected.has(name) ? 'var(--text)' : 'var(--text-muted)',
                background: selected.has(name) ? 'var(--surface-2)' : 'transparent',
              }}
            >
              <input type="checkbox" checked={selected.has(name)} onChange={() => onToggle(name)} />
              <span style={{ flex: 1, minWidth: 0 }}>{name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

export function MonthlyReportsPage() {
  const reports = useMonthlyReports()
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const rows = reports.data ?? []

  // All property names present in the library — the dropdown's options.
  const allProps = useMemo(
    () => [...new Set(rows.map(r => r.property_name))].sort((a, b) => a.localeCompare(b)),
    [rows],
  )

  const toggleProp = (name: string) => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    return next
  })

  const groups = useMemo(() => {
    const byProp = new Map<string, ReportRow[]>()
    for (const r of rows) {
      if (selected.size > 0 && !selected.has(r.property_name)) continue
      const needle = q.trim().toLowerCase()
      const searchable = `${r.property_name} ${r.file_name} ${MONTHS[r.report_month]} ${r.report_year}`.toLowerCase()
      if (needle && !searchable.includes(needle)) continue
      const arr = byProp.get(r.property_name) ?? []
      arr.push(r)
      byProp.set(r.property_name, arr)
    }
    return [...byProp.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
  }, [rows, q, selected])

  return (
    <div className="monthly-reports-page" style={{ padding: '24px 32px', maxWidth: 1040 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Monthly Reports</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18 }}>
        The final monthly reporting package for each property — the consolidated PDF with financials, rent roll,
        variance narrative and supporting schedules. Pull up any month for reference; the most recent is marked
        “Latest.”
      </div>

      {reports.loading && <Widget title="Monthly Reports"><WidgetSkeleton rows={5} /></Widget>}
      {reports.error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{reports.error}</div>}

      {!reports.loading && !reports.error && rows.length === 0 && (
        <Widget title="Monthly Reports">
          <EmptyState icon="📑" title="No monthly reports published yet"
            subtitle="Final monthly reporting packages will appear here as they are added" />
        </Widget>
      )}

      {!reports.loading && rows.length > 0 && (
        <>
          <ReportLibrarySummary rows={rows} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
            <PropertyMultiSelect
              options={allProps}
              selected={selected}
              onToggle={toggleProp}
              onClear={() => setSelected(new Set())}
              onSelectAll={() => setSelected(new Set(allProps))}
            />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search property, month, year…"
              style={{
                flex: 1, minWidth: 180, maxWidth: 320, fontSize: 13, padding: '7px 12px', borderRadius: 6,
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
