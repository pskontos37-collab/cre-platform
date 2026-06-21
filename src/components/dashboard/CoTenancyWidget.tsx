import { Widget, WidgetSkeleton } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { useCoTenancyFlags } from '../../hooks/useDashboard'
import { supabase } from '../../lib/supabase'

interface CoTenancyWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
}


export function CoTenancyWidget({ propertyIds, propertyNames }: CoTenancyWidgetProps) {
  const { data, loading, error, refetch } = useCoTenancyFlags(propertyIds)
  const rows = data ?? []

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
      {!loading && !error && rows.length === 0 && (
        <EmptyState icon="✅" title="No co-tenancy alerts" subtitle="No pending co-tenancy clause triggers" />
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
    </Widget>
  )
}
