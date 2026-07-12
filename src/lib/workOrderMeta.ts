// Shared work-order vocabulary — categories, priorities and statuses with the
// labels/colors both the tenant portal (/portal) and the staff page
// (/workorders) render. Values mirror the check constraints in migration
// 20240077_work_orders.sql.

export interface WoOption { value: string; label: string; icon?: string }

export const WO_CATEGORIES: WoOption[] = [
  { value: 'hvac',         label: 'HVAC / Heating & Cooling', icon: '❄️' },
  { value: 'plumbing',     label: 'Plumbing',                 icon: '🚰' },
  { value: 'electrical',   label: 'Electrical',               icon: '⚡' },
  { value: 'roof_leak',    label: 'Roof / Leak',              icon: '☔' },
  { value: 'doors_locks',  label: 'Doors & Locks',            icon: '🔑' },
  { value: 'lighting',     label: 'Lighting',                 icon: '💡' },
  { value: 'janitorial',   label: 'Janitorial / Cleaning',    icon: '🧹' },
  { value: 'pest_control', label: 'Pest Control',             icon: '🐜' },
  { value: 'landscaping',  label: 'Landscaping',              icon: '🌳' },
  { value: 'parking_lot',  label: 'Parking Lot',              icon: '🅿️' },
  { value: 'signage',      label: 'Signage',                  icon: '🪧' },
  { value: 'safety',       label: 'Safety Hazard',            icon: '⚠️' },
  { value: 'other',        label: 'Other',                    icon: '🔧' },
]

export const WO_PRIORITIES: WoOption[] = [
  { value: 'low',       label: 'Low' },
  { value: 'normal',    label: 'Normal' },
  { value: 'high',      label: 'High' },
  { value: 'emergency', label: 'Emergency' },
]

// Tenant-facing status labels are friendlier than the internal ones.
export const WO_STATUSES: { value: string; label: string; tenantLabel: string; color: string }[] = [
  { value: 'new',          label: 'New',         tenantLabel: 'Submitted',   color: 'var(--accent)' },
  { value: 'acknowledged', label: 'Acknowledged',tenantLabel: 'Received',    color: 'var(--blue, #4a7fb5)' },
  { value: 'in_progress',  label: 'In Progress', tenantLabel: 'In progress', color: 'var(--amber, #b98a2f)' },
  { value: 'on_hold',      label: 'On Hold',     tenantLabel: 'On hold',     color: 'var(--text-faint)' },
  { value: 'completed',    label: 'Completed',   tenantLabel: 'Completed',   color: 'var(--green, #3f8f5f)' },
  { value: 'cancelled',    label: 'Cancelled',   tenantLabel: 'Cancelled',   color: 'var(--text-faint)' },
]

export const OPEN_STATUSES = ['new', 'acknowledged', 'in_progress', 'on_hold']

export const categoryLabel = (v: string) => WO_CATEGORIES.find(c => c.value === v)?.label ?? v
export const categoryIcon = (v: string) => WO_CATEGORIES.find(c => c.value === v)?.icon ?? '🔧'
export const statusMeta = (v: string) => WO_STATUSES.find(s => s.value === v) ?? WO_STATUSES[0]

export const priorityColor = (p: string) =>
  p === 'emergency' ? 'var(--red, #b5484a)'
  : p === 'high'    ? 'var(--amber, #b98a2f)'
  : p === 'low'     ? 'var(--text-faint)'
  : 'var(--text-muted)'

export const woNumber = (n: number) => `WO-${String(n).padStart(6, '0')}`

// Work-order category → lease_rm_matrix systems (migration 20240084), most
// specific first. The /workorders panel walks this list and shows the first
// system the tenant's lease matrix actually covers; 'general' is the blanket
// repairs clause fallback.
export const CATEGORY_RM_SYSTEMS: Record<string, string[]> = {
  hvac:         ['hvac', 'general'],
  plumbing:     ['plumbing', 'utilities', 'general'],
  electrical:   ['electrical', 'utilities', 'general'],
  lighting:     ['electrical', 'general'],
  roof_leak:    ['roof', 'structure', 'general'],
  doors_locks:  ['storefront_doors_glass', 'interior', 'general'],
  janitorial:   ['interior', 'general'],
  pest_control: ['pest_control', 'general'],
  landscaping:  ['landscaping', 'common_areas', 'general'],
  parking_lot:  ['parking_lot', 'common_areas', 'general'],
  signage:      ['signage', 'storefront_doors_glass', 'general'],
  safety:       ['fire_life_safety', 'general'],
  other:        ['general'],
}

export const RM_SYSTEM_LABELS: Record<string, string> = {
  hvac: 'HVAC', plumbing: 'Plumbing', electrical: 'Electrical', roof: 'Roof',
  structure: 'Structure', storefront_doors_glass: 'Storefront / Doors / Glass',
  interior: 'Interior', common_areas: 'Common Areas', parking_lot: 'Parking Lot',
  signage: 'Signage', pest_control: 'Pest Control', landscaping: 'Landscaping',
  fire_life_safety: 'Fire / Life Safety', utilities: 'Utilities', general: 'Repairs (general)',
}
