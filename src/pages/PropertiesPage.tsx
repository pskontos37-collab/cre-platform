import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useProperties } from '../hooks/useProperties'
import { usePropertyListKpis } from '../hooks/usePropertyHub'
import { usePropertyDataStatus } from '../hooks/usePropertyDataStatus'
import { useCan } from '../lib/useActions'

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const sf  = (n: number) => `${Math.round(n).toLocaleString('en-US')} SF`

const ASSET_ICON: Record<string, string> = { retail: '🛍️', office: '🏢', industrial: '🏭', mixed_use: '🏙️' }

export function PropertiesPage() {
  const { data: properties, loading } = useProperties()
  const { data: dataStatus } = usePropertyDataStatus()
  const [showPending, setShowPending] = useState(false)
  const canOnboard = useCan('properties.onboard')   // action gate (Phase 3b)
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

  // Only 4 of 26 properties carry data; the other 22 are name-only shells awaiting
  // onboarding. Rendering all 26 as equal cards made a working 4-asset portfolio read as
  // a mostly-empty one. The pending assets are COLLAPSED, not removed — they are real
  // assets and still need to be reachable to onboard them, so the count stays visible and
  // one click expands. Uses the same data_loaded signal as the header and the Financials
  // picker; while it loads, treat as loaded so nothing flickers out of view.
  const isLoaded = (id: string) => (dataStatus ? (dataStatus[id]?.data_loaded ?? false) : true)
  const live = sorted.filter(p => isLoaded(p.id))
  const pending = sorted.filter(p => !isLoaded(p.id))
  // Never hide everything: on a fresh install with nothing loaded, show all.
  const shown = showPending || live.length === 0 ? sorted : live

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>Properties</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
            {properties?.length ?? 0} owned assets
          </span>
          {canOnboard && (
            <Link to="/onboarding" style={{
              fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 6,
              background: 'var(--accent)', color: '#fff', textDecoration: 'none',
            }}>+ Add property</Link>
          )}
        </div>
      </div>

      {loading && <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>Loading…</div>}

      {pending.length > 0 && live.length > 0 && (
        <button
          onClick={() => setShowPending(v => !v)}
          style={{
            marginBottom: 12, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
            color: 'var(--text-muted)', background: 'var(--surface-2)',
            border: '1px solid var(--border-2)', borderRadius: 7, padding: '5px 11px', outline: 'none',
          }}
        >
          {showPending
            ? `Hide ${pending.length} pending onboarding ▴`
            : `${live.length} with data · ${pending.length} pending onboarding ▾`}
        </button>
      )}

      <div
        style={{
          display:             'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap:                 12,
        }}
      >
        {shown.map(p => {
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
                {hasData ? (
                  <span
                    style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: '0.05em',
                      color: 'var(--accent)', background: 'var(--accent-dim)',
                      padding: '2px 7px', borderRadius: 99, textTransform: 'uppercase',
                    }}
                  >
                    Live data
                  </span>
                ) : (
                  <span
                    style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: '0.05em',
                      color: 'var(--text-faint)', background: 'var(--surface-2)',
                      border: '1px solid var(--border-2)',
                      padding: '2px 7px', borderRadius: 99, textTransform: 'uppercase',
                    }}
                  >
                    Onboarding
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
