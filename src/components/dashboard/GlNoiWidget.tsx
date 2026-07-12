import { useState } from 'react'
import { Widget, WidgetSkeleton, WidgetPropertyChip, usePropertyChip, ExpandToggle } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { Hero, DeltaPill, AreaSpark, MiniGrid, fmtCompact } from '../ui/Kpi'
import { useGlPnl, type PnlMonth, type PnlCatLine, type PropertyPnl } from '../../hooks/useGlPnl'

const EXP_COLLAPSED = 6
const CARD_COLLAPSED = 6

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function GlNoiWidget({ propertyIds, propertyNames }: { propertyIds: string[]; propertyNames: Record<string, string> }) {
  const [expanded, setExpanded] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const { sel, setSel, effectiveIds } = usePropertyChip(propertyIds)
  const { data, loading, error } = useGlPnl(effectiveIds)

  const multi = (data?.byProperty.length ?? 0) > 1
  // Largest NOI contribution first.
  const cards = multi ? [...data!.byProperty].sort((a, b) => b.t12.noi - a.t12.noi) : []

  return (
    <Widget
      title="Net Operating Income"
      chip={propertyIds.length > 1
        ? <WidgetPropertyChip scopeIds={propertyIds} propertyNames={propertyNames} value={sel} onChange={setSel} />
        : 'GL-derived · trailing 12-mo'}
      href="/financials"
    >
      {loading && <WidgetSkeleton rows={7} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && (!data || !data.latest) && (
        <EmptyState title="No GL data" subtitle="Load a general ledger to compute NOI" />
      )}
      {!loading && !error && data && data.latest && (
        <div>
          {/* Hero: T12 NOI + month-over-month delta of monthly NOI */}
          <Hero
            label="T12 NOI"
            value={fmtCompact(data.t12.noi)}
            pill={data.trend.length > 1
              ? <DeltaPill current={data.latest.noi} prior={data.trend[data.trend.length - 2].noi} suffix="vs prior mo" />
              : undefined}
          />

          {/* Monthly NOI trend */}
          {data.trend.length > 1 && <Trend trend={data.trend} />}

          <MiniGrid cells={[
            { label: 'T12 Revenue', value: fmtCompact(data.t12.revenue) },
            { label: 'T12 OpEx', value: fmtCompact(data.t12.opex) },
          ]} />

          {multi ? (
            <>
              {/* One card per property; click to expand its NOI trend */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(showAll ? cards : cards.slice(0, CARD_COLLAPSED)).map(p => (
                  <PropertyCard key={p.propertyId} p={p}
                    name={propertyNames[p.propertyId] ?? '—'}
                    portfolioNoi={data.t12.noi} />
                ))}
              </div>
              <ExpandToggle expanded={showAll} onToggle={() => setShowAll(s => !s)}
                collapsedCount={CARD_COLLAPSED} totalCount={cards.length} />
            </>
          ) : (
            <>
              {/* Latest month breakdown */}
              <div style={{ fontSize: 10, color: 'var(--text-faint)', margin: '2px 0 6px', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                {MON[data.latest.month]} {data.latest.year} · income
              </div>
              {data.incomeLines.map(l => <Line key={l.category} line={l} />)}
              <div style={{ borderTop: '1px solid var(--border)', margin: '8px 0' }} />
              <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                Operating expenses
              </div>
              {(expanded ? data.expenseLines : data.expenseLines.slice(0, EXP_COLLAPSED)).map(l => <Line key={l.category} line={l} expense />)}
              <ExpandToggle
                expanded={expanded}
                onToggle={() => setExpanded(e => !e)}
                collapsedCount={EXP_COLLAPSED}
                totalCount={data.expenseLines.length}
              />

              <div style={{ marginTop: 10, padding: '9px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-2)', borderRadius: 10 }}>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text)' }}>NOI · {MON[data.latest.month]} {data.latest.year}</span>
                <span style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: data.latest.noi >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt(data.latest.noi)}</span>
              </div>
            </>
          )}
        </div>
      )}
    </Widget>
  )
}

// Collapsed: name + NOI-margin badge + T12 NOI / Revenue / share strip.
// Expanded: that property's monthly NOI sparkline + T12 mini stats.
function PropertyCard({ p, name, portfolioNoi }: { p: PropertyPnl; name: string; portfolioNoi: number }) {
  const [open, setOpen] = useState(false)
  const margin = p.t12.revenue > 0 ? `${Math.round((p.t12.noi / p.t12.revenue) * 100)}% margin` : '—'
  const share = portfolioNoi > 0 && p.t12.noi > 0 ? `${Math.round((p.t12.noi / portfolioNoi) * 100)}%` : '—'
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
          <Badge variant="gray">{margin}</Badge>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          <CardStat label="T12 NOI" value={fmt(p.t12.noi)} color={p.t12.noi >= 0 ? undefined : 'var(--red)'} />
          <CardStat label="T12 Revenue" value={fmt(p.t12.revenue)} muted />
          <CardStat label="Share of NOI" value={share} muted />
        </div>
      </button>

      {open && (
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)' }}>
          {p.trend.length > 1 ? (
            <>
              <AreaSpark
                values={p.trend.map(m => m.noi)}
                titles={p.trend.map(m => `${MON[m.month]} ${m.year}: ${fmt(m.noi)}`)}
                height={40}
                ariaLabel={`Monthly NOI trend for ${name}`}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-faint)', margin: '3px 0 8px' }}>
                <span>{MON[p.trend[0].month]} {String(p.trend[0].year).slice(2)}</span>
                <span>monthly NOI</span>
                <span>{MON[p.trend[p.trend.length - 1].month]} {String(p.trend[p.trend.length - 1].year).slice(2)}</span>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 8 }}>Only one month of GL data in the window.</div>
          )}
          <MiniGrid cells={[
            { label: 'T12 Revenue', value: fmtCompact(p.t12.revenue) },
            { label: 'T12 OpEx', value: fmtCompact(p.t12.opex) },
          ]} />
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

function Trend({ trend }: { trend: PnlMonth[] }) {
  return (
    <div style={{ margin: '6px 0 2px' }}>
      <AreaSpark
        values={trend.map(m => m.noi)}
        titles={trend.map(m => `${MON[m.month]} ${m.year}: ${fmt(m.noi)}`)}
        ariaLabel="Monthly NOI trend"
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-faint)', marginTop: 3 }}>
        <span>{MON[trend[0].month]} {String(trend[0].year).slice(2)}</span>
        <span>monthly NOI</span>
        <span>{MON[trend[trend.length - 1].month]} {String(trend[trend.length - 1].year).slice(2)}</span>
      </div>
    </div>
  )
}

function Line({ line, expense }: { line: PnlCatLine; expense?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{line.label}</span>
      <span style={{ fontSize: 12, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
        {expense ? '(' : ''}{fmt(line.amount)}{expense ? ')' : ''}
      </span>
    </div>
  )
}
