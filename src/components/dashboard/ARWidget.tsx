import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Widget, WidgetSkeleton, WidgetPropertyChip, usePropertyChip, ExpandToggle } from '../ui/Widget'
import { EmptyState } from '../ui/EmptyState'
import { Hero, DeltaPill, AreaSpark, fmtCompact } from '../ui/Kpi'
import { useArTrend, type ArTrendData } from '../../hooks/useDashboard'

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const COLLAPSED = 5

// Net tenant A/R from the GL (receivables + doubtful-account allowance;
// straight-line deferred rent excluded). Aged buckets live on /receivables
// (MRI Aged Delinquencies snapshots).
export function ARWidget({ propertyIds, propertyNames }: {
  propertyIds: string[]
  propertyNames: Record<string, string>
}) {
  const [expanded, setExpanded] = useState(false)
  const { sel, setSel, effectiveIds } = usePropertyChip(propertyIds)
  const { data, loading, error } = useArTrend(effectiveIds, propertyNames)

  return (
    <Widget
      title="Accounts Receivable"
      chip={propertyIds.length > 1
        ? <WidgetPropertyChip scopeIds={propertyIds} propertyNames={propertyNames} value={sel} onChange={setSel} />
        : 'GL · net A/R'}
      href="/receivables"
    >
      {loading && <WidgetSkeleton rows={6} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && !data && (
        <EmptyState title="No A/R data" subtitle="Load this property's general ledger to see receivables" />
      )}
      {!loading && !error && data && (
        <div>
          <Hero
            label={`Net A/R · ${MON[data.latestMonth]}`}
            value={fmtCompact(data.totalLatest)}
            pill={data.trend.length > 1
              ? <DeltaPill current={data.totalLatest} prior={data.trend[data.trend.length - 2].balance} suffix="vs prior mo" downIsGood />
              : undefined}
          />

          {/* Monthly trend */}
          <div style={{ margin: '6px 0 2px' }}>
            <AreaSpark
              values={data.trend.map(t => t.balance)}
              titles={data.trend.map(t => `${MON[t.month]}: ${usd(t.balance)}`)}
              height={46}
              ariaLabel="Monthly net accounts receivable trend"
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-faint)', marginBottom: 10 }}>
            <span>{MON[data.trend[0]?.month ?? 1]}</span><span>{MON[data.latestMonth]}</span>
          </div>

          {/* Per-property cards; click to expand a property's balance trend */}
          {data.byProperty.length > 1 && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(expanded ? data.byProperty : data.byProperty.slice(0, COLLAPSED)).map(p => (
                  <PropertyCard key={p.propertyId} p={p}
                    latestMonth={data.latestMonth} totalLatest={data.totalLatest} />
                ))}
              </div>
              <ExpandToggle
                expanded={expanded}
                onToggle={() => setExpanded(e => !e)}
                collapsedCount={COLLAPSED}
                totalCount={data.byProperty.length}
              />
            </>
          )}

          <div style={{ marginTop: 8, fontSize: 9.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
            Net of the doubtful-account allowance; straight-line deferred rent excluded.
            Aged 30/60/90 buckets appear when monthly MRI A/R aging exports are loaded.
          </div>
        </div>
      )}
    </Widget>
  )
}

// Collapsed: name + MoM pill + balance / Δ vs prior / share strip.
// Expanded: that property's monthly balance trend + property-page link.
function PropertyCard({ p, latestMonth, totalLatest }: {
  p: ArTrendData['byProperty'][number]
  latestMonth: number
  totalLatest: number
}) {
  const [open, setOpen] = useState(false)
  const prior = latestMonth > 1 ? p.monthly[latestMonth - 2] : null
  const deltaAbs = prior != null ? p.balance - prior : null
  const share = totalLatest > 0 && p.balance > 0 ? `${Math.round((p.balance / totalLatest) * 100)}%` : '—'
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
              {p.propertyName}
            </span>
          </div>
          <DeltaPill current={p.balance} prior={prior} suffix="vs prior mo" downIsGood />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          <CardStat label={`Net A/R · ${MON[latestMonth]}`} value={usd(p.balance)} />
          <CardStat label="Δ vs prior mo"
            value={deltaAbs != null ? `${deltaAbs >= 0 ? '+' : '−'}${usd(Math.abs(deltaAbs))}` : '—'}
            color={deltaAbs != null ? (deltaAbs > 0 ? 'var(--red)' : 'var(--green)') : undefined} />
          <CardStat label="Share of A/R" value={share} muted />
        </div>
      </button>

      {open && (
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)' }}>
          {p.monthly.length > 1 ? (
            <>
              <AreaSpark
                values={p.monthly}
                titles={p.monthly.map((b, i) => `${MON[i + 1]}: ${usd(b)}`)}
                height={40}
                ariaLabel={`Monthly net A/R trend for ${p.propertyName}`}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-faint)', margin: '3px 0 8px' }}>
                <span>{MON[1]}</span>
                <span>monthly net A/R</span>
                <span>{MON[latestMonth]}</span>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 8 }}>Only one month of A/R data.</div>
          )}
          <Link to={`/properties/${p.propertyId}`}
            style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none' }}>
            Open property page →
          </Link>
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
