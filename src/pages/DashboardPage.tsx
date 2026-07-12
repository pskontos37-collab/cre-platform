import { useState, Component, type ReactNode, type ErrorInfo } from 'react'
import { AppLayout } from '../components/layout/AppLayout'
import { WidgetCategoryProvider } from '../components/ui/Widget'
import { useAuth } from '../contexts/AuthContext'
import type { UserRole } from '../types/database'
import {
  DASHBOARD_SECTIONS as SECTIONS, WIDGET_DEFS, DEFAULT_WIDGET_KEYS as DEFAULT_KEYS,
  widgetSectionOf as sectionOf, presetForRole, sanitizeWidgetKeys,
} from '../lib/dashboardWidgets'
import { useProperties } from '../hooks/useProperties'
import { useFilteredPropertyIds } from '../hooks/useFilteredPropertyIds'

import { GlNoiWidget } from '../components/dashboard/GlNoiWidget'
import { BudgetVarianceWidget } from '../components/dashboard/BudgetVarianceWidget'
import { OpexTrendWidget } from '../components/dashboard/OpexTrendWidget'
import { DSCRWidget } from '../components/dashboard/DSCRWidget'
import { RentRollWidget } from '../components/dashboard/RentRollWidget'
import { RolloverWidget } from '../components/dashboard/RolloverWidget'
import { TopVendorsWidget } from '../components/dashboard/TopVendorsWidget'
import { DocumentCorpusWidget } from '../components/dashboard/DocumentCorpusWidget'
import { TenantConcentrationWidget } from '../components/dashboard/TenantConcentrationWidget'
import { CriticalDatesWidget } from '../components/dashboard/CriticalDatesWidget'
import { PercentageRentWidget } from '../components/dashboard/PercentageRentWidget'
import { HealthRatioWidget } from '../components/dashboard/HealthRatioWidget'
import { ARWidget } from '../components/dashboard/ARWidget'
import { DelinquencyWidget } from '../components/dashboard/DelinquencyWidget'
import { CoTenancyWidget } from '../components/dashboard/CoTenancyWidget'
import { ServiceAgreementsWidget } from '../components/dashboard/ServiceAgreementsWidget'
import { TasksWidget } from '../components/dashboard/TasksWidget'
import { WorkOrdersWidget } from '../components/dashboard/WorkOrdersWidget'
import { MriReconWidget } from '../components/dashboard/MriReconWidget'
import { PortfolioInvestorReturnsWidget } from '../components/PortfolioInvestorReturnsWidget'

interface WidgetProps { propertyIds: string[]; propertyNames: Record<string, string> }

