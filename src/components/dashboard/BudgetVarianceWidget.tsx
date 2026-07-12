import { useState, type ReactNode } from 'react'
import { Widget, WidgetSkeleton, ExpandToggle } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { useBudgetVariance, type BvaLine, type PropertyBva } from '../../hooks/useBudgetVariance'

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const CARD_COLLAPSED = 6

// Favorable = actual beat budget. Revenue/NOI: higher is better. OpEx: lower is
// better. Returns the signed variance and whether it's favorable.
function variance(line: BvaLine, isExpense: boolean) {
  const delta = line.actual - line.budget                 // + means actual > budget
  const favorable = isExpense ? delta <= 0 : delta >= 0
  const pct = line.budget !== 0 ? (delta / Math.abs(line.budget)) * 100 : 0
  return { delta, favorable, pct }
}

export function BudgetVarianceWidget({ propertyIds, propertyNames = {} }: {
  propertyIds: string[]
  propertyNames?: Record<string, string>
}) {
  const { data, loading, error } = useBudgetVariance(propertyIds)
  const [showAll, setShowAll] = useState(false)

  const chip = data
    ? `FY${String(data.year).slice(2)} · thru ${MON[data.throughMonth]}${data.mixedClose ? '*' : ''}`
    : 'YTD actual vs budget'

  const multi = (data?.byProperty.length ?? 0) > 1
  // Problems first: most behind budget (NOI variance %) at the top.
  const cards = multi
    ? [...data!.byProperty].sort((a, b) => variance(a.noi, false).pct - variance(b.noi, false).pct)
    : []

  return (
    <Widget title="Budget vs Actual" chip={chip} href="/financials">
      {loading && <WidgetSkeleton rows={7} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && !data && (
        <EmptyState title="No budget loaded" subtitle="Load an approved budget to compare against actuals" />
      )}
      {!loading && !error && data && (
        <div>
          {/* NOI headline (portfolio when multiple properties) */}
          <NoiHeadline noi={data.noi} />

          {multi ? (
            <>
              {/* One card per property, DSCR-style; click to expand its detail */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                {(showAll ? cards : cards.slice(0, CARD_COLLAPSED)).map(p => (
                  <PropertyCard key={p.propertyId} p={p}
                    name={propertyNames[p.propertyId] ?? '—'}
                    showThrough={data.mixedClose} />
                ))}
              </div>
              <ExpandToggle expanded={showAll} onToggle={() => setShowAll(s => !s)}
                collapsedCount={CARD_COLLAPSED} totalCount={cards.length} />
            </>
          ) : (
            <BvaDetail data={data} />
          )}

          {data.mixedClose && (
            <div style={{ fontSize: 9.5, color: 'var(--text-faint)', marginTop: 10 }}>
              * properties closed through different months; each compared YTD through its own close.
            </div>
          )}
        </div>
      )}
    </Widget>
  )
}

// The Actual/Budget/Var table for one comparison block (the whole selection in
// single-property mode, or one property's expanded card in multi mode).
function BvaDetail({ data }: { data: Pick<PropertyBva, 'revenue' | 'opex' | 'expense'> }) {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 84px 84px 70px', gap: 4, marginTop: 12, marginBottom: 4 }}>
        <span />
        <ColHead>Actual</ColHead>
        <ColHead>Budget</ColHead>
        <ColHead>Var</ColHead>
      </div>

      <SummaryRow label="Revenue" line={data.revenue} isExpense={false} />
      <SummaryRow label="Operating Expenses" line={data.opex} isExpense />

      {/* Expense category detail — where budget overruns usually hide */}
      {data.expense.length > 0 && (
        <>
          <div style={{ fontSize: 9.5, color: 'var(--text-faint)', margin: '10px 0 2px', textTransform: 'uppercase', letterSpacing: '.06em' }}>
            Operating expense detail
          </div>
          {data.expense.map(l => <DetailRow key={l.category} line={l} isExpense />)}
        </>
      )}
    </div>
  )
}

