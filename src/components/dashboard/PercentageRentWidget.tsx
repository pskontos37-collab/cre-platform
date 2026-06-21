import { Widget, WidgetSkeleton } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { usePercentageRent } from '../../hooks/useDashboard'

const fmtDollar = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const fmtPct = (n: number) => (n * 100).toFixed(1) + '%'

interface PercentageRentWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
}

export function PercentageRentWidget({ propertyIds, propertyNames }: PercentageRentWidgetProps) {
  const { data, loading, error } = usePercentageRent(propertyIds, propertyNames)
  const rows = data ?? []
  const triggeredCount = rows.filter(r => r.willTrigger).length

  return (
    <Widget
      title="Percentage Rent Breakpoints"
      chip={triggeredCount > 0 ? `${triggeredCount} triggered` : `${rows.length} leases`}
    >
      {loading && <WidgetSkeleton rows={3} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <EmptyState icon="📈" title="No percentage rent leases" subtitle="No active leases with percentage rent clauses" />
      )}
      {!loading && !error && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map(row => (
            <div
              key={row.leaseId}
              style={{
                padding:      '10px 12px',
                background:   'var(--surface-2)',
                borderRadius: 8,
                border:       `1px solid ${row.willTrigger ? 'var(--green-border)' : 'var(--border-2)'}`,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{row.tenantName}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{row.propertyName}</div>
                </div>
                {row.willTrigger ? (
                  <Badge variant="green">Triggered</Badge>
                ) : (
                  <Badge variant="gray">Below BP</Badge>
                )}
              </div>

              {/* Progress bar toward breakpoint */}
              <div style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                    YTD Sales: <span style={{ color: 'var(--text-muted)' }}>{fmtDollar(row.ytdSales)}</span>
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                    Breakpoint: <span style={{ color: 'var(--text-muted)' }}>{fmtDollar(row.effectiveBreakpoint)}</span>
                  </span>
                </div>
                <div style={{ height: 6, background: 'var(--surface)', borderRadius: 99, overflow: 'hidden' }}>
                  <div
                    style={{
                      width:      `${Math.min(row.pctToBreakpoint * 100, 100)}%`,
                      height:     '100%',
                      background: row.willTrigger ? 'var(--green)' : row.pctToBreakpoint > 0.75 ? 'var(--amber)' : 'var(--accent)',
                      borderRadius: 99,
                    }}
                  />
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 2 }}>
                  {fmtPct(row.pctToBreakpoint)} of breakpoint reached
                </div>
              </div>

              {row.willTrigger && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                    Rate: {row.pctRate != null ? fmtPct(row.pctRate) : '—'}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--green)' }}>
                    Est. Pct Rent: {fmtDollar(row.estimatedPctRent)}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Widget>
  )
}
