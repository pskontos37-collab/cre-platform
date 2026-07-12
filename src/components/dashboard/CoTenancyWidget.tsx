import { useMemo } from 'react'
import { Widget, WidgetSkeleton } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { useCoTenancyFlags } from '../../hooks/useDashboard'
import { useCoTenancyRisk, useTerminationRisk, TIER_RANK, TIER_COLOR, TIER_LABEL } from '../../hooks/useLeaseRights'
import { supabase } from '../../lib/supabase'

interface CoTenancyWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
}


export function CoTenancyWidget({ propertyIds, propertyNames }: CoTenancyWidgetProps) {
  const { data, loading, error, refetch } = useCoTenancyFlags(propertyIds)
  const rows = data ?? []

  // Forward-looking layer: projected co-tenancy risk + live termination rights
  // (migration 20240072 RPCs). Triggered clauses become real flags via the sync
  // RPC above; everything below "triggered" shows here as At Risk.
  const risk = useCoTenancyRisk(propertyIds)
  const term = useTerminationRisk(propertyIds)
  const atRisk = useMemo(() => {
    const ct = (risk.data ?? [])
      .filter(r => r.tier !== 'ok' && r.tier !== 'triggered')
      .map(r => ({ key: `ct-${r.clause_id}`, tenant: r.tenant_name, property_id: r.property_id, tier: r.tier, text: r.reasons.join(' · ') }))
    const tr = (term.data ?? [])
      .filter(r => ['triggered', 'open', 'high'].includes(r.tier))
      .map(r => ({ key: `tr-${r.right_id}`, tenant: r.tenant_name, property_id: r.property_id, tier: r.tier, text: r.details ?? r.reasons.join(' · ') }))
    return [...ct, ...tr]
      .sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9))
      .slice(0, 8)
  }, [risk.data, term.data])

  async function handleDismiss(flagId: string) {
    await supabase.from('co_tenancy_flags').update({ status: 'dismissed' }).eq('id', flagId)
    refetch()
  }

  async function handleConfirm(flagId: string) {
    await supabase.from('co_tenancy_flags').update({ status: 'confirmed' }).eq('id', flagId)
    refetch()
  }

  return (
    <Widget title="Co-Tenancy Alerts" chip={rows.length > 0 ? `${rows.length} pending` : undefined}>
      {loading && <WidgetSkeleton rows={2} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && rows.length === 0 && atRisk.length === 0 && (
        <EmptyState icon="✅" title="No co-tenancy alerts" subtitle="No triggered clauses or projected risks" />
      )}
      {!loading && !error && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map(row => (
            <div
              key={row.id}
              style={{
                padding:      '10px 12px',
                background:   'var(--amber-bg)',
                borderRadius: 8,
                border:       '1px solid var(--amber-border)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                    {propertyNames[row.property_id] ?? 'Unknown property'}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                    Triggered {new Date(row.triggered_at).toLocaleDateString()}
                  </div>
                </div>
                <Badge variant="amber">Pending Review</Badge>
              </div>

              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                {row.trigger_reason}
              </div>

              {row.remedy_description && (
                <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 8 }}>
                  Remedy: {row.remedy_description}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => handleConfirm(row.id)}
                  style={{
                    background:   'var(--amber)',
                    color:        '#000',
                    border:       'none',
                    borderRadius: 5,
                    fontSize:     11,
                    fontWeight:   600,
                    padding:      '4px 12px',
                    cursor:       'pointer',
                  }}
                >
                  Confirm
                </button>
                <button
                  onClick={() => handleDismiss(row.id)}
                  style={{
                    background:   'var(--surface-2)',
                    color:        'var(--text-muted)',
                    border:       '1px solid var(--border-2)',
                    borderRadius: 5,
                    fontSize:     11,
                    padding:      '4px 12px',
                    cursor:       'pointer',
                  }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && !error && atRisk.length > 0 && (
        <div style={{ marginTop: rows.length > 0 ? 12 : 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 6 }}>
            At risk — projected
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {atRisk.map(r => {
              const c = TIER_COLOR[r.tier] ?? TIER_COLOR.unknown
              return (
                <div key={r.key} style={{ padding: '7px 10px', background: 'var(--surface-2)', borderRadius: 7, border: '1px solid var(--border-2)' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 2 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)' }}>{r.tenant}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-faint)', flex: 1 }}>{propertyNames[r.property_id] ?? ''}</span>
                    <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 7px', borderRadius: 8, color: c.fg, background: c.bg }}>
                      {TIER_LABEL[r.tier] ?? r.tier}
                    </span>
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.45 }}>{r.text}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </Widget>
  )
}
