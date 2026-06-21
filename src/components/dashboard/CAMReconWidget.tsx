import { Widget, WidgetSkeleton } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { useCAMRecon } from '../../hooks/useDashboard'

const fmtDollar = (n: number | null) =>
  n != null ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : '—'

interface CAMReconWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
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

export function CAMReconWidget({ propertyIds, propertyNames }: CAMReconWidgetProps) {
  const { data, loading, error } = useCAMRecon(propertyIds, propertyNames)
  const rows = data ?? []

  return (
    <Widget title="CAM Reconciliations" chip={rows.length > 0 ? `${rows.length} open` : undefined}>
      {loading && <WidgetSkeleton rows={3} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <EmptyState icon="✅" title="No open reconciliations" subtitle="All CAM recons are complete" />
      )}
      {!loading && !error && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
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
                <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{row.propertyName} · {row.periodYear}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 9, color: 'var(--text-faint)' }}>Estimated</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtDollar(row.estimatedAmount)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 9, color: 'var(--text-faint)' }}>Actual</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtDollar(row.actualAmount)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 9, color: 'var(--text-faint)' }}>Variance</div>
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
        </div>
      )}
    </Widget>
  )
}
