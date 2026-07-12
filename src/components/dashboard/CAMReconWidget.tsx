import { useState } from 'react'
import { Widget, WidgetSkeleton } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { useCAMRecon } from '../../hooks/useDashboard'

const fmtDollar = (n: number | null) =>
  n != null ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : '—'

interface CAMReconWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
  // When set, only this many rows show initially with a "Show all" toggle —
  // used on the Financials page where the full list is rarely needed.
  previewCount?: number
}

const STATUS_BADGE: Record<string, 'amber' | 'red' | 'gray' | 'blue'> = {
  in_progress: 'blue',
  overdue:     'red',
  disputed:    'amber',
}

const STATUS_LABEL: Record<string, string> = {
  in_progress: 'In Progress',
  overdue:     'Overdue',
  disputed:    'Disputed',
}

const TYPE_LABEL: Record<string, string> = { cam: 'CAM', ins: 'INS', ret: 'RET' }

export function CAMReconWidget({ propertyIds, propertyNames, previewCount }: CAMReconWidgetProps) {
  const { data, loading, error } = useCAMRecon(propertyIds, propertyNames)
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [expanded, setExpanded] = useState(false)
  const all = data ?? []
  const typesPresent = Array.from(new Set(all.map(r => r.recType)))
  const filtered = typeFilter === 'all' ? all : all.filter(r => r.recType === typeFilter)
  const collapsed = previewCount != null && !expanded && filtered.length > previewCount
  const rows = collapsed ? filtered.slice(0, previewCount) : filtered

  return (
    <Widget title="Expense Reconciliations" chip={all.length > 0 ? `${all.length} open` : undefined}>
      {loading && <WidgetSkeleton rows={3} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && all.length === 0 && (
        <EmptyState icon="✅" title="No open reconciliations" subtitle="All CAM / INS / RET recons are complete" />
      )}
      {!loading && !error && all.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {typesPresent.length > 1 && (
            <div style={{ display: 'flex', gap: 4, marginBottom: 2 }}>
              {['all', ...typesPresent].map(t => (
                <button
                  key={t}
                  onClick={() => setTypeFilter(t)}
                  style={{
                    fontSize: 10,
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: `1px solid ${typeFilter === t ? 'var(--accent)' : 'var(--border-2)'}`,
                    background: typeFilter === t ? 'var(--accent-dim)' : 'transparent',
                    color: typeFilter === t ? 'var(--accent)' : 'var(--text-muted)',
                    cursor: 'pointer',
                  }}
                >
                  {t === 'all' ? `All (${all.length})` : `${TYPE_LABEL[t] ?? t} (${all.filter(r => r.recType === t).length})`}
                </button>
              ))}
            </div>
          )}
          {rows.map(row => (
            <div
              key={row.id}
              style={{
                display:   'grid',
                gridTemplateColumns: '1fr 80px 80px 80px 90px',
                gap:       8,
                alignItems:'center',
                padding:   '7px 10px',
                background:'var(--surface-2)',
                borderRadius: 7,
                border:    `1px solid ${row.status === 'overdue' ? 'var(--red-border)' : 'var(--border-2)'}`,
              }}
            >
              <div>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {row.tenantName ?? 'Unknown'}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                  {row.propertyName} · {row.periodYear} · {TYPE_LABEL[row.recType] ?? row.recType}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 9, color: 'var(--text-faint)' }}>Billed</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtDollar(row.estimatedAmount)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 9, color: 'var(--text-faint)' }}>Actual</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtDollar(row.actualAmount)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 9, color: 'var(--text-faint)' }}>True-up</div>
                <div style={{
                  fontSize: 11,
                  fontWeight: row.variance != null && Math.abs(row.variance) > 0 ? 600 : 400,
                  color: row.variance == null ? 'var(--text-faint)' : row.variance > 0 ? 'var(--amber)' : 'var(--green)',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {row.variance != null ? (row.variance > 0 ? '+' : '') + fmtDollar(row.variance) : '—'}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <Badge variant={STATUS_BADGE[row.status] ?? 'gray'}>
                  {STATUS_LABEL[row.status] ?? row.status}
                </Badge>
              </div>
            </div>
          ))}
          {previewCount != null && filtered.length > previewCount && (
            <button
              onClick={() => setExpanded(e => !e)}
              style={{
                marginTop: 3,
                fontSize: 11,
                fontWeight: 600,
                padding: '6px 0',
                borderRadius: 7,
                border: '1px dashed var(--border-2)',
                background: 'transparent',
                color: 'var(--accent)',
                cursor: 'pointer',
              }}
            >
              {expanded ? '▲ Show fewer' : `▼ Show all ${filtered.length}`}
            </button>
          )}
        </div>
      )}
    </Widget>
  )
}
