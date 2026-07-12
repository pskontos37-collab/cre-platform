import { useState } from 'react'
import { Widget, WidgetSkeleton, WidgetPropertyChip, usePropertyChip, ExpandToggle } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { useRentRoll, type PropertyRentRoll } from '../../hooks/useRentRoll'

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const sf  = (n: number) => `${Math.round(n).toLocaleString('en-US')} SF`
const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const CARD_COLLAPSED = 6

const leasedPct = (leasedSf: number, gla: number) => gla > 0 ? `${((leasedSf / gla) * 100).toFixed(1)}%` : '—'

export function RentRollWidget({ propertyIds, propertyNames }: { propertyIds: string[]; propertyNames: Record<string, string> }) {
  const { sel, setSel, effectiveIds } = usePropertyChip(propertyIds)
  const { data, loading, error } = useRentRoll(effectiveIds)
  const [showAll, setShowAll] = useState(false)
  const asOf = data?.asOf ? `${MON[data.asOf.month]} ${data.asOf.year}` : 'Leasing'

  const multi = (data?.byProperty.length ?? 0) > 1
  // Largest rent contribution first.
  const cards = multi ? [...data!.byProperty].sort((a, b) => b.totalAnnualRent - a.totalAnnualRent) : []

  return (
    <Widget
      title="Rent Roll"
      chip={propertyIds.length > 1
        ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 10, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{asOf}</span>
            <WidgetPropertyChip scopeIds={propertyIds} propertyNames={propertyNames} value={sel} onChange={setSel} />
          </span>
        )
        : asOf}
      href="/properties"
    >
      {loading && <WidgetSkeleton rows={5} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && (!data || data.tenantCount === 0) && (
        <EmptyState title="No rent roll" subtitle="Import a rent roll to populate leasing metrics" />
      )}
      {!loading && !error && data && data.tenantCount > 0 && (
        <div>
          {multi ? (
            <>
              {/* Portfolio headline, then one expandable card per property */}
              <div style={{ display: 'flex', gap: 24, marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 2 }}>Annual Base Rent</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>{usd(data.totalAnnualRent)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 2 }}>Leased % of GLA</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>{leasedPct(data.leasedSf, data.totalGla)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 2 }}>WALT</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>{data.walt.toFixed(1)} yrs</div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(showAll ? cards : cards.slice(0, CARD_COLLAPSED)).map(p => (
                  <PropertyCard key={p.propertyId} p={p} name={propertyNames[p.propertyId] ?? '—'} />
                ))}
              </div>
              <ExpandToggle expanded={showAll} onToggle={() => setShowAll(s => !s)}
                collapsedCount={CARD_COLLAPSED} totalCount={cards.length} />
            </>
          ) : (
            <MetricGrid
              tenantCount={data.tenantCount} totalGla={data.totalGla} leasedSf={data.leasedSf}
              totalAnnualRent={data.totalAnnualRent} avgPsf={data.avgPsf} walt={data.walt}
            />
          )}
          <div style={{ fontSize: 10, color: 'var(--text-faint)', lineHeight: 1.5, borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 10 }}>
            From the most recent rent roll. Vacancy isn’t captured in the source export, so this reflects
            in-place leases only — not physical occupancy.
          </div>
        </div>
      )}
    </Widget>
  )
}

// The 7-metric grid used for a single property (and inside expanded cards).
function MetricGrid({ tenantCount, totalGla, leasedSf, totalAnnualRent, avgPsf, walt }: {
  tenantCount: number; totalGla: number; leasedSf: number; totalAnnualRent: number; avgPsf: number; walt: number
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 16px' }}>
      <Metric label="Tenants" value={String(tenantCount)} />
      <Metric label="Total GLA" value={totalGla > 0 ? sf(totalGla) : '—'} />
      <Metric label="Leased SF" value={sf(leasedSf)} />
      <Metric label="Leased % of GLA" value={leasedPct(leasedSf, totalGla)} />
      <Metric label="Annual Base Rent" value={usd(totalAnnualRent)} />
      <Metric label="Avg Rent PSF" value={`$${avgPsf.toFixed(2)}`} />
      <Metric label="WALT" value={`${walt.toFixed(1)} yrs`} />
    </div>
  )
}

// Collapsed: name + leased% badge + 3-stat strip. Expanded: full metric grid.
function PropertyCard({ p, name }: { p: PropertyRentRoll; name: string }) {
  const [open, setOpen] = useState(false)
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
            <span style={{ fontSize: 10, color: 'var(--text-faint)', flex: 'none' }}>{MON[p.asOf.month]} {String(p.asOf.year).slice(2)}</span>
          </div>
          <Badge variant="gray">{leasedPct(p.leasedSf, p.totalGla)} leased</Badge>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          <CardStat label="Annual Base Rent" value={usd(p.totalAnnualRent)} />
          <CardStat label="Leased SF" value={sf(p.leasedSf)} muted />
          <CardStat label="WALT" value={`${p.walt.toFixed(1)} yrs`} muted />
        </div>
      </button>

      {open && (
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)' }}>
          <MetricGrid
            tenantCount={p.tenantCount} totalGla={p.totalGla} leasedSf={p.leasedSf}
            totalAnnualRent={p.totalAnnualRent} avgPsf={p.avgPsf} walt={p.walt}
          />
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{value}</div>
    </div>
  )
}
