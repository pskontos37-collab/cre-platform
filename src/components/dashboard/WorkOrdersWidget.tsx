import { useState } from 'react'
import { Widget, WidgetSkeleton, ExpandToggle } from '../ui/Widget'
import { EmptyState } from '../ui/EmptyState'
import { useWorkOrders, type WorkOrder } from '../../hooks/useWorkOrders'
import { OPEN_STATUSES, categoryIcon, statusMeta, priorityColor, woNumber } from '../../lib/workOrderMeta'

// "Open Work Orders" — the dashboard cut of /workorders, sitting next to
// My Tasks: every still-open tenant/staff maintenance request in the current
// View: scope, emergencies first. Triage happens on /workorders.

interface WorkOrdersWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
}

const COLLAPSED = 5
const PRI_RANK: Record<string, number> = { emergency: 0, high: 1, normal: 2, low: 3 }

const daysOpen = (o: WorkOrder) =>
  Math.max(0, Math.round((Date.now() - new Date(o.createdAt).getTime()) / 86400000))

export function WorkOrdersWidget({ propertyIds, propertyNames }: WorkOrdersWidgetProps) {
  const { data, loading, error } = useWorkOrders(propertyIds, propertyNames)
  const [expanded, setExpanded] = useState(false)

  const open = (data ?? [])
    .filter(o => OPEN_STATUSES.includes(o.status))
    .sort((a, b) => {
      const p = (PRI_RANK[a.priority] ?? 9) - (PRI_RANK[b.priority] ?? 9)
      if (p !== 0) return p
      return b.createdAt.localeCompare(a.createdAt)
    })

  const emergencies = open.filter(o => o.priority === 'emergency').length
  const unrouted = open.filter(o => !o.assignedVendor).length
  const visible = expanded ? open : open.slice(0, COLLAPSED)

  return (
    <Widget title="Open Work Orders" href="/workorders" hrefLabel="All work orders →">
      {loading && <WidgetSkeleton rows={3} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && open.length === 0 && (
        <EmptyState icon="🛠" title="No open work orders" subtitle="Tenant requests from the portal land here" />
      )}

      {!loading && !error && open.length > 0 && (
        <>
          {/* stat rail */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            <Stat label="open" value={open.length} />
            {emergencies > 0 && <Stat label="emergency" value={emergencies} color="var(--red)" />}
            {unrouted > 0 && <Stat label="not routed" value={unrouted} color="var(--amber)" />}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {visible.map(o => {
              const meta = statusMeta(o.status)
              return (
                <div key={o.id} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 9,
                  padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 7,
                  border: `1px solid ${o.priority === 'emergency' ? 'var(--red-border, var(--red))' : 'var(--border-2)'}`,
                }}>
                  <span style={{ fontSize: 15, lineHeight: '18px' }}>{categoryIcon(o.category)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 500, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {o.title}
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 3, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                      <span>{woNumber(o.woNumber)}</span>
                      <span>{o.tenantName}</span>
                      <span>{o.propertyName}</span>
                      {o.locationType === 'common_area' && <span style={{ color: 'var(--accent)', fontWeight: 700 }}>common area</span>}
                      {o.priority !== 'normal' && (
                        <span style={{ color: priorityColor(o.priority), fontWeight: 700, textTransform: 'capitalize' }}>{o.priority}</span>
                      )}
                      <span>{daysOpen(o)}d</span>
                      {o.assignedVendor && <span>→ {o.assignedVendor}</span>}
                    </div>
                  </div>
                  <span style={{
                    fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', flexShrink: 0,
                    color: meta.color, border: `1px solid ${meta.color}`, borderRadius: 999, padding: '1px 7px', marginTop: 1,
                  }}>
                    {meta.label}
                  </span>
                </div>
              )
            })}
            <ExpandToggle
              expanded={expanded}
              onToggle={() => setExpanded(e => !e)}
              collapsedCount={COLLAPSED}
              totalCount={open.length}
            />
          </div>
        </>
      )}
    </Widget>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'baseline', gap: 5,
      padding: '3px 9px', borderRadius: 999, background: 'var(--surface-2)',
      border: '1px solid var(--border-2)',
    }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: color ?? 'var(--text)' }}>{value}</span>
      <span style={{ fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-faint)' }}>{label}</span>
    </span>
  )
}
