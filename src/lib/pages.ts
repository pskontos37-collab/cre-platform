import type { UserRole } from '../types/database'

// Single source of truth for the app's navigable pages. The sidebar, the route
// table (App.tsx) and the access-template builder all read from this list so a
// page key means the same thing everywhere.
//
//   restricted  — asset_manager + admin only (financial / capital data).
//   adminOnly   — the admin panel itself; never assignable to a template.
//
// A page with neither flag is visible to any active user (subject to their
// template's `allowed_pages`, if set).

export interface PageDef {
  key: string
  path: string
  label: string
  icon: string
  restricted?: boolean
  adminOnly?: boolean
  group?: string          // sidebar accordion group (see NAV_GROUPS); admin is pinned separately
}

export const PAGES: PageDef[] = [
  { key: 'dashboard',   path: '/',            label: 'Dashboard',   icon: '▦',  group: 'workspace' },
  { key: 'tasks',       path: '/tasks',       label: 'Tasks',       icon: '✓',  group: 'workspace' },
  { key: 'ask',         path: '/ask',         label: 'Ask AI',      icon: '✨', group: 'workspace' },
  { key: 'pipeline',    path: '/pipeline',    label: 'Pipeline',    icon: '📈', restricted: true, group: 'acquisitions' },
  { key: 'diligence',   path: '/diligence',   label: 'Diligence',   icon: '🔎', restricted: true, group: 'acquisitions' },
  { key: 'ppm',         path: '/ppm',         label: 'PPM',         icon: '📃', restricted: true, group: 'acquisitions' },
  { key: 'properties',  path: '/properties',  label: 'Properties',  icon: '🏢', group: 'portfolio' },
  { key: 'siteplans',   path: '/siteplans',   label: 'Site Plans',  icon: '🗺', group: 'portfolio' },
  { key: 'financials',  path: '/financials',  label: 'Financials',  icon: '📊', restricted: true, group: 'portfolio' },
  { key: 'receivables', path: '/receivables', label: 'Receivables', icon: '💵', group: 'portfolio' },
  { key: 'waterfall',   path: '/waterfall',   label: 'Waterfall',   icon: '💧', restricted: true, group: 'portfolio' },
  { key: 'transactions',path: '/transactions',label: 'Transactions',icon: '🧾', restricted: true, group: 'portfolio' },
  { key: 'management',  path: '/management',  label: 'Agreements',  icon: '📝', restricted: true, group: 'portfolio' },
  { key: 'rea',         path: '/rea',         label: 'REAs',        icon: '📜', group: 'portfolio' },
  { key: 'abstracts',   path: '/abstracts',   label: 'Abstracts',   icon: '🗂', restricted: true, group: 'leasing' },
  { key: 'clauses',     path: '/clauses',     label: 'Clauses',     icon: '§',  restricted: true, group: 'leasing' },
  { key: 'brokerage',   path: '/brokerage',   label: 'Brokerage',   icon: '🤝', group: 'leasing' },
  { key: 'documents',   path: '/documents',   label: 'Documents',   icon: '📁', group: 'leasing' },
  { key: 'mri',         path: '/mri-recon',   label: 'MRI Recon',   icon: '🔀', restricted: true, group: 'leasing' },
  { key: 'services',    path: '/services',    label: 'Service Agreements', icon: '🔧', group: 'operations' },
  { key: 'announcements', path: '/announcements', label: 'Announcements', icon: '📣', group: 'operations' },
  { key: 'contacts',    path: '/contacts',    label: 'Contacts',    icon: '📇', group: 'operations' },
  { key: 'workorders',  path: '/workorders',  label: 'Work Orders', icon: '🛠', group: 'operations' },
  { key: 'insurance',   path: '/insurance',   label: 'Insurance',   icon: '🛡', group: 'operations' },
  { key: 'inspections', path: '/inspections', label: 'Inspections', icon: '🔍', group: 'operations' },
  { key: 'forms',       path: '/forms',       label: 'Forms',       icon: '📋', group: 'operations' },
  { key: 'emergency',   path: '/emergency-manuals', label: 'Emergency Manuals', icon: '🚨', group: 'operations' },
  { key: 'market',      path: '/market',      label: 'Market',      icon: '🌐', group: 'operations' },
  { key: 'admin',       path: '/admin',       label: 'Admin',       icon: '⚙', adminOnly: true },
]

// Sidebar accordion groups, in display order. Admin is rendered separately (pinned).
export interface NavGroupDef { key: string; label: string }
export const NAV_GROUPS: NavGroupDef[] = [
  { key: 'workspace',    label: 'Workspace' },
  { key: 'acquisitions', label: 'Acquisitions' },
  { key: 'portfolio',    label: 'Portfolio' },
  { key: 'leasing',      label: 'Leasing & Docs' },
  { key: 'operations',   label: 'Operations' },
]

export const PAGE_BY_KEY: Record<string, PageDef> =
  Object.fromEntries(PAGES.map(p => [p.key, p]))

// Pages an access template is allowed to toggle (everything except the admin panel).
export const ASSIGNABLE_PAGES: PageDef[] = PAGES.filter(p => !p.adminOnly)

export interface PageViewer {
  role: UserRole
  allowed_pages: string[] | null
}

/** Can this user see the given page today? Role floor first, then template. */
export function canSeePage(user: PageViewer | null | undefined, key: string): boolean {
  if (!user) return false
  const page = PAGE_BY_KEY[key]
  if (!page) return false
  if (page.adminOnly) return user.role === 'admin'
  if (user.role === 'admin') return true
  // Restricted pages: asset managers only (property managers never see them).
  if (page.restricted && user.role !== 'asset_manager') return false
  // Per-user page allow-list from an applied template (null = no extra limit).
  if (user.allowed_pages && !user.allowed_pages.includes(key)) return false
  return true
}

export function visiblePages(user: PageViewer | null | undefined): PageDef[] {
  return PAGES.filter(p => canSeePage(user, p.key))
}

/**
 * Visible non-admin pages bucketed into the ordered NAV_GROUPS for the sidebar
 * accordion. Groups with no visible pages are dropped, so a user only ever sees
 * headers that contain something they can open.
 */
export function visiblePagesByGroup(
  user: PageViewer | null | undefined,
): { group: NavGroupDef; pages: PageDef[] }[] {
  const vis = visiblePages(user).filter(p => !p.adminOnly)
  return NAV_GROUPS
    .map(group => ({ group, pages: vis.filter(p => p.group === group.key) }))
    .filter(x => x.pages.length > 0)
}
