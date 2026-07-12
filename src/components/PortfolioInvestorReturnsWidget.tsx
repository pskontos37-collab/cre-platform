import { useMemo, useState } from 'react'
import { Widget, ChipSelect } from './ui/Widget'
import { Badge } from './ui/Badge'
import {
  usePortfolioReturnsByProperty,
  type PropertyReturn,
  type RoleReturn,
  type Level,
} from '../hooks/usePortfolioInvestorReturns'
import { useDeals } from '../hooks/useDeals'

// Compact currency keeps the equity column narrow enough to fit a single
// dashboard column (full digits like $126,447,299 overflow the card).
const usdC = (n: number | null | undefined) => {
  if (n == null || !isFinite(n)) return '—'
  const s = n < 0 ? '−' : ''
  const a = Math.abs(n)
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}K`
  return `${s}$${a.toFixed(0)}`
}

const mult = (n: number | null | undefined) =>
  n == null || !isFinite(n) ? '—' : n.toFixed(2) + 'x'

const pct = (n: number | null | undefined) =>
  n == null || !isFinite(n) ? '—' : (n * 100).toFixed(1) + '%'

const titleCase = (s: string) =>
  s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

const irrColor = (n: number | null | undefined) =>
  n == null || !isFinite(n) ? 'var(--text-muted)' : n < 0 ? 'var(--red)' : 'var(--accent)'

type LevelFilter = 'both' | Level

interface PortfolioInvestorReturnsWidgetProps {
  /** Property scope from the dashboard's global View filter; aggregates only
   *  deals whose property is in scope. Omit to aggregate every deal. */
  propertyIds?: string[]
  /** Kept for registry compatibility; this widget covers layer-1 JV returns. */
  layer?: 1 | 2
}

export function PortfolioInvestorReturnsWidget({
  propertyIds,
}: PortfolioInvestorReturnsWidgetProps) {
  const [level, setLevel] = useState<LevelFilter>('both')
  const [assetType, setAssetType] = useState<string>('all')

  const { data: allDeals } = useDeals()

  const scopedDeals = useMemo(() => {
    if (!allDeals) return null
    if (!propertyIds || propertyIds.length === 0) return allDeals
    const inScope = new Set(propertyIds)
    return allDeals.filter(d => inScope.has(d.property_id))
  }, [allDeals, propertyIds])

  const assetTypes = useMemo(() => {
    const set = new Set<string>()
    for (const d of scopedDeals ?? []) {
      if (d.layer === 1 && d.properties?.asset_type) set.add(d.properties.asset_type)
    }
    return Array.from(set).sort()
  }, [scopedDeals])

  const filteredDeals = useMemo(() => {
    if (!scopedDeals) return null
    if (assetType === 'all' || !assetTypes.includes(assetType)) return scopedDeals
    return scopedDeals.filter(d => d.properties?.asset_type === assetType)
  }, [scopedDeals, assetType, assetTypes])

  const { properties, totals } = usePortfolioReturnsByProperty(filteredDeals)

  if (!scopedDeals || properties.length === 0) return null

  const showLp = level === 'both' || level === 'lp'
  const showGp = level === 'both' || level === 'gp'
  const heroLevels: Level[] = level === 'both' ? ['lp', 'gp'] : [level]

  return (
    <Widget
      title="Investor Returns — JV Layer 1"
      href="/waterfall"
      chip={
        <span style={{ display: 'flex', gap: 6 }}>
          {assetTypes.length > 1 && (
            <ChipSelect
              value={assetType}
              onChange={setAssetType}
              options={[
                { value: 'all', label: 'All classes' },
                ...assetTypes.map(t => ({ value: t, label: titleCase(t) })),
              ]}
            />
          )}
          <ChipSelect
            value={level}
            onChange={v => setLevel(v as LevelFilter)}
            options={[
              { value: 'both', label: 'LP + GP' },
              { value: 'lp', label: 'LP only' },
              { value: 'gp', label: 'GP only' },
            ]}
          />
        </span>
      }
    >
      {/* Headline: portfolio-total sold-today IRR per selected level */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 4 }}>
        {heroLevels.map(lv => {
          const t = totals[lv]
          return (
            <div key={lv}>
              <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 2 }}>
                {lv === 'lp' ? 'LP' : 'GP'} · Total IRR
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: irrColor(t.totalValueIrr) }}>
                {pct(t.totalValueIrr)}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 1 }}>
                {mult(t.totalValueMultiple)} · {usdC(t.currentEquity)} equity
              </div>
            </div>
          )
        })}
      </div>

      {/* One card per property — sold-today LP/GP returns */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        {properties.map(p => (
          <PropertyCard key={p.propertyId} p={p} showLp={showLp} showGp={showGp} level={level} />
        ))}
      </div>

      <div style={{ fontSize: 9.5, color: 'var(--text-faint)', marginTop: 10, lineHeight: 1.5 }}>
        Sold-today basis: current equity credited as a terminal inflow alongside distributions to date.
        <b> LP</b> = the Layer-1 institutional partner. <b>GP</b> = the M&J entity (the JV's GP member) —
        its ~10% co-invest capital blended with the promote, on its actual dated contributions. See /waterfall
        for the class-by-class cascade.
      </div>
    </Widget>
  )
}

function PropertyCard({ p, showLp, showGp, level }: {
  p: PropertyReturn
  showLp: boolean
  showGp: boolean
  level: LevelFilter
}) {
  // Badge the primary level's IRR (fall back to its multiple when IRR has no basis).
  const primary = level === 'gp' ? p.gp : p.lp
  const badge = primary?.totalValueIrr != null
    ? pct(primary.totalValueIrr)
    : primary?.totalValueMultiple != null ? mult(primary.totalValueMultiple) : '—'
  const badgeVariant = primary?.totalValueIrr == null ? 'gray'
    : primary.totalValueIrr < 0 ? 'red' : 'blue'

  return (
    <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {p.name}
          </span>
          {p.assetType && (
            <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em', flex: 'none' }}>
              {titleCase(p.assetType)}
            </span>
          )}
        </div>
        <Badge variant={badgeVariant}>{badge} {level === 'gp' ? 'GP' : 'LP'}</Badge>
      </div>

      {/* Column headers + LP/GP rows */}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr 1fr', gap: 6, alignItems: 'center' }}>
        <span />
        <ColHead>IRR</ColHead>
        <ColHead>Multiple</ColHead>
        <ColHead>Equity</ColHead>
        {showLp && <RoleRow r={p.lp} />}
        {showGp && <RoleRow r={p.gp} />}
      </div>
    </div>
  )
}

function RoleRow({ r }: { r: RoleReturn | null }) {
  if (!r) return null
  return (
    <>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>
        {r.role === 'lp' ? 'LP' : 'GP'}
      </span>
      <Num style={{ fontWeight: 700, color: irrColor(r.totalValueIrr) }}>{pct(r.totalValueIrr)}</Num>
      <Num style={{ fontWeight: 600 }}>{mult(r.totalValueMultiple)}</Num>
      <Num>{usdC(r.currentEquity)}</Num>
    </>
  )
}

function ColHead({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 9, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.05em', textAlign: 'right' }}>
      {children}
    </span>
  )
}

function Num({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <span style={{ fontSize: 12, color: 'var(--text)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', ...style }}>
      {children}
    </span>
  )
}
