import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Widget, WidgetSkeleton, ChipSelect, WidgetPropertyChip, usePropertyChip, ExpandToggle } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { useCriticalDates, type CriticalDateRow } from '../../hooks/useDashboard'
import { supabase } from '../../lib/supabase'

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

// Resolving removes the item from the widget (query filters is_completed=false).
const RESOLUTIONS = [
  { value: 'completed', label: 'Completed' },
  { value: 'exercised', label: 'Exercised' },
  { value: 'received',  label: 'Received' },
  { value: 'waived',    label: 'Waived' },
]

interface CriticalDatesWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
}

const COLLAPSED = 4

export function CriticalDatesWidget({ propertyIds, propertyNames }: CriticalDatesWidgetProps) {
  const [days, setDays] = useState(90)
  const [expanded, setExpanded] = useState(false)
  const { sel, setSel, effectiveIds } = usePropertyChip(propertyIds)
  const { data, loading, error, refetch } = useCriticalDates(effectiveIds, propertyNames, days)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const rows = data ?? []
  const visible = expanded ? rows : rows.slice(0, COLLAPSED)

  async function resolve(row: CriticalDateRow, status: string) {
    setBusy(row.id); setActionError(null)
    const { error: err } = await supabase
      .from('critical_dates')
      .update({ status, is_completed: true, completed_date: new Date().toISOString().slice(0, 10) })
      .eq('id', row.id)
    setBusy(null)
    if (err) setActionError(`Couldn't update: ${err.message}`)
    else refetch()
  }

  return (
    <Widget
      title="Critical Dates"
      chip={
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {propertyIds.length > 1 && (
            <WidgetPropertyChip scopeIds={propertyIds} propertyNames={propertyNames} value={sel} onChange={setSel} />
          )}
          <ChipSelect
            value={String(days)}
            onChange={v => setDays(Number(v))}
            options={[
              { value: '30', label: 'Next 30 days' },
              { value: '60', label: 'Next 60 days' },
              { value: '90', label: 'Next 90 days' },
            ]}
          />
        </span>
      }
    >
      {loading && <WidgetSkeleton rows={3} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {actionError && <div style={{ fontSize: 11, color: 'var(--red)', marginBottom: 6 }}>{actionError}</div>}
      {!loading && !error && rows.length === 0 && (
        <EmptyState icon="✅" title="No upcoming dates" subtitle={`Nothing open in the next ${days} days`} />
      )}
      {!loading && !error && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {visible.map(row => (
            <div
              key={row.id}
              style={{
                display:      'flex',
                alignItems:   'flex-start',
                gap:          10,
                padding:      '8px 10px',
                background:   'var(--surface-2)',
                borderRadius: 7,
                border:       `1px solid ${urgencyBorder(row.daysUntil)}`,
                opacity:      busy === row.id ? 0.5 : 1,
              }}
            >
              <div style={{ minWidth: 36, textAlign: 'center', paddingTop: 2 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: urgencyColor(row.daysUntil), lineHeight: 1 }}>
                  {row.daysUntil}
                </div>
                <div style={{ fontSize: 9, color: 'var(--text-faint)' }}>days</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 500, lineHeight: 1.45, whiteSpace: 'normal', wordBreak: 'break-word' }}>
                  {row.description ?? DATE_LABELS[row.dateType] ?? row.dateType}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 3 }}>
                  <Link to={`/properties/${row.propertyId}`} style={{ color: 'var(--accent)', textDecoration: 'none' }} title="Open property page">
                    {row.propertyName}
                  </Link>
                  {' '}· due {row.dueDate}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
                <Badge variant={urgencyBadge(row.daysUntil)}>
                  {DATE_LABELS[row.dateType] ?? row.dateType}
                </Badge>
                {/* Resolve: choosing a status removes the item from the list */}
                <select
                  value=""
                  disabled={busy === row.id}
                  onChange={e => { if (e.target.value) void resolve(row, e.target.value) }}
                  title="Mark this date resolved"
                  style={{
                    fontSize:     10,
                    color:        'var(--text-muted)',
                    background:   'var(--surface)',
                    border:       '1px solid var(--border-2)',
                    borderRadius: 6,
                    padding:      '2px 4px',
                    cursor:       'pointer',
                    outline:      'none',
                  }}
                >
                  <option value="">Mark ▾</option>
                  {RESOLUTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
            </div>
          ))}
          <ExpandToggle
            expanded={expanded}
            onToggle={() => setExpanded(e => !e)}
            collapsedCount={COLLAPSED}
            totalCount={rows.length}
          />
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
