import { useState } from 'react'
import { Widget, WidgetSkeleton, WidgetPropertyChip, usePropertyChip, ExpandToggle } from '../ui/Widget'
import { EmptyState } from '../ui/EmptyState'
import { useRentRoll } from '../../hooks/useRentRoll'

const sf = (n: number) => `${Math.round(n).toLocaleString('en-US')}`

const COLLAPSED = 6

export function RolloverWidget({ propertyIds, propertyNames }: { propertyIds: string[]; propertyNames: Record<string, string> }) {
  const [expanded, setExpanded] = useState(false)
  const { sel, setSel, effectiveIds } = usePropertyChip(propertyIds)
  const { data, loading, error } = useRentRoll(effectiveIds)

  return (
    <Widget
      title="Lease Rollover"
      chip={propertyIds.length > 1
        ? <WidgetPropertyChip scopeIds={propertyIds} propertyNames={propertyNames} value={sel} onChange={setSel} />
        : 'By expiration year'}
      href="/properties"
    >
      {loading && <WidgetSkeleton rows={6} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && (!data || data.rollover.length === 0) && (
        <EmptyState title="No expiration data" subtitle="Rent roll has no lease-end dates" />
      )}
      {!loading && !error && data && data.rollover.length > 0 && (
        <div>
          <div style={{ display: 'flex', gap: 24, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 2 }}>WALT</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>{data.walt.toFixed(1)} yrs</div>
            </div>
          </div>
          {(() => {
            const max = Math.max(...data.rollover.map(r => r.sf), 1)
            const visible = expanded ? data.rollover : data.rollover.slice(0, COLLAPSED)
            return visible.map(r => (
              <div key={r.year} style={{ padding: '4px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.year} · {r.count} {r.count === 1 ? 'lease' : 'leases'}</span>
                  <span style={{ fontSize: 12, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                    {sf(r.sf)} SF <span style={{ color: 'var(--text-faint)' }}>· {Math.round(r.pct * 100)}%</span>
                  </span>
                </div>
                <div style={{ height: 5, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(r.sf / max) * 100}%`, background: 'var(--accent)', opacity: 0.7 }} />
                </div>
              </div>
            ))
          })()}
          <ExpandToggle
            expanded={expanded}
            onToggle={() => setExpanded(e => !e)}
            collapsedCount={COLLAPSED}
            totalCount={data.rollover.length}
          />
        </div>
      )}
    </Widget>
  )
}
