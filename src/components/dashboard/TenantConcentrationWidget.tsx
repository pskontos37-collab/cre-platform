import { Widget, WidgetSkeleton } from '../ui/Widget'
import { EmptyState } from '../ui/EmptyState'
import { useRentRoll } from '../../hooks/useRentRoll'

const fmtDollar = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const fmtPct = (n: number) => (n * 100).toFixed(1) + '%'

interface TenantConcentrationWidgetProps {
  propertyIds: string[]
  propertyNames?: Record<string, string>
}

const BAR_COLORS = [
  'var(--accent)', '#a78bfa', '#fb923c', '#34d399', '#f472b6',
  'var(--amber)', '#67e8f9', '#818cf8', '#4ade80', '#fbbf24',
]

// Sourced from the most recent rent roll (rent_roll_rows), which is where Knightdale
// tenancy data actually lives. propertyNames accepted for dashboard call compatibility.
export function TenantConcentrationWidget({ propertyIds }: TenantConcentrationWidgetProps) {
  const { data, loading, error } = useRentRoll(propertyIds)
  const rows = data?.topTenants ?? []

  return (
    <Widget title="Tenant Concentration" chip="Top tenants by base rent" href="/properties" fullWidth>
      {loading && <WidgetSkeleton rows={5} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <EmptyState title="No tenant data" subtitle="Import a rent roll to rank tenants" />
      )}
      {!loading && !error && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr 110px 70px 90px 90px', gap: 8, padding: '0 2px 4px', borderBottom: '1px solid var(--border)' }}>
            {['#', 'Tenant', 'Annual Rent', '% Rent', 'Leased SF', 'Lease End'].map(h => (
              <div key={h} style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-faint)' }}>{h}</div>
            ))}
          </div>
          {rows.map((row, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '28px 1fr 110px 70px 90px 90px', gap: 8, alignItems: 'center', padding: '5px 2px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: BAR_COLORS[i % BAR_COLORS.length] }}>#{i + 1}</div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {row.tenant}
                </div>
                <div style={{ height: 3, background: 'var(--surface-2)', borderRadius: 99, marginTop: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(row.pct * 100, 100)}%`, height: '100%', background: BAR_COLORS[i % BAR_COLORS.length], borderRadius: 99 }} />
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{fmtDollar(row.annualRent)}</div>
              <div style={{ fontSize: 12, color: row.pct > 0.20 ? 'var(--amber)' : 'var(--text-muted)', fontWeight: row.pct > 0.20 ? 600 : 400 }}>
                {fmtPct(row.pct)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{Math.round(row.sf).toLocaleString()}</div>
              <div style={{ fontSize: 11, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
                {row.leaseEnd ? new Date(row.leaseEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'short' }) : '—'}
              </div>
            </div>
          ))}
        </div>
      )}
    </Widget>
  )
}
