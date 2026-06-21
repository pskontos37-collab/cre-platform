import { Widget, WidgetSkeleton } from '../ui/Widget'
import { EmptyState } from '../ui/EmptyState'
import { useLeaseRollover } from '../../hooks/useDashboard'

const fmtSF = (n: number) => n.toLocaleString() + ' SF'
const fmtPct = (n: number) => (n * 100).toFixed(1) + '%'

interface LeaseRolloverWidgetProps {
  propertyIds: string[]
}

export function LeaseRolloverWidget({ propertyIds }: LeaseRolloverWidgetProps) {
  const { data, loading, error } = useLeaseRollover(propertyIds)

  const barColors = [
    'var(--accent)', 'var(--green)', 'var(--amber)',
    '#a78bfa', '#fb923c', '#34d399',
  ]

  return (
    <Widget title="Lease Rollover & WALT" chip={data?.totalLeasedSf ? fmtSF(data.totalLeasedSf) : undefined}>
      {loading && <WidgetSkeleton rows={4} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && !data?.byYear.length && (
        <EmptyState title="No active leases" subtitle="Add leases with expiration dates" />
      )}
      {!loading && !error && data && data.byYear.length > 0 && (
        <div>
          {/* WALT headline */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 2 }}>Weighted Avg. Lease Term</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: waltColor(data.walt), lineHeight: 1 }}>
              {data.walt.toFixed(1)}<span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4 }}>yrs</span>
            </div>
          </div>

          {/* Bar chart */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.byYear.map((y, i) => (
              <div key={y.year} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 40, fontVariantNumeric: 'tabular-nums' }}>
                  {y.year}
                </div>
                <div style={{ flex: 1, background: 'var(--surface-2)', borderRadius: 99, height: 12, overflow: 'hidden' }}>
                  <div
                    style={{
                      width:        `${Math.min(y.pctOfTotal * 100, 100)}%`,
                      height:       '100%',
                      background:   barColors[i % barColors.length],
                      borderRadius: 99,
                    }}
                  />
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 90, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtSF(y.sf)} · {y.count}L
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-faint)', minWidth: 42, textAlign: 'right' }}>
                  {fmtPct(y.pctOfTotal)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Widget>
  )
}

function waltColor(years: number) {
  if (years >= 5) return 'var(--green)'
  if (years >= 2) return 'var(--amber)'
  return 'var(--red)'
}
