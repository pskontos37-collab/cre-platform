import { Widget, WidgetSkeleton } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { useDelinquency } from '../../hooks/useDashboard'

const fmtDollar = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

interface DelinquencyWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
}

export function DelinquencyWidget({ propertyIds, propertyNames }: DelinquencyWidgetProps) {
  const { data, loading, error } = useDelinquency(propertyIds, propertyNames)
  const rows = data ?? []
  const totalBalance = rows.reduce((s, r) => s + r.balance, 0)

  return (
    <Widget
      title="Delinquency Tracker"
      chip={rows.length > 0 ? `${rows.length} overdue` : undefined}
    >
      {loading && <WidgetSkeleton rows={3} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <EmptyState icon="✅" title="No delinquencies" subtitle="All payments are current" />
      )}
      {!loading && !error && rows.length > 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, padding: '8px 10px', background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 7 }}>
            <span style={{ fontSize: 11, color: 'var(--red)' }}>Total Outstanding</span>
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--red)' }}>{fmtDollar(totalBalance)}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {rows.map(row => (
              <div
                key={row.id}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', background: 'var(--surface-2)', borderRadius: 7, border: '1px solid var(--border-2)' }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.tenantName}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                    {row.propertyName} · Due {row.dueDate}
                  </div>
                </div>
                <Badge variant={agingBadge(row.daysLate)}>
                  {row.daysLate}d late
                </Badge>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--red)', fontVariantNumeric: 'tabular-nums', minWidth: 80, textAlign: 'right' }}>
                  {fmtDollar(row.balance)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Widget>
  )
}

function agingBadge(daysLate: number): 'amber' | 'red' {
  return daysLate > 30 ? 'red' : 'amber'
}
