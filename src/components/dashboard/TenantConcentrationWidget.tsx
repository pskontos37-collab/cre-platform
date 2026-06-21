import { Widget, WidgetSkeleton } from '../ui/Widget'
import { EmptyState } from '../ui/EmptyState'
import { useTenantConcentration } from '../../hooks/useDashboard'

const fmtDollar = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const fmtPct = (n: number) => (n * 100).toFixed(1) + '%'

interface TenantConcentrationWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
}

const BAR_COLORS = [
  'var(--accent)', '#a78bfa', '#fb923c', '#34d399', '#f472b6',
  'var(--amber)', '#67e8f9', '#818cf8', '#4ade80', '#fbbf24',
]

export function TenantConcentrationWidget({ propertyIds, propertyNames }: TenantConcentrationWidgetProps) {
  const { data, loading, error } = useTenantConcentration(propertyIds, propertyNames)
  const rows = data ?? []

  return (
    <Widget title="Tenant Concentration" chip="Top 10 by rent" fullWidth>
      {loading && <WidgetSkeleton rows={5} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <EmptyState title="No active leases" subtitle="Add leases to see tenant concentration" />
      )}
      {!loading && !error && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {/* Header row */}
          <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr 120px 100px 60px 80px', gap: 8, padding: '0 2px 4px', borderBottom: '1px solid var(--border)' }}>
            {['#', 'Tenant', 'Property', 'Annual Rent', '% of Total', 'SF'].map(h => (
              <div key={h} style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-faint)' }}>{h}</div>
            ))}
          </div>
          {rows.map((row, i) => (
            <div
              key={row.tenantId}
              style={{ display: 'grid', gridTemplateColumns: '28px 1fr 120px 100px 60px 80px', gap: 8, alignItems: 'center', padding: '5px 2px' }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: BAR_COLORS[i % BAR_COLORS.length] }}>#{i + 1}</div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {row.tenantName}
                </div>
                {/* Mini bar */}
                <div style={{ height: 3, background: 'var(--surface-2)', borderRadius: 99, marginTop: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(row.pctOfTotal * 100, 100)}%`, height: '100%', background: BAR_COLORS[i % BAR_COLORS.length], borderRadius: 99 }} />
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.propertyName}</div>
              <div style={{ fontSize: 12, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{fmtDollar(row.annualRent)}</div>
              <div style={{ fontSize: 12, color: row.pctOfTotal > 0.20 ? 'var(--amber)' : 'var(--text-muted)', fontWeight: row.pctOfTotal > 0.20 ? 600 : 400 }}>
                {fmtPct(row.pctOfTotal)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{row.leasedSf.toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </Widget>
  )
}
