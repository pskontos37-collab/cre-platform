import { ReactNode, useMemo, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { BrandMark, BrandWordmark } from '../ui/BrandMark'
import { visiblePages, visiblePagesByGroup } from '../../lib/pages'
import { useAssignedTaskCount } from '../../hooks/useTasks'

const GROUPS_KEY   = 'cre-sidebar-groups'
const RAIL_WIDTH   = 56
const OPEN_WIDTH    = 220

export function Sidebar() {
  const { appUser } = useAuth()
  // Collapsed to a narrow icon rail by default; expands on hover or when the
  // brand is tapped. The expanded panel floats over the page without reflow.
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const collapsed = !(hovered || pinned)
  const groups   = visiblePagesByGroup(appUser)
  const adminNav = visiblePages(appUser).filter(p => p.key === 'admin')
  const { data: taskAlerts } = useAssignedTaskCount(appUser?.id ?? '')

  // The group holding the current route — expanded by default so the user never
  // lands on a page whose section is collapsed.
  const location = useLocation()
  const activeGroupKey = useMemo(() => {
    for (const { group, pages } of groups) {
      if (pages.some(p => p.path === '/' ? location.pathname === '/' : location.pathname === p.path || location.pathname.startsWith(p.path + '/'))) {
        return group.key
      }
    }
    return null
  }, [groups, location.pathname])

  // Persisted per-group open/closed toggles; undefined → default (active group open).
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(GROUPS_KEY) || '{}') } catch { return {} }
  })
  const isOpen = (k: string) => openGroups[k] ?? (k === activeGroupKey)
  const toggleGroup = (k: string) => setOpenGroups(s => {
    const next = { ...s, [k]: !(s[k] ?? (k === activeGroupKey)) }
    localStorage.setItem(GROUPS_KEY, JSON.stringify(next))
    return next
  })

  return (
    <aside
      className="app-sidebar"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        // The rail always occupies RAIL_WIDTH in the flex flow; the inner panel
        // grows over the page content on hover so nothing reflows.
        width:      RAIL_WIDTH,
        flexShrink: 0,
        height:     '100vh',
        position:   'sticky',
        top:        0,
        zIndex:     40,
      }}
    >
      <div
      style={{
        width:      collapsed ? RAIL_WIDTH : OPEN_WIDTH,
        background: 'var(--surface)',
        borderRight:'1px solid var(--border)',
        display:    'flex',
        flexDirection:'column',
        height:     '100vh',
        position:   'absolute',
        top:        0,
        left:       0,
        overflow:   'hidden',
        boxShadow:  collapsed ? 'none' : '4px 0 24px rgba(0,0,0,0.18)',
        transition: 'width 0.15s ease, box-shadow 0.15s ease',
      }}
    >
      <button
        type="button"
        onClick={() => { setPinned(p => !p); setHovered(false) }}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Open navigation' : 'Close navigation'}
        title={collapsed ? 'Open navigation' : 'Close navigation'}
        style={{
          padding:     collapsed ? '20px 10px 16px' : '20px 16px 16px',
          borderBottom:'1px solid var(--border)',
          borderTop:   'none',
          borderLeft:  'none',
          borderRight: 'none',
          width:       '100%',
          background:  'transparent',
          color:       'inherit',
          cursor:      'pointer',
          display:     'flex',
          alignItems:  'center',
          justifyContent: collapsed ? 'center' : 'flex-start',
          gap:         11,
        }}
      >
        <BrandMark size={36} />
        {!collapsed && (
          <div>
            <BrandWordmark size={14.5} />
            <div
              style={{
                fontSize:      8.5,
                fontWeight:    600,
                letterSpacing: '0.22em',
                textTransform: 'uppercase',
                color:         'var(--text-faint)',
                marginTop:     3,
              }}
            >
              Asset Management
            </div>
          </div>
        )}
        {!collapsed && <span aria-hidden="true" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-faint)' }}>‹</span>}
      </button>

      <nav style={{ flex: 1, padding: '8px 8px', overflowY: 'auto', overflowX: 'hidden' }}>
        {collapsed ? (
          // Icon rail: no room for headers — show every page flat.
          <NavGroup>
            {groups.flatMap(g => g.pages).map(p => (
              <NavItem key={p.key} to={p.path} label={p.label} icon={p.icon} collapsed badge={p.key === 'tasks' ? (taskAlerts ?? 0) : 0} />
            ))}
          </NavGroup>
        ) : (
          groups.map(({ group, pages }) => (
            <NavSection key={group.key} label={group.label} open={isOpen(group.key)} onToggle={() => toggleGroup(group.key)}>
              {pages.map(p => <NavItem key={p.key} to={p.path} label={p.label} icon={p.icon} badge={p.key === 'tasks' ? (taskAlerts ?? 0) : 0} />)}
            </NavSection>
          ))
        )}

        <NavGroup label={collapsed ? undefined : 'External'}>
          <ExtItem
            href="https://mjwilkow1.sharepoint.com/sites/MJWilkowSubmissionPortal"
            label="Submission Portal"
            icon="🔗"
            collapsed={collapsed}
          />
        </NavGroup>

        {adminNav.length > 0 && (
          <NavGroup label={collapsed ? undefined : 'Admin'}>
            {adminNav.map(p => <NavItem key={p.key} to={p.path} label={p.label} icon={p.icon} collapsed={collapsed} />)}
          </NavGroup>
        )}
      </nav>

      <div
        style={{
          padding:    collapsed ? '12px 6px' : '12px 16px',
          borderTop:  '1px solid var(--border)',
          fontSize:   11,
          color:      'var(--text-faint)',
          textAlign:  collapsed ? 'center' : 'left',
          overflow:   'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
        }}
        title={appUser?.full_name ?? appUser?.email ?? undefined}
      >
        {collapsed
          ? (appUser?.full_name ?? appUser?.email ?? '—').slice(0, 2).toUpperCase()
          : (appUser?.full_name ?? appUser?.email ?? '—')}
        {!collapsed && (
          <div style={{ fontSize: 10, marginTop: 2, color: 'var(--text-faint)', opacity: 0.7 }}>
            {appUser?.role?.replace('_', ' ')}
          </div>
        )}
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