// Collapsed: name + NOI variance badge + a 3-stat strip. Expanded: the full
// Actual/Budget/Var detail for that property.
function PropertyCard({ p, name, showThrough }: { p: PropertyBva; name: string; showThrough: boolean }) {
  const [open, setOpen] = useState(false)
  const { delta, favorable, pct } = variance(p.noi, false)
  return (
    <div style={{
      background: 'var(--surface-2)',
      border: `1px solid ${favorable ? 'var(--border-2)' : 'var(--red-border)'}`,
      borderRadius: 8,
    }}>
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
            {showThrough && (
              <span style={{ fontSize: 10, color: 'var(--text-faint)', flex: 'none' }}>thru {MON[p.throughMonth]}</span>
            )}
          </div>
          <Badge variant={favorable ? 'green' : 'red'}>
            {delta >= 0 ? '+' : '−'}{Math.abs(pct).toFixed(1)}% NOI
          </Badge>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          <CardStat label="NOI Actual" value={fmt(p.noi.actual)} />
          <CardStat label="Budget" value={fmt(p.noi.budget)} muted />
          <CardStat label="Variance" value={`${delta >= 0 ? '+' : '−'}${fmt(Math.abs(delta))}`}
            color={favorable ? 'var(--green)' : 'var(--red)'} />
        </div>
      </button>

      {open && (
        <div style={{ padding: '0 12px 10px', borderTop: '1px solid var(--border)' }}>
          <BvaDetail data={p} />
        </div>
      )}
    </div>
  )
}

function CardStat({ label, value, color, muted }: { label: string; value: string; color?: string; muted?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--text-faint)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: color ?? (muted ? 'var(--text-muted)' : 'var(--text)'), fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
    </div>
  )
}

function NoiHeadline({ noi }: { noi: BvaLine }) {
  const { delta, favorable, pct } = variance(noi, false)
  const color = favorable ? 'var(--green)' : 'var(--red)'
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 20 }}>
      <div>
        <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 2 }}>NOI — Actual</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>{fmt(noi.actual)}</div>
      </div>
      <div>
        <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 2 }}>Budget</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-muted)' }}>{fmt(noi.budget)}</div>
      </div>
      <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
        <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 2 }}>Variance</div>
        <div style={{ fontSize: 15, fontWeight: 700, color }}>
          {delta >= 0 ? '+' : '−'}{fmt(Math.abs(delta))}
        </div>
        <div style={{ fontSize: 10.5, fontWeight: 600, color }}>
          {delta >= 0 ? '+' : '−'}{Math.abs(pct).toFixed(1)}%
        </div>
      </div>
    </div>
  )
}

function ColHead({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: 9.5, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.05em', textAlign: 'right' }}>
      {children}
    </span>
  )
}

function SummaryRow({ label, line, isExpense }: { label: string; line: BvaLine; isExpense: boolean }) {
  const { delta, favorable, pct } = variance(line, isExpense)
  const color = favorable ? 'var(--green)' : 'var(--red)'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 84px 84px 70px', gap: 4, alignItems: 'center', padding: '5px 0', borderTop: '1px solid var(--border)' }}>
      <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--text)' }}>{label}</span>
      <Num>{fmt(line.actual)}</Num>
      <Num muted>{fmt(line.budget)}</Num>
      <span style={{ fontSize: 11, fontWeight: 650, color, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {delta >= 0 ? '+' : '−'}{Math.abs(pct).toFixed(0)}%
      </span>
    </div>
  )
}

function DetailRow({ line, isExpense }: { line: BvaLine; isExpense: boolean }) {
  const { delta, favorable, pct } = variance(line, isExpense)
  const color = favorable ? 'var(--green)' : 'var(--red)'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 84px 84px 70px', gap: 4, alignItems: 'center', padding: '2px 0' }}>
      <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{line.label}</span>
      <Num small>{fmt(line.actual)}</Num>
      <Num small muted>{fmt(line.budget)}</Num>
      <span style={{ fontSize: 10.5, fontWeight: 600, color, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {delta >= 0 ? '+' : '−'}{Math.abs(pct).toFixed(0)}%
      </span>
    </div>
  )
}

function Num({ children, muted, small }: { children: ReactNode; muted?: boolean; small?: boolean }) {
  return (
    <span style={{ fontSize: small ? 11 : 12, color: muted ? 'var(--text-muted)' : 'var(--text)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
      {children}
    </span>
  )
}
