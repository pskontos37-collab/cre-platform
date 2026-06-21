import { useAuth } from '../../contexts/AuthContext'
import { useFilter } from '../../contexts/FilterContext'
import { useProperties, usePortfolios } from '../../hooks/useProperties'
import { ThemePicker } from '../ui/ThemePicker'

export function Header() {
  const { appUser, signOut } = useAuth()
  const { filter, setFilter } = useFilter()
  const { data: properties } = useProperties()
  const { data: portfolios } = usePortfolios()

  const isAdmin = appUser?.role === 'admin'

  return (
    <header
      style={{
        height:        52,
        borderBottom:  '1px solid var(--border)',
        display:       'flex',
        alignItems:    'center',
        padding:       '0 16px',
        gap:           12,
        background:    'var(--surface)',
        position:      'sticky',
        top:           0,
        zIndex:        10,
      }}
    >
      {/* Filter scope selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>View:</span>
        <FilterButton
          label="All Properties"
          active={filter.scope === 'all'}
          onClick={() => setFilter({ scope: 'all', id: null, label: 'All Properties' })}
        />
        {(portfolios ?? []).map(p => (
          <FilterButton
            key={p.id}
            label={p.name}
            active={filter.scope === 'portfolio' && filter.id === p.id}
            onClick={() => setFilter({ scope: 'portfolio', id: p.id, label: p.name })}
          />
        ))}

        {/* Property dropdown */}
        {(properties ?? []).length > 0 && (
          <select
            value={filter.scope === 'property' ? (filter.id ?? '') : ''}
            onChange={e => {
              if (!e.target.value) {
                setFilter({ scope: 'all', id: null, label: 'All Properties' })
              } else {
                const p = properties!.find(x => x.id === e.target.value)
                if (p) setFilter({ scope: 'property', id: p.id, label: p.name })
              }
            }}
            style={{
              background:   'var(--surface-2)',
              border:       '1px solid var(--border-2)',
              borderRadius: 6,
              color:        filter.scope === 'property' ? 'var(--accent)' : 'var(--text-muted)',
              fontSize:     12,
              padding:      '3px 8px',
              cursor:       'pointer',
              outline:      'none',
            }}
          >
            <option value="">Single Property…</option>
            {(properties ?? []).map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Right side actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {isAdmin && (
          <a
            href="/properties/new"
            style={{
              background:   'var(--accent)',
              color:        '#fff',
              fontSize:     12,
              fontWeight:   600,
              padding:      '5px 12px',
              borderRadius: 6,
              textDecoration:'none',
              whiteSpace:   'nowrap',
            }}
          >
            + Add Property
          </a>
        )}
        <ThemePicker />
        <button
          onClick={signOut}
          title="Sign out"
          style={{
            background:   'var(--surface-2)',
            border:       '1px solid var(--border-2)',
            borderRadius: 6,
            color:        'var(--text-muted)',
            fontSize:     11,
            padding:      '5px 10px',
            cursor:       'pointer',
          }}
        >
          Sign out
        </button>
      </div>
    </header>
  )
}

function FilterButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background:   active ? 'var(--accent-dim)' : 'var(--surface-2)',
        border:       active ? '1px solid var(--accent)' : '1px solid var(--border-2)',
        borderRadius: 6,
        color:        active ? 'var(--accent)' : 'var(--text-muted)',
        fontSize:     12,
        fontWeight:   active ? 600 : 400,
        padding:      '3px 10px',
        cursor:       'pointer',
        whiteSpace:   'nowrap',
      }}
    >
      {label}
    </button>
  )
}