// A collapsible accordion section: a clickable uppercase header with a chevron,
// and its NavItems shown only when open. A count badge on the header surfaces
// unseen items (tasks) even when the group is collapsed.
function NavSection({ label, open, onToggle, children }: { label: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display:        'flex',
          alignItems:     'center',
          gap:            6,
          width:          '100%',
          padding:        '9px 8px 4px',
          border:         'none',
          background:     'transparent',
          cursor:         'pointer',
          fontSize:       9,
          fontWeight:     700,
          textTransform:  'uppercase',
          letterSpacing:  '0.08em',
          color:          'var(--text-faint)',
        }}
      >
        <span style={{ fontSize: 8, display: 'inline-block', transition: 'transform 0.12s ease', transform: open ? 'rotate(90deg)' : 'none' }}>▸</span>
        <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
      </button>
      {open && <div>{children}</div>}
    </div>
  )
}

function NavItem({ to, label, icon, collapsed, badge = 0 }: { to: string; label: string; icon: string; collapsed?: boolean; badge?: number }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      title={collapsed ? (badge > 0 ? `${label} (${badge} new)` : label) : undefined}
      style={({ isActive }) => ({
        display:       'flex',
        alignItems:    'center',
        justifyContent: collapsed ? 'center' : 'flex-start',
        gap:           collapsed ? 0 : 8,
        padding:       '7px 8px',
        borderRadius:  6,
        textDecoration:'none',
        fontSize:      13,
        fontWeight:    isActive ? 600 : 400,
        color:         isActive ? 'var(--accent)' : 'var(--text-muted)',
        background:    isActive ? 'var(--accent-dim)' : 'transparent',
        marginBottom:  1,
        position:      'relative',
      })}
    >
      <span style={{ fontSize: 14, position: 'relative' }}>
        {icon}
        {/* Collapsed rail: a dot on the icon since there's no room for a count. */}
        {collapsed && badge > 0 && (
          <span style={{ position: 'absolute', top: -3, right: -5, width: 7, height: 7, borderRadius: 99, background: 'var(--red)' }} />
        )}
      </span>
      {!collapsed && <span style={{ flex: 1 }}>{label}</span>}
      {!collapsed && badge > 0 && (
        <span style={{
          fontSize: 10.5, fontWeight: 700, color: '#fff', background: 'var(--red)',
          borderRadius: 99, minWidth: 17, height: 17, lineHeight: '17px', textAlign: 'center', padding: '0 5px',
        }}>
          {badge}
        </span>
      )}
    </NavLink>
  )
}

function ExtItem({ href, label, icon, collapsed }: { href: string; label: string; icon: string; collapsed?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={collapsed ? label : label + ' (opens in new tab)'}
      style={{
        display:        'flex',
        alignItems:     'center',
        justifyContent: collapsed ? 'center' : 'flex-start',
        gap:            collapsed ? 0 : 8,
        padding:        '7px 8px',
        borderRadius:   6,
        textDecoration: 'none',
        fontSize:       13,
        fontWeight:     400,
        color:          'var(--text-muted)',
        background:     'transparent',
        marginBottom:   1,
      }}
    >
      <span style={{ fontSize: 14 }}>{icon}</span>
      {!collapsed && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {label}
          <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>↗</span>
        </span>
      )}
    </a>
  )
}
