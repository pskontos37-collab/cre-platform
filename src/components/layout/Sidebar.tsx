import { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'

const NAV = [
  { to: '/',           label: 'Dashboard',   icon: '▦' },
  { to: '/properties', label: 'Properties',  icon: '🏢' },
  { to: '/tenants',    label: 'Tenants',     icon: '👥' },
  { to: '/financials', label: 'Financials',  icon: '📊' },
  { to: '/loans',      label: 'Loans',       icon: '🏦' },
  { to: '/documents',  label: 'Documents',   icon: '📁' },
]

const ADMIN_NAV = [
  { to: '/import',  label: 'Drive Import', icon: '📥' },
  { to: '/users',   label: 'Users',        icon: '🔑' },
  { to: '/audit',   label: 'Audit Log',    icon: '📋' },
]

export function Sidebar() {
  const { appUser } = useAuth()

  return (
    <aside
      style={{
        width:      220,
        flexShrink: 0,
        background: 'var(--surface)',
        borderRight:'1px solid var(--border)',
        display:    'flex',
        flexDirection:'column',
        height:     '100vh',
        position:   'sticky',
        top:        0,
      }}
    >
      <div
        style={{
          padding:     '18px 16px 14px',
          borderBottom:'1px solid var(--border)',
          display:     'flex',
          alignItems:  'center',
          gap:         8,
        }}
      >
        <span style={{ fontSize: 20 }}>🏗️</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', lineHeight: 1.2 }}>CRE Platform</div>
          <div style={{ fontSize: 10, color: 'var(--text-faint)', lineHeight: 1.3 }}>Asset Management</div>
        </div>
      </div>

      <nav style={{ flex: 1, padding: '8px 8px', overflowY: 'auto' }}>
        <NavGroup>
          {NAV.map(item => <NavItem key={item.to} {...item} />)}
        </NavGroup>

        {appUser?.role === 'admin' && (
          <NavGroup label="Admin">
            {ADMIN_NAV.map(item => <NavItem key={item.to} {...item} />)}
          </NavGroup>
        )}
      </nav>

      <div
        style={{
          padding:    '12px 16px',
          borderTop:  '1px solid var(--border)',
          fontSize:   11,
          color:      'var(--text-faint)',
        }}
      >
        {appUser?.full_name ?? appUser?.email ?? '—'}
        <div style={{ fontSize: 10, marginTop: 2, color: 'var(--text-faint)', opacity: 0.7 }}>
          {appUser?.role?.replace('_', ' ')}
        </div>
      </div>
    </aside>
  )
}

function NavGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      {label && (
        <div
          style={{
            fontSize:      9,
            fontWeight:    700,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color:         'var(--text-faint)',
            padding:       '10px 8px 4px',
          }}
        >
          {label}
        </div>
      )}
      {children}
    </div>
  )
}

function NavItem({ to, label, icon }: { to: string; label: string; icon: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      style={({ isActive }) => ({
        display:       'flex',
        alignItems:    'center',
        gap:           8,
        padding:       '7px 8px',
        borderRadius:  6,
        textDecoration:'none',
        fontSize:      13,
        fontWeight:    isActive ? 600 : 400,
        color:         isActive ? 'var(--accent)' : 'var(--text-muted)',
        background:    isActive ? 'var(--accent-dim)' : 'transparent',
        marginBottom:  1,
      })}
    >
      <span style={{ fontSize: 14 }}>{icon}</span>
      {label}
    </NavLink>
  )
}
