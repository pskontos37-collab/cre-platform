import { useState } from 'react'
import { Widget, WidgetSkeleton, WidgetPropertyChip, usePropertyChip, ExpandToggle } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { useGlPnl, type PnlCatLine, type PropertyPnl } from '../../hooks/useGlPnl'

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const CARD_COLLAPSED = 6

const ratioOf = (t12: { revenue: number; opex: number }) =>
  t12.revenue > 0 ? `${Math.round((t12.opex / t12.revenue) * 100)}%` : '—'

export function OpexTrendWidget({ propertyIds, propertyNames }: { propertyIds: string[]; propertyNames: Record<string, string> }) {
  const { sel, setSel, effectiveIds } = usePropertyChip(propertyIds)
  const { data, loading, error } = useGlPnl(effectiveIds)
  const [showAll, setShowAll] = useState(false)

  const multi = (data?.byProperty.length ?? 0) > 1
  // Biggest spenders first.
  const cards = multi ? [...data!.byProperty].sort((a, b) => b.t12.opex - a.t12.opex) : []

  return (
    <Widget
      title="Operating Expenses"
      chip={propertyIds.length > 1
        ? <WidgetPropertyChip scopeIds={propertyIds} propertyNames={propertyNames} value={sel} onChange={setSel} />
        : 'GL · trailing 12-mo'}
      href="/financials"
    >
      {loading && <WidgetSkeleton rows={7} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && (!data || !data.latest) && (
        <EmptyState title="No GL data" subtitle="Load a general ledger to see expenses" />
      )}
      {!loading && !error && data && data.latest && (
        <div>
          <div style={{ display: 'flex', gap: 24, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 2 }}>T12 Operating Expense</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>{fmt(data.t12.opex)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 2 }}>Expense ratio</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>{ratioOf(data.t12)}</div>
            </div>
          </div>

          {/* Monthly OpEx trend */}
          {data.trend.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 40, marginBottom: 12 }}>
              {(() => {
                const max = Math.max(...data.trend.map(m => m.opex), 1)
                return data.trend.map((m, i) => (
                  <div key={i} title={`${MON[m.month]} ${m.year}: ${fmt(m.opex)}`}
                    style={{ flex: 1, height: Math.max(2, (m.opex / max) * 40), background: 'var(--amber)', opacity: 0.45 + 0.55 * (i / data.trend.length), borderRadius: 2 }} />
                ))
              })()}
            </div>
          )}

          {multi ? (
            <>
              {/* One card per property; click to expand its category ranking */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(showAll ? cards : cards.slice(0, CARD_COLLAPSED)).map(p => (
                  <PropertyCard key={p.propertyId} p={p}
                    name={propertyNames[p.propertyId] ?? '—'}
                    portfolioOpex={data.t12.opex} />
                ))}
              </div>
              <ExpandToggle expanded={showAll} onToggle={() => setShowAll(s => !s)}
                collapsedCount={CARD_COLLAPSED} totalCount={cards.length} />
            </>
          ) : (
            <RankedBars lines={data.t12ExpenseLines} />
          )}
        </div>
      )}
    </Widget>
  )
}

// Ranked T12 expense categories with proportion bars (top 8).
function RankedBars({ lines }: { lines: PnlCatLine[] }) {
  const max = Math.max(...lines.map(l => l.amount), 1)
  return (
    <div>
      {lines.slice(0, 8).map(l => (
        <div key={l.category} style={{ padding: '4px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{l.label}</span>
            <span style={{ fontSize: 12, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{fmt(l.amount)}</span>
          </div>
          <div style={{ height: 4, background: 'var(--surface-2)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(l.amount / max) * 100}%`, background: 'var(--accent)', opacity: 0.7 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// Collapsed: name + expense-ratio badge + T12 OpEx / share of portfolio.
// Expanded: that property's ranked category bars.
function PropertyCard({ p, name, portfolioOpex }: { p: PropertyPnl; name: string; portfolioOpex: number }) {
  const [open, setOpen] = useState(false)
  const share = portfolioOpex > 0 ? `${Math.round((p.t12.opex / portfolioOpex) * 100)}%` : '—'
  return (
    <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 8 }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        title={open ? 'Collapse detail' : 'Expand for detail'}
        style={{
          display: 'block', width: '100%', padding: '10px 12px', textAlign: 'left',
          background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', font: 'inherit',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 10, color: 'var(--text-faint)', width: 10, flex: 'none' }}>{open ? '▾' : '▸'}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {name}
            </span>
          </div>
          <Badge variant="gray">{ratioOf(p.t12)} of revenue</Badge>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          <CardStat label="T12 OpEx" value={fmt(p.t12.opex)} />
          <CardStat label="T12 Revenue" value={fmt(p.t12.revenue)} muted />
          <CardStat label="Share of OpEx" value={share} muted />
        </div>
      </button>

      {open && (
        <div style={{ padding: '2px 12px 10px', borderTop: '1px solid var(--border)' }}>
          {p.t12ExpenseLines.length
            ? <RankedBars lines={p.t12ExpenseLines} />
            : <div style={{ fontSize: 11, color: 'var(--text-faint)', paddingTop: 8 }}>No expense categories in the trailing 12 months.</div>}
        </div>
      )}
    </div>
  )
}

function CardStat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--text-faint)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: muted ? 'var(--text-muted)' : 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
    </div>
  )
}
