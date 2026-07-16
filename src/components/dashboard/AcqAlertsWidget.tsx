import { useMemo } from 'react'
import { Widget, WidgetSkeleton } from '../ui/Widget'
import { EmptyState } from '../ui/EmptyState'
import { Hero } from '../ui/Kpi'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { useQuery } from '../../hooks/useQuery'
import { computeAcqAlerts, DEADLINE_SOON_DAYS, STALE_DAYS, type AlertDeal } from '../../lib/acqAlerts'
import type { Stage } from '../../hooks/usePipeline'

// "Acquisition Alerts" — the dashboard cut of /pipeline: active deals whose target
// close is near/overdue, and active deals with no recent activity. Portfolio-level
// (deals aren't property-scoped), so it ignores the dashboard property filter.
// Admin / asset-manager only (the pipeline is restricted).

interface AcqAlertsWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
}

interface DealRow {
  id: string
  name: string
  stage: Stage
  target_close_date: string | null
  updated_at: string
  bid_text: string | null
}

export function AcqAlertsWidget(_props: AcqAlertsWidgetProps) {
  const { appUser } = useAuth()
  const canView = appUser?.role === 'admin' || appUser?.role === 'asset_manager'

  const deals = useQuery<DealRow[]>(async () => {
    if (!canView) return []
    const { data, error } = await supabase
      .from('pipeline_deals')
      .select('id, name, stage, target_close_date, updated_at, bid_text')
      .limit(1000)
    if (error) throw new Error(error.message)
    return (data ?? []) as DealRow[]
  }, [canView])

  const alerts = useMemo(() => {
    const rows: AlertDeal[] = (deals.data ?? []).map(r => ({
      id: r.id, name: r.name, stage: r.stage,
      targetCloseDate: r.target_close_date, updatedAt: r.updated_at, bidText: r.bid_text,
    }))
    return computeAcqAlerts(rows, Date.now())
  }, [deals.data])

  const { deadlines, stalled } = alerts
  const overdue = deadlines.filter(x => x.days < 0).length
  const flagged = useMemo(
    () => new Set([...deadlines, ...stalled].map(x => x.d.id)).size,
    [deadlines, stalled],
  )
  const top = deadlines.slice(0, 3)

  const cell = (label: string, value: number, color: string) => (
    <div style={{ background: 'var(--surface)', padding: '10px 12px' }}>
      <div style={{ fontSize: 9.5, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>{value.toLocaleString()}</div>
    </div>
  )

  return (
    <Widget title="Acquisition Alerts" href="/pipeline" hrefLabel="Open pipeline →">
      {!canView && <EmptyState icon="🔒" title="Admin / asset manager only" subtitle="The acquisition pipeline is restricted" />}
      {canView && deals.loading && <WidgetSkeleton rows={3} />}
      {canView && deals.error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{deals.error}</div>}
      {canView && !deals.loading && !deals.error && flagged === 0 && (
        <EmptyState icon="✅" title="All clear" subtitle="No close deadlines or stalled deals" />
      )}

      {canView && !deals.loading && !deals.error && flagged > 0 && (
        <>
          <Hero label="Deals needing attention" value={flagged.toLocaleString()} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 1, background: 'var(--border)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', marginTop: 12 }}>
            {cell(`Close in ${DEADLINE_SOON_DAYS}d / overdue`, deadlines.length, overdue > 0 ? 'var(--red)' : 'var(--amber)')}
            {cell(`No activity ${STALE_DAYS}d+`, stalled.length, 'var(--text-muted)')}
          </div>
          {top.length > 0 && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {top.map(x => (
                <div key={x.d.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12 }}>
                  <span style={{ color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.d.name}</span>
                  <span style={{ marginLeft: 'auto', fontWeight: 700, whiteSpace: 'nowrap', color: x.days < 0 ? 'var(--red)' : x.days <= 14 ? 'var(--amber)' : 'var(--text-muted)' }}>
                    {x.days < 0 ? `${-x.days}d overdue` : x.days === 0 ? 'today' : `${x.days}d`}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 10, lineHeight: 1.5 }}>
            Active pipeline deals with an approaching close or no recent activity.
          </div>
        </>
      )}
    </Widget>
  )
}
