import { useState } from 'react'
import { Widget, WidgetSkeleton, WidgetPropertyChip, usePropertyChip, ExpandToggle } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { useHealthRatio, type HealthBand } from '../../hooks/useDashboard'

const COLLAPSED = 4

const fmtDollar = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const fmtPct = (n: number) => (n * 100).toFixed(1) + '%'

const BAND_META: Record<HealthBand, { label: string; variant: 'green' | 'amber' | 'red'; color: string }> = {
  healthy: { label: 'Healthy',  variant: 'green', color: 'var(--green)' },
  watch:   { label: 'Watch',    variant: 'amber', color: 'var(--amber)' },
  high:    { label: 'Elevated', variant: 'red',   color: 'var(--red)'   },
}

// Full bar = a 25% occupancy-cost ratio, so the healthy/watch/high bands read
// visually against a consistent scale.
const BAR_MAX = 0.25

interface HealthRatioWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
}

export function HealthRatioWidget({ propertyIds, propertyNames }: HealthRatioWidgetProps) {
  const [expanded, setExpanded] = useState(false)
  const { sel, setSel, effectiveIds } = usePropertyChip(propertyIds)
  const { data, loading, error } = useHealthRatio(effectiveIds, propertyNames)

  const rows = data?.rows ?? []
  const visible = expanded ? rows : rows.slice(0, COLLAPSED)
  const countLabel = rows.length === 1 ? '1 tenant' : `${rows.length} tenants`
  // At least one fully-covered tenant → the blended ratio is meaningful.
  const hasBlended = !!data && data.rows.length > data.insufficientCount

  return (
    <Widget
      title="Occupancy Cost (Health Ratio)"
      chip={propertyIds.length > 1
        ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 10, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{countLabel}</span>
            <WidgetPropertyChip scopeIds={propertyIds} propertyNames={propertyNames} value={sel} onChange={setSel} />
          </span>
        )
        : countLabel}
    >
      {loading && <WidgetSkeleton rows={4} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <EmptyState icon="🩺" title="No sales-reporting tenants" subtitle="No percentage-rent leases with trailing-12-month sales in scope" />
      )}
      {!loading && !error && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Portfolio blended ratio + TTM window (fully-covered tenants only) */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            padding: '2px 2px 8px', borderBottom: '1px solid var(--border)',
          }}>
            <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
              Blended occupancy cost ratio
              {data!.insufficientCount > 0 && (
                <span title="Tenants without a full 12 months of reported sales are excluded from the blended ratio — a partial denominator would overstate it."
                  style={{ color: 'var(--amber)' }}> · {data!.insufficientCount} excluded (partial coverage)</span>
              )}
            </span>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              {hasBlended ? (
                <span style={{ fontSize: 16, fontWeight: 700, color: BAND_META[bandOf(data!.portfolioRatio)].color }}>
                  {fmtPct(data!.portfolioRatio)}
                </span>
              ) : (
                <span title="No tenant in scope has a full 12 months of reported sales." style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-faint)' }}>
                  — insufficient coverage
                </span>
              )}
              <span style={{ fontSize: 9.5, color: 'var(--text-faint)' }}>TTM {data!.ttmLabel}</span>
            </span>
          </div>

          {visible.map(row => {
            // Incomplete sales coverage → no ratio, no band, no bar. Disclose the
            // gap instead of showing a distorted number (audit: Dave & Buster's).
            if (row.ratio == null || row.band == null) {
              return (
                <div
                  key={row.leaseId}
                  style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 8, border: '1px dashed var(--border-2)' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.tenantName}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{row.propertyName}</div>
                    </div>
                    <span title="A trailing-12-month ratio needs all 12 months of reported sales; fewer would overstate the cost burden."
                      style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--amber)', whiteSpace: 'nowrap' }}>
                      {row.coverageStatus === 'zero_sales' ? 'Zero reported sales' : `Insufficient coverage · ${row.monthsCovered}/12 mo`}
                    </span>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-faint)' }}>
                    Occ. cost <span style={{ color: 'var(--text-muted)' }}>{fmtDollar(row.occupancyCost)}</span>
                    {' · '}reported sales <span style={{ color: 'var(--text-muted)' }}>{fmtDollar(row.ttmSales)}</span>
                    {' '}(partial)
                  </div>
                </div>
              )
            }
            const meta = BAND_META[row.band]
            return (
              <div
                key={row.leaseId}
                style={{
                  padding: '10px 12px',
                  background: 'var(--surface-2)',
                  borderRadius: 8,
                  border: `1px solid ${row.band === 'high' ? 'var(--red-border)' : 'var(--border-2)'}`,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.tenantName}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{row.propertyName}</div>
                  </div>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: meta.color }}>{fmtPct(row.ratio)}</span>
                    <Badge variant={meta.variant}>{meta.label}</Badge>
                  </span>
                </div>

                {/* Ratio bar against a fixed 25% scale */}
                <div style={{ height: 6, background: 'var(--surface)', borderRadius: 99, overflow: 'hidden', marginBottom: 6 }}>
                  <div style={{
                    width: `${Math.min(row.ratio / BAR_MAX, 1) * 100}%`,
                    height: '100%',
                    background: meta.color,
                    borderRadius: 99,
                  }} />
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-faint)' }}>
                  <span>
                    Occ. cost <span style={{ color: 'var(--text-muted)' }}>{fmtDollar(row.occupancyCost)}</span>
                    {!row.hasRecoveries && (
                      <span title="No expense-recovery (CAM/tax/insurance) data on file — base rent only, so the true ratio is higher."
                        style={{ color: 'var(--amber)' }}> · rent only</span>
                    )}
                  </span>
                  <span>
                    TTM sales <span style={{ color: 'var(--text-muted)' }}>{fmtDollar(row.ttmSales)}</span>
                  </span>
                </div>
              </div>
            )
          })}

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

// Local copy of the band cutoffs for the blended figure's color (keeps the
// widget self-contained; the per-row band comes pre-computed from the hook).
function bandOf(ratio: number): HealthBand {
  return ratio <= 0.10 ? 'healthy' : ratio <= 0.15 ? 'watch' : 'high'
}