// Renderers for every widget key. Metadata (labels, sections, defaults, role
// presets) lives in lib/dashboardWidgets.ts so the admin panel can build
// template presets without importing the widget components.
const RENDERERS: Record<string, (p: WidgetProps) => ReactNode> = {
  my_tasks:       p => <TasksWidget propertyIds={p.propertyIds} propertyNames={p.propertyNames} />,
  work_orders:    p => <WorkOrdersWidget propertyIds={p.propertyIds} propertyNames={p.propertyNames} />,
  mri_recon:      p => <MriReconWidget propertyIds={p.propertyIds} propertyNames={p.propertyNames} />,

  gl_noi:         p => <GlNoiWidget propertyIds={p.propertyIds} propertyNames={p.propertyNames} />,
  budget_var:     p => <BudgetVarianceWidget propertyIds={p.propertyIds} propertyNames={p.propertyNames} />,
  opex:           p => <OpexTrendWidget propertyIds={p.propertyIds} propertyNames={p.propertyNames} />,
  dscr:           p => <DSCRWidget propertyIds={p.propertyIds} propertyNames={p.propertyNames} />,
  top_vendors:    p => <TopVendorsWidget propertyIds={p.propertyIds} propertyNames={p.propertyNames} />,
  investor_returns: p => <PortfolioInvestorReturnsWidget propertyIds={p.propertyIds} layer={1} />,

  ar:             p => <ARWidget propertyIds={p.propertyIds} propertyNames={p.propertyNames} />,
  delinquency:    p => <DelinquencyWidget propertyIds={p.propertyIds} propertyNames={p.propertyNames} />,
  pct_rent:       p => <PercentageRentWidget propertyIds={p.propertyIds} propertyNames={p.propertyNames} />,
  health_ratio:   p => <HealthRatioWidget propertyIds={p.propertyIds} propertyNames={p.propertyNames} />,

  rent_roll:      p => <RentRollWidget propertyIds={p.propertyIds} propertyNames={p.propertyNames} />,
  rollover:       p => <RolloverWidget propertyIds={p.propertyIds} propertyNames={p.propertyNames} />,
  critical_dates: p => <CriticalDatesWidget propertyIds={p.propertyIds} propertyNames={p.propertyNames} />,
  svc_renewals:   p => <ServiceAgreementsWidget propertyIds={p.propertyIds} propertyNames={p.propertyNames} />,
  tenants:        p => <TenantConcentrationWidget propertyIds={p.propertyIds} />,
  co_tenancy:     p => <CoTenancyWidget propertyIds={p.propertyIds} propertyNames={p.propertyNames} />,

  doc_corpus:     () => <DocumentCorpusWidget />,
}

// Widget registry: metadata + renderer, filtered to keys that have both so a
// stale stored key can never produce an empty card.
const REGISTRY = WIDGET_DEFS
  .filter(d => RENDERERS[d.key])
  .map(d => ({ ...d, render: RENDERERS[d.key] }))

const roleLabel = (role: UserRole | undefined) => role ? role.replace('_', ' ') : 'your role'

const LAYOUT_KEY    = 'cre-dashboard-layout'          // v2: { order, hidden }
const LEGACY_KEY    = 'cre-dashboard-widgets'         // v1: string[] (migrated)
const COLLAPSED_KEY = 'cre-dashboard-sections-collapsed'

interface Layout { order: string[]; hidden: string[] }

// Resolve the visible, ordered widget list from a layout. Any BASELINE widget
// (the user's role preset) not *explicitly* hidden is always surfaced — so
// shipping a new preset widget never leaves it stranded behind a stale saved
// layout (the bug that made Accounts Receivable vanish for users with an older
// layout).
function visibleKeys(layout: Layout, baseline: string[]): string[] {
  const hidden = new Set(layout.hidden)
  const shown = layout.order.filter(k => REGISTRY.some(r => r.key === k) && !hidden.has(k))
  const missing = baseline.filter(k => !layout.order.includes(k) && !hidden.has(k))
  return [...shown, ...missing]
}

// A saved layout only exists once the user customizes; null = "following the
// role preset", which keeps un-customized users on the preset as it evolves.
function loadSaved(): Layout | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (raw) {
      const v = JSON.parse(raw)
      if (v && Array.isArray(v.order) && Array.isArray(v.hidden)) return { order: v.order, hidden: v.hidden }
    }
  } catch { /* fall through */ }
  // Migrate the old flat string[] layout: treat it as the order, nothing hidden
  // (absence from the old list means "didn't exist yet", not "hidden").
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (raw) {
      const v = JSON.parse(raw)
      if (Array.isArray(v) && v.every(x => typeof x === 'string')) {
        const valid = v.filter(k => REGISTRY.some(r => r.key === k))
        if (valid.length) return { order: valid, hidden: [] }
      }
    }
  } catch { /* fall through */ }
  return null
}

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    if (raw) {
      const v = JSON.parse(raw)
      if (v && typeof v === 'object') return v
    }
  } catch { /* fall through */ }
  return {}
}

