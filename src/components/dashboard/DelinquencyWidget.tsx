import { useState } from 'react'
import { Widget, WidgetSkeleton, WidgetPropertyChip, usePropertyChip, ExpandToggle } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { useDelinquency } from '../../hooks/useDashboard'

const fmtDollar = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

interface DelinquencyWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
}

const COLLAPSED = 6

export function DelinquencyWidget({ propertyIds, propertyNames }: DelinquencyWidgetProps) {
  const [expanded, setExpanded] = useState(false)
  const { sel, setSel, effectiveIds } = usePropertyChip(propertyIds)
  const { data, loading, error } = useDelinquency(effectiveIds, propertyNames)
  const rows = data ?? []
  const totalPastDue = rows.reduce((s, r) => s + r.pastDue, 0)
  const asOf = rows[0]?.asOf
  const shown = expanded ? rows : rows.slice(0, COLLAPSED)
  // Count + as-of live in the summary banner, not the header chip — the header
  // only fits the property filter without squeezing the title onto two lines.
  const countLabel = `${rows.length} tenant${rows.length === 1 ? '' : 's'} past due${asOf ? ` · as of ${asOf}` : ''}`

  return (
    <Widget
      title="Delinquency Tracker"
      chip={propertyIds.length > 1
        ? <WidgetPropertyChip scopeIds={propertyIds} propertyNames={propertyNames} value={sel} onChange={setSel} />
        : undefined}
      href="/receivables"
    >
      {loading && <WidgetSkeleton rows={3} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <EmptyState icon="✅" title="No delinquencies" subtitle="No past-due balances in the latest A/R aging" />
      )}
      {!loading && !error && rows.length > 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12, padding: '8px 10px', background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 7 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, color: 'var(--red)' }}>Total Past Due (30d+)</div>
              <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{countLabel}</div>
            </div>
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--red)', whiteSpace: 'nowrap' }}>{fmtDollar(totalPastDue)}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {shown.map(row => {
              const worst = row.b120 > 0 ? '120d+' : row.b90 > 0 ? '90d' : row.b60 > 0 ? '60d' : '30d'
              return (
                <div
                  key={row.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', background: 'var(--surface-2)', borderRadius: 7, border: '1px solid var(--border-2)' }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {row.tenantName}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {row.propertyName}{row.suite ? ` · ${row.suite}` : ''}
                    </div>
                  </div>
                  {/* Fixed-width slot keeps the badges in a straight column even
                      though the amounts to their right vary in width. */}
                  <span style={{ width: 46, display: 'flex', justifyContent: 'center', flex: 'none' }}>
                    <Badge variant={worst === '30d' ? 'amber' : 'red'}>{worst}</Badge>
                  </span>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--red)', fontVariantNumeric: 'tabular-nums', minWidth: 80, textAlign: 'right' }}>
                    {fmtDollar(row.pastDue)}
                  </div>
                </div>
              )
            })}
          </div>
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
