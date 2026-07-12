import { useState } from 'react'
import { Widget, WidgetSkeleton, ChipSelect, WidgetPropertyChip, usePropertyChip, ExpandToggle } from '../ui/Widget'
import { EmptyState } from '../ui/EmptyState'
import { useVendorSpendMulti, VendorWindow } from '../../hooks/useFinancials'

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const cleanVendor = (v: string | null) => (v ? v.replace(/\s*\(MRI-Property\)\s*$/i, '').trim() : '—')

const COLLAPSED = 7

export function TopVendorsWidget({ propertyIds, propertyNames }: { propertyIds: string[]; propertyNames: Record<string, string> }) {
  const [window, setWindow] = useState<VendorWindow>('ttm')
  const [expanded, setExpanded] = useState(false)
  const { sel, setSel, effectiveIds } = usePropertyChip(propertyIds)
  const { data, loading, error } = useVendorSpendMulti(effectiveIds, window)
  const rows = data ?? []
  const total = rows.reduce((s, v) => s + v.total_spend, 0)
  const max = Math.max(...rows.map(v => v.total_spend), 1)
  const visible = expanded ? rows : rows.slice(0, COLLAPSED)

  return (
    <Widget
      title="Top Vendors"
      href="/financials"
      chip={
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {propertyIds.length > 1 && (
            <WidgetPropertyChip scopeIds={propertyIds} propertyNames={propertyNames} value={sel} onChange={setSel} />
          )}
          <ChipSelect
            value={window}
            onChange={v => setWindow(v as VendorWindow)}
            options={[
              { value: 'ttm', label: 'Trailing 12 months' },
              { value: 'all', label: 'Since acquisition' },
            ]}
          />
        </span>
      }
    >
      {loading && <WidgetSkeleton rows={7} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <EmptyState title="No vendor data" subtitle={window === 'ttm' ? 'No AP activity in the last 12 months' : 'Load invoices to see vendor spend'} />
      )}
      {!loading && !error && rows.length > 0 && (
        <div>
          {visible.map((v, i) => (
            <div key={i} style={{ padding: '4px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2, gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {cleanVendor(v.vendor)}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {usd(v.total_spend)} <span style={{ color: 'var(--text-faint)' }}>· {total > 0 ? Math.round((v.total_spend / total) * 100) : 0}%</span>
                </span>
              </div>
              <div style={{ height: 4, background: 'var(--surface-2)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(v.total_spend / max) * 100}%`, background: 'var(--accent)', opacity: 0.7 }} />
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
