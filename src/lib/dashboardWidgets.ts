// Dashboard widget metadata, shared between DashboardPage (which owns the
// renderers) and AdminPage (which lets admins build dashboard presets on
// access templates). Keys are stored in access_templates.dashboard_widgets /
// users.dashboard_widgets (migration 20240071), so treat them as a stable,
// append-only vocabulary.
import type { UserRole } from '../types/database'

export const DASHBOARD_SECTIONS: Array<{ id: string; label: string }> = [
  { id: 'workflow',    label: 'Tasks & Follow-Ups' },
  { id: 'financial',   label: 'Financial Performance' },
  { id: 'receivables', label: 'Receivables & Income Risk' },
  { id: 'leasing',     label: 'Leasing & Occupancy' },
  { id: 'reference',   label: 'Reference' },
]

export interface DashboardWidgetDef {
  key: string
  label: string
  section: string
  /** In the full default lineup (asset manager / admin). */
  def: boolean
}

export const WIDGET_DEFS: DashboardWidgetDef[] = [
  { key: 'my_tasks',      label: 'My Tasks',                      section: 'workflow',    def: true },
  { key: 'work_orders',   label: 'Open Work Orders',              section: 'workflow',    def: true },
  { key: 'mri_recon',     label: 'MRI Reconciliation',            section: 'workflow',    def: true },

  { key: 'gl_noi',        label: 'Net Operating Income',          section: 'financial',   def: true },
  { key: 'budget_var',    label: 'Budget vs Actual (YTD)',        section: 'financial',   def: true },
  { key: 'opex',          label: 'Operating Expenses',            section: 'financial',   def: true },
  { key: 'dscr',          label: 'Debt Service Coverage',         section: 'financial',   def: true },
  { key: 'top_vendors',   label: 'Top Vendors',                   section: 'financial',   def: true },
  { key: 'investor_returns', label: 'Investor Returns', section: 'financial',  def: true },

  { key: 'ar',            label: 'Accounts Receivable',           section: 'receivables', def: true },
  { key: 'delinquency',   label: 'Delinquency Tracker',           section: 'receivables', def: true },
  { key: 'pct_rent',      label: 'Percentage Rent',               section: 'receivables', def: true },
  { key: 'health_ratio',  label: 'Occupancy Cost (Health Ratio)', section: 'receivables', def: true },

  { key: 'rent_roll',     label: 'Rent Roll',                     section: 'leasing',     def: true },
  { key: 'rollover',      label: 'Lease Rollover',                section: 'leasing',     def: true },
  { key: 'critical_dates',label: 'Critical Dates',                section: 'leasing',     def: true },
  { key: 'svc_renewals',  label: 'Service Agreement Renewals',    section: 'leasing',     def: true },
  { key: 'tenants',       label: 'Tenant Concentration',          section: 'leasing',     def: true },
  { key: 'co_tenancy',    label: 'Co-Tenancy Alerts',             section: 'leasing',     def: false },

  { key: 'doc_corpus',    label: 'Document Corpus',               section: 'reference',   def: true },
]

export const DEFAULT_WIDGET_KEYS = WIDGET_DEFS.filter(w => w.def).map(w => w.key)

export const widgetSectionOf = (key: string) =>
  WIDGET_DEFS.find(w => w.key === key)?.section ?? 'reference'

// Role presets: the default lineup a user opens to before any customization
// and before any admin-assigned template preset. Property managers get an
// operations-first board without the AM-domain analytics (DSCR, % rent,
// health ratio, tenant concentration). AMs/admins get the full default.
export const ROLE_PRESETS: Record<UserRole, string[]> = {
  admin:         DEFAULT_WIDGET_KEYS,
  asset_manager: DEFAULT_WIDGET_KEYS,
  property_manager: [
    'my_tasks', 'work_orders',
    'gl_noi', 'budget_var', 'opex', 'top_vendors',
    'ar', 'delinquency',
    'rent_roll', 'rollover', 'critical_dates', 'svc_renewals',
    'doc_corpus',
  ],
}

export const presetForRole = (role: UserRole | undefined): string[] =>
  (role && ROLE_PRESETS[role]) || DEFAULT_WIDGET_KEYS

// Validate a stored key list (users.dashboard_widgets) against the current
// vocabulary. Returns null when there is nothing usable, so callers can fall
// back to the role preset.
export function sanitizeWidgetKeys(keys: unknown): string[] | null {
  if (!Array.isArray(keys)) return null
  const known = new Set(WIDGET_DEFS.map(w => w.key))
  const valid = keys.filter((k): k is string => typeof k === 'string' && known.has(k))
  return valid.length ? valid : null
}
