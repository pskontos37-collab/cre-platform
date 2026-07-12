import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useProperties } from '../hooks/useProperties'
import { useAuth } from '../contexts/AuthContext'
import { useIsPhone } from '../hooks/useMediaQuery'
import { BrandMark, BrandWordmark } from '../components/ui/BrandMark'
import { Composer } from './InspectionsPage'

// Standalone, chrome-less inspection entry point (route /inspect). Same login,
// same data, same submit pipeline as the in-app /inspections page — just with
// none of the sidebar/dashboard around it, so a property manager on a phone
// lands straight in the form. Deep-linkable to a property: /inspect?property=<id>.
// The full software remains available via /inspections; both write to the same
// inspections table.

export function InspectFieldPage() {
  const { appUser } = useAuth()
  const { data: properties, loading, error } = useProperties()
  const isPhone = useIsPhone()
  const [params] = useSearchParams()
  const [propertyId, setPropertyId] = useState<string | null>(params.get('property'))

  const property = useMemo(
    () => properties?.find(p => p.id === propertyId) ?? null,
    [properties, propertyId],
  )

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
      {/* slim top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: isPhone ? '10px 14px' : '12px 20px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface)', position: 'sticky', top: 0, zIndex: 30,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <BrandMark size={30} />
          {!isPhone && <BrandWordmark size={13} />}
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', borderLeft: isPhone ? undefined : '1px solid var(--border-2)', paddingLeft: isPhone ? 0 : 10 }}>
            Property Inspection
          </span>
        </div>
        <Link to="/" style={{ fontSize: 11.5, color: 'var(--text-faint)', textDecoration: 'none' }}>
          Full app ↗
        </Link>
      </div>

      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        {!property ? (
          <PropertyPicker
            properties={(properties ?? []).map(p => ({ id: p.id, name: p.name, assetType: p.asset_type }))}
            loading={loading}
            error={error}
            isPhone={isPhone}
            onPick={setPropertyId}
          />
        ) : (
          <div style={{ padding: isPhone ? '12px 12px 0' : '20px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--text-faint)' }}>Inspecting</div>
                <div style={{ fontSize: isPhone ? 17 : 19, fontWeight: 700 }}>{property.name}</div>
              </div>
              <button onClick={() => setPropertyId(null)}
                style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                Change
              </button>
            </div>
            <Composer
              key={property.id}
              isPhone={isPhone}
              propertyId={property.id}
              propertyName={property.name}
              initial={null}
              defaultKind={property.asset_type === 'office' ? 'office' : 'retail'}
              defaultInspector={appUser?.full_name ?? appUser?.email ?? ''}
              uploadedBy={appUser?.id ?? null}
              onCancel={() => setPropertyId(null)}
              onDone={() => setPropertyId(null)}
              doneLabel="Done"
            />
          </div>
        )}
      </div>
    </div>
  )
}

function PropertyPicker({ properties, loading, error, isPhone, onPick }: {
  properties: { id: string; name: string; assetType: string }[]
  loading: boolean
  error: string | null
  isPhone: boolean
  onPick: (id: string) => void
}) {
  return (
    <div style={{ padding: isPhone ? '18px 14px' : '28px 20px' }}>
      <div style={{ fontSize: isPhone ? 18 : 20, fontWeight: 700, marginBottom: 4 }}>Choose a property to inspect</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18 }}>
        Tap a property to start its inspection. Your report is saved to the same system as the desktop app.
      </div>
      {loading && <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>Loading properties…</div>}
      {error && <div style={{ fontSize: 12.5, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && properties.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No properties are assigned to your account.</div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
        {properties.map(p => (
          <button key={p.id} onClick={() => onPick(p.id)}
            style={{
              textAlign: 'left', padding: '16px', borderRadius: 10, border: '1px solid var(--border)',
              background: 'var(--surface)', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4,
            }}>
            <span style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text)' }}>{p.name}</span>
            <span style={{ fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{p.assetType} · tap to inspect</span>
          </button>
        ))}
      </div>
    </div>
  )
}
