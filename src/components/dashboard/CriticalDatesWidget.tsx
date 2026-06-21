import { Widget, WidgetSkeleton } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { useCriticalDates } from '../../hooks/useDashboard'

const DATE_LABELS: Record<string, string> = {
  option_notice_deadline: 'Option Notice',
  lease_expiration:       'Lease Exp.',
  rent_commencement:      'Rent Comm.',
  free_rent_end:          'Free Rent End',
  escalation:             'Escalation',
  loan_maturity:          'Loan Maturity',
  tax_appeal_deadline:    'Tax Appeal',
  inspection_due:         'Inspection',
  other:                  'Other',
}

interface CriticalDatesWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
}

export function CriticalDatesWidget({ propertyIds, propertyNames }: CriticalDatesWidgetProps) {
  const { data, loading, error } = useCriticalDates(propertyIds, propertyNames)
  const rows = data ?? []

  return (
    <Widget title="Critical Dates" chip="Next 90 days">
      {loading && <WidgetSkeleton rows={3} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <EmptyState icon="✅" title="No upcoming dates" subtitle="Nothing due in the next 90 days" />
      )}
      {!loading && !error && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map(row => (
            <div
              key={row.id}
              style={{
                display:      'flex',
                alignItems:   'center',
                gap:          10,
                padding:      '7px 10px',
                background:   'var(--surface-2)',
                borderRadius: 7,
                border:       `1px solid ${urgencyBorder(row.daysUntil)}`,
              }}
            >
              <div style={{ minWidth: 36, textAlign: 'center' }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: urgencyColor(row.daysUntil), lineHeight: 1 }}>
                  {row.daysUntil}
                </div>
                <div style={{ fontSize: 9, color: 'var(--text-faint)' }}>days</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {row.description ?? DATE_LABELS[row.dateType] ?? row.dateType}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{row.propertyName} · {row.dueDate}</div>
              </div>
              <Badge variant={urgencyBadge(row.daysUntil)}>
                {DATE_LABELS[row.dateType] ?? row.dateType}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </Widget>
  )
}

function urgencyColor(days: number) {
  if (days <= 14) return 'var(--red)'
  if (days <= 30) return 'var(--amber)'
  return 'var(--text-muted)'
}

function urgencyBorder(days: number) {
  if (days <= 14) return 'var(--red-border)'
  if (days <= 30) return 'var(--amber-border)'
  return 'var(--border-2)'
}

function urgencyBadge(days: number): 'red' | 'amber' | 'gray' {
  if (days <= 14) return 'red'
  if (days <= 30) return 'amber'
  return 'gray'
}
