import { useMemo } from 'react'
import { Widget, WidgetSkeleton } from './ui/Widget'
import { EmptyState } from './ui/EmptyState'
import {
  useCoTenancyRisk, useTerminationRisk,
  TIER_RANK, TIER_COLOR, TIER_LABEL,
  CoTenancyRiskRow, TerminationRiskRow,
} from '../hooks/useLeaseRights'

// Rights Radar — the portfolio-wide (or property-scoped) view of the two live risk
// engines: co-tenancy clause risk and tenant-held early-termination rights.
// Rendered as the "Rights radar" mode on /clauses and as a card on property detail.

const fmtMoney = (v: number | null | undefined) =>
  v == null ? '—' : '$' + Math.round(v).toLocaleString()

function TierChip({ tier }: { tier: string }) {
  const c = TIER_COLOR[tier] ?? TIER_COLOR.unknown
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 9px', borderRadius: 9, whiteSpace: 'nowrap', color: c.fg, background: c.bg, border: `1px solid ${c.fg}22` }}>
      {TIER_LABEL[tier] ?? tier}
    </span>
  )
}

function CoTenancyTable({ rows, propertyNames }: { rows: CoTenancyRiskRow[]; propertyNames: Record<string, string> }) {
  if (!rows.length) return <EmptyState icon="✅" title="No co-tenancy clauses on file" subtitle="Run the lease-rights extraction to populate" />
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map((r, i) => (
        <div key={r.clause_id} style={{ padding: '10px 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>{r.tenant_name}</span>
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{propertyNames[r.property_id] ?? ''}</span>
            <span style={{ flex: 1 }} />
            {r.exposed_annual_rent != null && (
              <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }} title="This tenant's current annual base rent — what drops to alternate rent if the clause trips">
                exposed {fmtMoney(r.exposed_annual_rent)}/yr
              </span>
            )}
            <TierChip tier={r.tier} />
          </div>
          {r.reasons.length > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {r.reasons.join(' · ')}
            </div>
          )}
          {r.named_at_risk.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
              {r.named_at_risk.map((a, j) => (
                <span key={j} style={{ fontSize: 10, padding: '1px 8px', borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border-2)', color: 'var(--text-muted)' }}
                  title={a.newer_notice_doc ? 'A recent notice document exists for this anchor — structured data may be stale' : undefined}>
                  {a.label}: {a.state.replace(/_/g, ' ')}{a.expiration ? ` (exp ${a.expiration})` : ''}{a.newer_notice_doc ? ' ⚠ notice on file' : ''}
                </span>
              ))}
            </div>
          )}
          {r.occupancy_pct != null && r.threshold_pct != null && (
            <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 4 }}>
              Property occupancy {r.occupancy_pct}% vs clause threshold {r.threshold_pct}% — leased-SF proxy; clause measures “open and operating”
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function TerminationTable({ rows, propertyNames }: { rows: TerminationRiskRow[]; propertyNames: Record<string, string> }) {
  if (!rows.length) return <EmptyState icon="✅" title="No early-termination rights on file" subtitle="Run the lease-rights extraction to populate" />
  const typeLabel: Record<string, string> = {
    sales_kickout: 'Sales kickout', fixed_window: 'Termination window',
    ongoing_notice: 'Terminate on notice', cotenancy_termination: 'Co-tenancy termination', other: 'Other',
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map((r, i) => (
        <div key={r.right_id} style={{ padding: '10px 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>{r.tenant_name}</span>
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{propertyNames[r.property_id] ?? ''}</span>
            <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 8px', borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border-2)', color: 'var(--text-muted)' }}>
              {typeLabel[r.right_type] ?? r.right_type}
            </span>
            <span style={{ flex: 1 }} />
            {r.exposed_annual_rent != null && (
              <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>exposed {fmtMoney(r.exposed_annual_rent)}/yr</span>
            )}
            <TierChip tier={r.tier} />
          </div>
          {r.details && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>{r.details}</div>}
          {r.reasons.length > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 3 }}>{r.reasons.join(' · ')}</div>
          )}
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 3 }}>
            {r.right_type === 'sales_kickout' && r.ttm_sales != null && <>TTM sales {fmtMoney(r.ttm_sales)}{r.sales_threshold != null && <> vs floor {fmtMoney(r.sales_threshold)}</>} · </>}
            {r.notice_days != null && <>{r.notice_days}-day notice · </>}
            lease expires {r.lease_expiration ?? '—'}
          </div>
        </div>
      ))}
    </div>
  )
}

export function RightsRadar({ propertyIds, propertyNames, compact }: {
  propertyIds?: string[]
  propertyNames: Record<string, string>
  compact?: boolean
}) {
  const ct = useCoTenancyRisk(propertyIds)
  const tr = useTerminationRisk(propertyIds)

  const ctRows = useMemo(() =>
    [...(ct.data ?? [])].sort((a, b) =>
      (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || (b.exposed_annual_rent ?? 0) - (a.exposed_annual_rent ?? 0)),
    [ct.data])
  const trRows = useMemo(() => {
    let rows = [...(tr.data ?? [])]
    if (compact) rows = rows.filter(r => r.tier !== 'lapsed' && r.tier !== 'informational')
    return rows.sort((a, b) =>
      (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || (b.exposed_annual_rent ?? 0) - (a.exposed_annual_rent ?? 0))
  }, [tr.data, compact])

  const atRiskCt = ctRows.filter(r => r.tier !== 'ok').length
  const atRiskTr = trRows.filter(r => !['ok', 'lapsed', 'informational'].includes(r.tier)).length

  return (
    <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fit, minmax(460px, 1fr))', gap: 16 }}>
      <Widget title="Co-Tenancy Clause Risk" chip={ct.data ? `${atRiskCt} at risk / ${ctRows.length}` : undefined} fullWidth={compact}>
        {ct.loading && <WidgetSkeleton rows={3} />}
        {ct.error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{ct.error}</div>}
        {!ct.loading && !ct.error && <CoTenancyTable rows={compact ? ctRows.filter(r => r.tier !== 'ok') : ctRows} propertyNames={propertyNames} />}
      </Widget>
      <Widget title="Early Termination Rights" chip={tr.data ? `${atRiskTr} live / ${trRows.length}` : undefined} fullWidth={compact}>
        {tr.loading && <WidgetSkeleton rows={3} />}
        {tr.error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{tr.error}</div>}
        {!tr.loading && !tr.error && <TerminationTable rows={trRows} propertyNames={propertyNames} />}
      </Widget>
    </div>
  )
}
