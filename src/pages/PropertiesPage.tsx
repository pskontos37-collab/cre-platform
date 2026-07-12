import { Link } from 'react-router-dom'
import { useProperties } from '../hooks/useProperties'
import { usePropertyListKpis } from '../hooks/usePropertyHub'

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const sf  = (n: number) => `${Math.round(n).toLocaleString('en-US')} SF`

const ASSET_ICON: Record<string, string> = { retail: '🛍️', office: '🏢', industrial: '🏭', mixed_use: '🏙️' }

export function PropertiesPage() {
  const { data: properties, loading } = useProperties()
  const ids = (properties ?? []).map(p => p.id)
  const totalSfById = Object.fromEntries((properties ?? []).map(p => [p.id, p.total_sf]))
  const { data: kpis } = usePropertyListKpis(ids, totalSfById)

  // Data-rich assets first so the demo leads with its best foot.
  const sorted = [...(properties ?? [])].sort((a, b) => {
    const an = kpis?.[a.id]?.t12Noi ?? null
    const bn = kpis?.[b.id]?.t12Noi ?? null
    if (an !== null && bn !== null) return bn - an
    if (an !== null) return -1
    if (bn !== null) return 1
    return a.name.localeCompare(b.name)
  })

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>Properties</h1>
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
          {properties?.length ?? 0} owned assets
        </span>
      </div>

      {loading && <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>Loading…</div>}

      <div
        style={{
          display:             'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap:                 12,
        }}
      >
        {sorted.map(p => {
          const k = kpis?.[p.id]
          const hasData = k && (k.t12Noi !== null || k.annualRent !== null)
          return (
            <Link
              key={p.id}
              to={`/properties/${p.id}`}
              style={{
                textDecoration: 'none',
                background:     'var(--surface)',
                border:         '1px solid var(--border)',
                borderRadius:   10,
                padding:        '14px 16px',
                display:        'block',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <span style={{ fontSize: 22, lineHeight: 1 }}>{ASSET_ICON[p.asset_type] ?? '🏢'}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.name}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
                    {[p.city, p.state].filter(Boolean).join(', ') || '—'}
                    {p.total_sf ? ` · ${sf(p.total_sf)}` : ''}
                  </div>
                </div>
                {hasData && (
                  <span
                    style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: '0.05em',
                      color: 'var(--accent)', background: 'var(--accent-dim)',
                      padding: '2px 7px', borderRadius: 99, textTransform: 'uppercase',
                    }}
                  >
                    Live data
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', gap: 18, marginTop: 12 }}>
                <Kpi label="T12 NOI"   value={k?.t12Noi != null ? usd(k.t12Noi) : '—'} />
                <Kpi label="Occupancy" value={k?.occupancyPct != null ? `${(k.occupancyPct * 100).toFixed(1)}%` : '—'} />
                <Kpi label="Annual rent" value={k?.annualRent != null ? usd(k.annualRent) : '—'} />
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 9.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-faint)' }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--text)', marginTop: 2 }}>{value}</div>
    </div>
  )
}
