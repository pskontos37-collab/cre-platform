import { ReactNode, useEffect, useState, createContext, useContext } from 'react'
import { Link } from 'react-router-dom'

// The dashboard groups widgets into sections; each section gets a category
// accent color that shows as a 3px rail across the top of every card in it.
// DashboardPage supplies the section id via context so no individual widget
// needs to know (or pass) its own category — the shell reads it here.
const CATEGORY_COLOR: Record<string, string> = {
  workflow:    'var(--green)',
  financial:   'var(--accent)',
  receivables: 'var(--amber)',
  leasing:     'var(--green)',
  reference:   'var(--text-faint)',
}
const WidgetCategoryContext = createContext<string | null>(null)
export function WidgetCategoryProvider({ value, children }: { value: string; children: ReactNode }) {
  return <WidgetCategoryContext.Provider value={value}>{children}</WidgetCategoryContext.Provider>
}

interface WidgetProps {
  title: string
  chip?: ReactNode                 // string or a control (e.g. a horizon <select>)
  href?: string                    // drill-through: renders a "Details →" link in the header
  hrefLabel?: string
  children: ReactNode
  fullWidth?: boolean
  minHeight?: number
}

export function Widget({ title, chip, href, hrefLabel, children, fullWidth, minHeight }: WidgetProps) {
  const category = useContext(WidgetCategoryContext)
  const rail = category ? (CATEGORY_COLOR[category] ?? null) : null
  return (
    <div
      className="cre-widget"
      style={{
        background:    'var(--surface)',
        border:        '1px solid var(--border)',
        borderRadius:  16,
        overflow:      'hidden',
        gridColumn:    fullWidth ? '1 / -1' : undefined,
        minHeight,
        // Flex column + height:100% keeps cards in a row equal height (symmetric
        // dashboard) and lets footers settle to the bottom. Resolves to a normal
        // block outside a stretched grid/flex container, so it's a safe no-op.
        height:        '100%',
        display:       'flex',
        flexDirection: 'column',
        boxShadow:     'var(--shadow, none)',
      }}
    >
      {/* Category accent rail — keys the card to its dashboard section. */}
      {rail && <div style={{ height: 3, background: rail, flex: 'none' }} />}
      <div
        style={{
          padding:       '10px 15px',
          borderBottom:  '1px solid var(--border)',
          display:       'flex',
          alignItems:    'center',
          // Let the header wrap when a narrow card can't fit the title alongside
          // wide chip controls: the title keeps its own line at full width and
          // the controls drop beneath it, rather than the title being crushed to
          // an ellipsis (which happened on narrow cards, e.g. sidebar collapsed →
          // grid fits an extra column → cards shrink toward the 340px minimum).
          flexWrap:      'wrap',
          columnGap:     8,
          rowGap:        6,
          flex:          'none',
        }}
      >
        <span
          style={{
            fontSize:      11,
            fontWeight:    700,
            letterSpacing: '0.01em',
            color:         'var(--text)',
            // Never let the title wrap onto a second line and reflow the header —
            // when the chip slot is wide, truncate the title instead.
            whiteSpace:    'nowrap',
            overflow:      'hidden',
            textOverflow:  'ellipsis',
            minWidth:      0,
          }}
          title={title}
        >
          {title}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none', marginLeft: 'auto' }}>
          {chip != null && (
            typeof chip === 'string' ? (
              <span
                style={{
                  fontSize:     10,
                  color:        'var(--text-faint)',
                  background:   'var(--surface-2)',
                  padding:      '2px 8px',
                  borderRadius: 99,
                }}
              >
                {chip}
              </span>
            ) : chip
          )}
          {href && (
            <Link
              to={href}
              style={{
                fontSize:       10.5,
                fontWeight:     600,
                color:          'var(--accent)',
                textDecoration: 'none',
                whiteSpace:     'nowrap',
              }}
            >
              {hrefLabel ?? 'Details →'}
            </Link>
          )}
        </span>
      </div>
      <div style={{ padding: '12px 15px', flex: 1 }}>{children}</div>
    </div>
  )
}

export function WidgetSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 14,
            background: 'var(--surface-2)',
            borderRadius: 4,
            width: `${70 + (i % 3) * 10}%`,
            opacity: 0.6,
          }}
        />
      ))}
    </div>
  )
}

// Per-widget property narrower for the dashboard. `scopeIds` = the property set
// coming from the global "View:" filter; this lets the user narrow a SINGLE
// widget down to one of those properties without changing the whole dashboard.
// Returns the effective id list to query with (all of scope, or the one picked).
// The selection auto-resets to "all" if the picked property leaves global scope.
export function usePropertyChip(scopeIds: string[]) {
  const [sel, setSel] = useState('all')
  const key = scopeIds.join(',')
  useEffect(() => {
    if (sel !== 'all' && !scopeIds.includes(sel)) setSel('all')
  }, [key, sel])
  const effectiveIds = sel !== 'all' && scopeIds.includes(sel) ? [sel] : scopeIds
  return { sel, setSel, effectiveIds }
}

// The chip-slot control paired with usePropertyChip. Renders nothing when there
// is 0–1 property in scope (a filter would be pointless); callers fall back to
// their descriptive chip in that case.
export function WidgetPropertyChip({ scopeIds, propertyNames, value, onChange }: {
  scopeIds: string[]
  propertyNames: Record<string, string>
  value: string
  onChange: (v: string) => void
}) {
  if (scopeIds.length <= 1) return null
  const options = [
    { value: 'all', label: `All ${scopeIds.length} properties` },
    ...scopeIds
      .map(id => ({ value: id, label: propertyNames[id] ?? id }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ]
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      title="Filter this widget by property"
      style={{
        fontSize: 10, color: 'var(--text-muted)', background: 'var(--surface-2)',
        border: '1px solid var(--border-2)', padding: '2px 6px', borderRadius: 99,
        cursor: 'pointer', outline: 'none', maxWidth: 150,
      }}
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

// A "show all / show less" toggle for widgets whose list would otherwise run
// long and break the dashboard's vertical rhythm. Renders nothing when the full
// list already fits within `collapsedCount`. Pair with a slice() on the rows.
export function ExpandToggle({ expanded, onToggle, collapsedCount, totalCount }: {
  expanded: boolean
  onToggle: () => void
  collapsedCount: number
  totalCount: number
}) {
  if (totalCount <= collapsedCount) return null
  const hidden = totalCount - collapsedCount
  return (
    <button
      onClick={onToggle}
      style={{
        marginTop:    10,
        width:        '100%',
        fontSize:     11,
        fontWeight:   600,
        color:        'var(--accent)',
        background:   'var(--surface-2)',
        border:       '1px solid var(--border-2)',
        borderRadius: 7,
        padding:      '6px 0',
        cursor:       'pointer',
        outline:      'none',
      }}
    >
      {expanded ? 'Show less ▴' : `Show ${hidden} more ▾`}
    </button>
  )
}

// Small pill-styled <select> that fits the widget chip slot.
export function ChipSelect({ value, onChange, options }: {
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        fontSize:     10,
        color:        'var(--text-muted)',
        background:   'var(--surface-2)',
        border:       '1px solid var(--border-2)',
        padding:      '2px 6px',
        borderRadius: 99,
        cursor:       'pointer',
        outline:      'none',
      }}
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}
