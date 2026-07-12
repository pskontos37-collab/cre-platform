import { useState } from 'react'
import { Widget, WidgetSkeleton, ExpandToggle } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { useAuth } from '../../contexts/AuthContext'
import {
  useTasks, useAssignableUsers, createTask, updateTask,
  indexUsers, userLabel, isOverdue,
  type Task, type TaskPriority,
} from '../../hooks/useTasks'

// "My Tasks" — the dashboard cut: open work that is mine (assigned to me, or
// created by me and unassigned). Quick-add + check-off inline; the full board,
// assigning, and editing live on /tasks.

interface TasksWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
}

const COLLAPSED = 5
const todayIso = () => new Date().toISOString().slice(0, 10)

const PRIORITY_BADGE: Record<TaskPriority, 'red' | 'gray' | null> = {
  high: 'red', normal: null, low: 'gray',
}

export function TasksWidget({ propertyIds, propertyNames }: TasksWidgetProps) {
  const { appUser } = useAuth()
  const uid = appUser?.id ?? ''
  const { data, loading, error, refetch } = useTasks()
  const { data: roster } = useAssignableUsers()
  const users = indexUsers(roster ?? [])

  const [expanded, setExpanded] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const today = todayIso()
  const scope = new Set(propertyIds)

  // Mine = assigned to me, or created by me and not assigned to anyone else.
  // Still-open only, and (if tagged to a property) within the global View: scope.
  const mine = (data ?? [])
    .filter(t => t.status !== 'done')
    .filter(t => t.assignedTo === uid || (t.createdBy === uid && !t.assignedTo))
    .filter(t => !t.propertyId || scope.has(t.propertyId))
    .sort(sortTasks(today))

  const visible = expanded ? mine : mine.slice(0, COLLAPSED)

  async function add() {
    const t = title.trim()
    if (!t || !uid) return
    setBusy('add'); setActionError(null)
    try {
      await createTask({ title: t }, uid)
      setTitle('')
      refetch()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not add task')
    } finally { setBusy(null) }
  }

  async function complete(t: Task) {
    setBusy(t.id); setActionError(null)
    try {
      await updateTask(t.id, { status: 'done' })
      refetch()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not update task')
    } finally { setBusy(null) }
  }

  return (
    <Widget title="My Tasks" href="/tasks" hrefLabel="All tasks →">
      {/* Quick add */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void add() }}
          placeholder="Add a to-do…"
          disabled={busy === 'add' || !uid}
          style={{
            flex: 1, fontSize: 12, padding: '6px 9px', borderRadius: 7,
            border: '1px solid var(--border-2)', background: 'var(--surface-2)',
            color: 'var(--text)', outline: 'none',
          }}
        />
        <button
          onClick={() => void add()}
          disabled={!title.trim() || busy === 'add' || !uid}
          style={{
            fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 7, cursor: 'pointer',
            border: '1px solid var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)',
            opacity: !title.trim() ? 0.5 : 1,
          }}
        >
          Add
        </button>
      </div>

      {actionError && <div style={{ fontSize: 11, color: 'var(--red)', marginBottom: 6 }}>{actionError}</div>}
      {loading && <WidgetSkeleton rows={3} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && mine.length === 0 && (
        <EmptyState icon="✅" title="All clear" subtitle="No open tasks assigned to you" />
      )}

      {!loading && !error && mine.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {visible.map(t => {
            const overdue = isOverdue(t, today)
            const pri = PRIORITY_BADGE[t.priority]
            return (
              <div
                key={t.id}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 9,
                  padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 7,
                  border: `1px solid ${overdue ? 'var(--red-border)' : 'var(--border-2)'}`,
                  opacity: busy === t.id ? 0.5 : 1,
                }}
              >
                <button
                  onClick={() => void complete(t)}
                  disabled={busy === t.id}
                  title="Mark done"
                  style={{
                    marginTop: 1, width: 16, height: 16, flexShrink: 0, borderRadius: 4,
                    border: '1.5px solid var(--border-2)', background: 'var(--surface)',
                    cursor: 'pointer', color: 'var(--accent)', fontSize: 11, lineHeight: '13px', padding: 0,
                  }}
                >
                  {' '}
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 500, lineHeight: 1.4, wordBreak: 'break-word' }}>
                    {t.title}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 3, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    {t.propertyId && <span>{propertyNames[t.propertyId] ?? '—'}</span>}
                    {t.dueDate && (
                      <span style={{ color: overdue ? 'var(--red)' : 'var(--text-faint)' }}>
                        {overdue ? 'overdue ' : 'due '}{fmtDate(t.dueDate)}
                      </span>
                    )}
                    {t.createdBy !== uid && <span>from {userLabel(t.createdBy, users)}</span>}
                  </div>
                </div>
                {pri && <Badge variant={pri}>{t.priority}</Badge>}
              </div>
            )
          })}
          <ExpandToggle
            expanded={expanded}
            onToggle={() => setExpanded(e => !e)}
            collapsedCount={COLLAPSED}
            totalCount={mine.length}
          />
        </div>
      )}
    </Widget>
  )
}

// Overdue first, then by priority (high→low), then soonest due date.
const PRI_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 }
function sortTasks(today: string) {
  return (a: Task, b: Task) => {
    const ao = isOverdue(a, today) ? 0 : 1
    const bo = isOverdue(b, today) ? 0 : 1
    if (ao !== bo) return ao - bo
    if (PRI_RANK[a.priority] !== PRI_RANK[b.priority]) return PRI_RANK[a.priority] - PRI_RANK[b.priority]
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate)
    if (a.dueDate) return -1
    if (b.dueDate) return 1
    return b.createdAt.localeCompare(a.createdAt)
  }
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