export default function DashboardPage() {
  const { appUser } = useAuth()
  const { data: properties } = useProperties()
  const propertyIds = useFilteredPropertyIds(properties ?? null)
  const propertyNames = Object.fromEntries((properties ?? []).map(p => [p.id, p.name]))
  const [saved, setSaved] = useState<Layout | null>(loadSaved)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed)
  const [customizing, setCustomizing] = useState(false)

  // Effective layout: the user's saved customization, else their preset.
  // Preset resolution: admin-assigned template preset (users.dashboard_widgets,
  // materialized on template apply) → role preset → full default. Derived at
  // render so it applies once appUser resolves (async).
  const assignedPreset = sanitizeWidgetKeys(appUser?.dashboard_widgets)
  const preset = assignedPreset ?? presetForRole(appUser?.role)
  const presetName = assignedPreset ? 'your assigned profile' : roleLabel(appUser?.role)
  const layout = saved ?? { order: preset, hidden: [] }
  const keys = visibleKeys(layout, preset)

  function save(next: Layout) {
    setSaved(next)
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(next))
  }
  // Reset = drop the customization entirely and follow the role preset again
  // (rather than freezing a copy of today's preset into a saved layout).
  function resetToPreset() {
    setSaved(null)
    localStorage.removeItem(LAYOUT_KEY)
    localStorage.removeItem(LEGACY_KEY)
  }
  function toggleSection(id: string) {
    const next = { ...collapsed, [id]: !collapsed[id] }
    setCollapsed(next)
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next))
  }

  const props: WidgetProps = { propertyIds, propertyNames }

  return (
    <AppLayout>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button
          onClick={() => setCustomizing(c => !c)}
          style={{
            fontSize: 11.5, padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
            border: `1px solid ${customizing ? 'var(--accent)' : 'var(--border-2)'}`,
            background: customizing ? 'var(--accent-dim)' : 'var(--surface-2)',
            color: customizing ? 'var(--accent)' : 'var(--text-muted)',
          }}
        >
          {customizing ? 'Done' : '⚙ Customize widgets'}
        </button>
      </div>

      {customizing && (
        <CustomizePanel
          keys={keys}
          isCustomized={saved !== null}
          role={presetName}
          onHide={k => save({ order: keys.filter(x => x !== k), hidden: [...layout.hidden, k] })}
          onAdd={k => save({ order: [...keys, k], hidden: layout.hidden.filter(h => h !== k) })}
          onMove={(k, dir) => save({ order: moveWithinSection(keys, k, dir), hidden: layout.hidden })}
          onReset={resetToPreset}
        />
      )}

      {SECTIONS.map(sec => {
        const sectionKeys = keys.filter(k => sectionOf(k) === sec.id)
        if (sectionKeys.length === 0) return null
        const isCollapsed = !!collapsed[sec.id]
        return (
          <section key={sec.id} style={{ marginBottom: 22 }}>
            <button
              onClick={() => toggleSection(sec.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px 8px',
                marginBottom: 4, borderBottom: '1px solid var(--border)', textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 10, color: 'var(--text-faint)', width: 12, transition: 'transform .15s',
                transform: isCollapsed ? 'rotate(-90deg)' : 'none' }}>▾</span>
              <span style={{ fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
                {sec.label}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-faint)', background: 'var(--surface-2)', padding: '1px 7px', borderRadius: 99 }}>
                {sectionKeys.length}
              </span>
            </button>

            {!isCollapsed && (
              <div style={{
                display:             'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
                gap:                 16,
                alignItems:          'stretch',   // every card in a row is equal height → symmetric grid
              }}>
                {sectionKeys.map(k => {
                  const w = REGISTRY.find(r => r.key === k)
                  if (!w) return null
                  return (
                    <div key={k}>
                      <WidgetCategoryProvider value={sec.id}>
                        <WidgetBoundary label={w.label}>{w.render(props)}</WidgetBoundary>
                      </WidgetCategoryProvider>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )
      })}
    </AppLayout>
  )
}

// Swap a widget with its nearest neighbour *in the same section* so reordering
// stays within the band the widget renders in.
function moveWithinSection(keys: string[], key: string, dir: -1 | 1): string[] {
  const i = keys.indexOf(key)
  if (i < 0) return keys
  const sec = sectionOf(key)
  let j = i + dir
  while (j >= 0 && j < keys.length && sectionOf(keys[j]) !== sec) j += dir
  if (j < 0 || j >= keys.length) return keys
  const next = [...keys]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

// Isolates a single widget's render errors so one bad widget can't blank the
// whole dashboard. Shows which widget failed and why, instead of a black page.
class WidgetBoundary extends Component<{ label: string; children: ReactNode }, { err: Error | null }> {
  state: { err: Error | null } = { err: null }
  static getDerivedStateFromError(err: Error) { return { err } }
  componentDidCatch(err: Error, info: ErrorInfo) { console.error(`Widget "${this.props.label}" crashed:`, err, info) }
  render() {
    if (this.state.err) {
      return (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--red-border)', borderRadius: 16, padding: '13px 16px' }}>
          <div style={{ fontSize: 10.5, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--red)', marginBottom: 6 }}>
            {this.props.label} — failed to load
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5, wordBreak: 'break-word' }}>
            {this.state.err.message}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// Show/hide + reorder, grouped by section. Saved to this browser (per user);
// DB-backed prefs can come later if the team wants roaming settings.
function CustomizePanel({ keys, isCustomized, role, onHide, onAdd, onMove, onReset }: {
  keys: string[]
  isCustomized: boolean
  role: string
  onHide: (key: string) => void
  onAdd: (key: string) => void
  onMove: (key: string, dir: -1 | 1) => void
  onReset: () => void
}) {
  const hidden = REGISTRY.filter(r => !keys.includes(r.key))

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
      padding: 14, marginBottom: 16,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)' }}>
          Dashboard widgets — grouped by section
        </span>
        {isCustomized && (
          <button onClick={onReset} style={{ fontSize: 10.5, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
            Reset to {role} default
          </button>
        )}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginBottom: 10 }}>
        {isCustomized
          ? 'Customized layout — saved to this browser.'
          : `Following the default layout for ${role}. Changes here create your own copy.`}
      </div>

      {SECTIONS.map(sec => {
        const sectionKeys = keys.filter(k => sectionOf(k) === sec.id)
        if (sectionKeys.length === 0) return null
        return (
          <div key={sec.id} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-faint)', margin: '2px 0 4px' }}>
              {sec.label}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {sectionKeys.map((k, i) => {
                const w = REGISTRY.find(r => r.key === k)
                if (!w) return null
                return (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', background: 'var(--surface-2)', borderRadius: 6 }}>
                    <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text)' }}>{w.label}</span>
                    <MiniBtn label="↑" disabled={i === 0} onClick={() => onMove(k, -1)} />
                    <MiniBtn label="↓" disabled={i === sectionKeys.length - 1} onClick={() => onMove(k, 1)} />
                    <MiniBtn label="Hide" onClick={() => onHide(k)} />
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {hidden.length > 0 && (
        <>
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', margin: '10px 0 4px' }}>Available to add:</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {hidden.map(w => (
              <button key={w.key} onClick={() => onAdd(w.key)}
                style={{ fontSize: 11.5, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                  border: '1px dashed var(--border-2)', background: 'transparent', color: 'var(--text-muted)' }}>
                + {w.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function MiniBtn({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        fontSize: 10.5, padding: '2px 8px', borderRadius: 5, cursor: disabled ? 'default' : 'pointer',
        border: '1px solid var(--border-2)', background: 'var(--surface)',
        color: disabled ? 'var(--text-faint)' : 'var(--text-muted)', opacity: disabled ? 0.5 : 1,
      }}>
      {label}
    </button>
  )
}
