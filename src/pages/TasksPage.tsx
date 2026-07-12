import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useProperties } from '../hooks/useProperties'
import { useFilteredPropertyIds, usePropertyNameMap } from '../hooks/useFilteredPropertyIds'
import {
  useTasks, useAssignableUsers, createTask, updateTask, deleteTask,
  markAssignedSeen, useChecklists, addChecklistItem, toggleChecklistItem, deleteChecklistItem,
  createMoveEventTask, usePropertyLeases, MOVE_SOURCE_LABEL,
  indexUsers, userLabel, isOverdue,
  STATUS_LABEL, PRIORITY_LABEL,
  type Task, type TaskStatus, type TaskPriority, type UserMap, type ChecklistItem, type MoveKind,
} from '../hooks/useTasks'
import { WidgetSkeleton } from '../components/ui/Widget'
import { Badge } from '../components/ui/Badge'
import { EmptyState } from '../components/ui/EmptyState'

// ── M&J Wilkow corporate palette (wilkow.com) — matches Receivables/Services ─
const WILKOW = '#466371'
const SERIF  = "'Frank Ruhl Libre', 'Cinzel', Georgia, serif"

const todayIso = () => new Date().toISOString().slice(0, 10)

const fmtDate = (iso: string | null) => {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const STATUSES: TaskStatus[]   = ['open', 'in_progress', 'done']
const PRIORITIES: TaskPriority[] = ['high', 'normal', 'low']

type WhoTab = 'all' | 'assigned' | 'created'
const WHO_TABS: Array<{ key: WhoTab; label: string }> = [
  { key: 'all',      label: 'All' },
  { key: 'assigned', label: 'Assigned to me' },
  { key: 'created',  label: 'Created by me' },
]

const PRI_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 }
const STATUS_RANK: Record<TaskStatus, number> = { open: 0, in_progress: 1, done: 2 }

const controlStyle: CSSProperties = {
  fontSize: 12, padding: '6px 9px', borderRadius: 7,
  border: '1px solid var(--border-2)', background: 'var(--surface-2)',
  color: 'var(--text)', outline: 'none',
}

export function TasksPage() {
  const { appUser } = useAuth()
  const uid = appUser?.id ?? ''

  const { data: properties } = useProperties()
  const scopeIds = useFilteredPropertyIds(properties ?? null)
  const propertyNames = usePropertyNameMap(properties ?? null)

  const { data, loading, error, refetch } = useTasks()
  const { data: roster } = useAssignableUsers()
  const { data: checklists, refetch: refetchChecklists } = useChecklists()
  const users = indexUsers(roster ?? [])

  // Acknowledge tasks assigned to me the first time the board loads — clears the
  // sidebar "assigned to you" badge. Rows still render their "New" tag this
  // visit (local data reflects the pre-seen state).
  const markedRef = useRef(false)
  useEffect(() => {
    if (uid && data && !markedRef.current) {
      markedRef.current = true
      void markAssignedSeen(uid)
    }
  }, [uid, data])

  const [who, setWho]         = useState<WhoTab>('all')
  const [showDone, setShowDone] = useState(false)
  const [search, setSearch]   = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy]       = useState<string | null>(null)

  const today = todayIso()
  const scope = useMemo(() => new Set(scopeIds), [scopeIds.join(',')])

  const tasks = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (data ?? [])
      .filter(t => who === 'all' || (who === 'assigned' ? t.assignedTo === uid : t.createdBy === uid))
      .filter(t => showDone || t.status !== 'done')
      // Property-scoped tasks respect the global View: filter; untagged always show.
      .filter(t => !t.propertyId || scope.has(t.propertyId))
      .filter(t => !q || t.title.toLowerCase().includes(q) || (t.details ?? '').toLowerCase().includes(q))
      .sort((a, b) => {
        const ao = isOverdue(a, today) ? 0 : 1, bo = isOverdue(b, today) ? 0 : 1
        if (a.status !== b.status) return STATUS_RANK[a.status] - STATUS_RANK[b.status]
        if (ao !== bo) return ao - bo
        if (PRI_RANK[a.priority] !== PRI_RANK[b.priority]) return PRI_RANK[a.priority] - PRI_RANK[b.priority]
        if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate)
        if (a.dueDate) return -1
        if (b.dueDate) return 1
        return b.createdAt.localeCompare(a.createdAt)
      })
  }, [data, who, showDone, search, scope, uid, today])

  const openCount = (data ?? []).filter(t => t.status !== 'done' && (t.assignedTo === uid || (t.createdBy === uid && !t.assignedTo))).length

  async function mutate(fn: () => Promise<void>) {
    setActionError(null)
    try { await fn(); refetch() }
    catch (e) { setActionError(e instanceof Error ? e.message : 'Action failed') }
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: WILKOW, marginBottom: 5 }}>
          Asset Management
        </div>
        <h1 style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 500, color: 'var(--text)', margin: 0, lineHeight: 1.1 }}>
          Tasks
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '6px 0 0' }}>
          To-dos and follow-ups — assign work to the team, tag it to a property, track it to done.
          {openCount > 0 && <> You have <strong style={{ color: 'var(--text)' }}>{openCount}</strong> open.</>}
        </p>
      </div>

      <TaskComposer
        uid={uid} roster={roster ?? []} properties={(properties ?? []).map(p => ({ id: p.id, name: p.name }))}
        onCreate={t => mutate(() => createTask(t, uid))}
      />

      <div style={{ marginTop: 8 }}>
        <MoveEventComposer
          roster={roster ?? []} properties={(properties ?? []).map(p => ({ id: p.id, name: p.name }))}
          onCreate={async input => {
            await mutate(() => createMoveEventTask(input))
            refetchChecklists()
          }}
        />
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', margin: '16px 0 10px' }}>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', borderRadius: 8, padding: 3 }}>
          {WHO_TABS.map(tab => (
            <button key={tab.key} onClick={() => setWho(tab.key)}
              style={{
                fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: 'none',
                background: who === tab.key ? 'var(--surface)' : 'transparent',
                color: who === tab.key ? 'var(--accent)' : 'var(--text-muted)',
                boxShadow: who === tab.key ? 'var(--shadow, none)' : 'none',
              }}>
              {tab.label}
            </button>
          ))}
        </div>
        <input
          value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tasks…"
          style={{ ...controlStyle, flex: 1, minWidth: 160 }}
        />
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} />
          Show completed
        </label>
      </div>

      {actionError && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{actionError}</div>}

      {loading && <WidgetSkeleton rows={6} />}
      {error && <div style={{ fontSize: 13, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && tasks.length === 0 && (
        <EmptyState icon="🗒" title="No tasks" subtitle="Add one above to get started." />
      )}

      {!loading && !error && tasks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tasks.map(t => (
            <TaskRow
              key={t.id} task={t} uid={uid} role={appUser?.role} users={users} today={today}
              roster={roster ?? []} propertyNames={propertyNames}
              properties={(properties ?? []).map(p => ({ id: p.id, name: p.name }))}
              checklist={checklists?.[t.id] ?? []}
              onChecklistChange={refetchChecklists}
              busy={busy === t.id}
              onPatch={patch => { setBusy(t.id); mutate(() => updateTask(t.id, patch)).finally(() => setBusy(null)) }}
              onDelete={() => { setBusy(t.id); mutate(() => deleteTask(t.id)).finally(() => setBusy(null)) }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Composer ─────────────────────────────────────────────────────────────────
function TaskComposer({ uid, roster, properties, onCreate }: {
  uid: string
  roster: Array<{ id: string; fullName: string | null; email: string }>
  properties: Array<{ id: string; name: string }>
  onCreate: (t: { title: string; details?: string | null; priority: TaskPriority; dueDate: string | null; propertyId: string | null; assignedTo: string | null }) => void
}) {
  const [open, setOpen]         = useState(false)
  const [title, setTitle]       = useState('')
  const [details, setDetails]   = useState('')
  const [assignee, setAssignee] = useState('')
  const [property, setProperty] = useState('')
  const [due, setDue]           = useState('')
  const [priority, setPriority] = useState<TaskPriority>('normal')

  function submit() {
    if (!title.trim() || !uid) return
    onCreate({ title, details: details || null, priority, dueDate: due || null, propertyId: property || null, assignedTo: assignee || null })
    setTitle(''); setDetails(''); setAssignee(''); setProperty(''); setDue(''); setPriority('normal'); setOpen(false)
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        style={{
          width: '100%', textAlign: 'left', fontSize: 13, color: 'var(--text-muted)', cursor: 'text',
          padding: '11px 14px', borderRadius: 10, border: '1px dashed var(--border-2)', background: 'var(--surface)',
        }}>
        + Add a task…
      </button>
    )
  }

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 14 }}>
      <input
        autoFocus value={title} onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }}
        placeholder="What needs doing?"
        style={{ ...controlStyle, width: '100%', fontSize: 14, marginBottom: 8 }}
      />
      <textarea
        value={details} onChange={e => setDetails(e.target.value)} placeholder="Details (optional)" rows={2}
        style={{ ...controlStyle, width: '100%', resize: 'vertical', marginBottom: 8 }}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <select value={assignee} onChange={e => setAssignee(e.target.value)} style={controlStyle} title="Assign to">
          <option value="">Unassigned</option>
          {roster.map(u => <option key={u.id} value={u.id}>{u.fullName || u.email}{u.id === uid ? ' (me)' : ''}</option>)}
        </select>
        <select value={property} onChange={e => setProperty(e.target.value)} style={controlStyle} title="Property">
          <option value="">No property</option>
          {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={priority} onChange={e => setPriority(e.target.value as TaskPriority)} style={controlStyle} title="Priority">
          {PRIORITIES.map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]} priority</option>)}
        </select>
        <input type="date" value={due} onChange={e => setDue(e.target.value)} style={controlStyle} title="Due date" />
        <div style={{ flex: 1 }} />
        <button onClick={() => setOpen(false)} style={{ ...btn('ghost') }}>Cancel</button>
        <button onClick={submit} disabled={!title.trim()} style={{ ...btn('primary'), opacity: title.trim() ? 1 : 0.5 }}>Add task</button>
      </div>
    </div>
  )
}

// ── Move-in / move-out composer (Policy Manual 16.5) ─────────────────────────
// Logs a tenant move event: the server RPC creates the task with the full Move
// In/Move Out form checklist and assigns it to the property's PM unless an
// assignee is chosen here. Deduped per (lease, kind), so logging an event the
// leases trigger already caught is harmless.
function MoveEventComposer({ roster, properties, onCreate }: {
  roster: Array<{ id: string; fullName: string | null; email: string }>
  properties: Array<{ id: string; name: string }>
  onCreate: (input: { kind: MoveKind; propertyId: string; leaseId: string | null; eventDate: string | null; assignedTo: string | null }) => Promise<void>
}) {
  const [open, setOpen]         = useState(false)
  const [kind, setKind]         = useState<MoveKind>('move_in')
  const [property, setProperty] = useState('')
  const [lease, setLease]       = useState('')
  const [date, setDate]         = useState(todayIso())
  const [assignee, setAssignee] = useState('')
  const [busy, setBusy]         = useState(false)

  const { data: leases, loading: leasesLoading } = usePropertyLeases(open && property ? property : null)

  async function submit() {
    if (!property || busy) return
    setBusy(true)
    try {
      await onCreate({ kind, propertyId: property, leaseId: lease || null, eventDate: date || null, assignedTo: assignee || null })
      setProperty(''); setLease(''); setDate(todayIso()); setAssignee(''); setKind('move_in'); setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        style={{
          width: '100%', textAlign: 'left', fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer',
          padding: '11px 14px', borderRadius: 10, border: '1px dashed var(--border-2)', background: 'var(--surface)',
        }}>
        🔑 Log a tenant move-in / move-out…
      </button>
    )
  }

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
        Log a tenant move-in / move-out
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '0 0 10px', lineHeight: 1.45 }}>
        Creates the Move In/Move Out form checklist (Policy Manual 16.5) as a task —
        assigned to the property&rsquo;s manager unless you pick someone below.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', borderRadius: 8, padding: 3 }}>
          {(['move_in', 'move_out'] as MoveKind[]).map(k => (
            <button key={k} onClick={() => setKind(k)}
              style={{
                fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: 'none',
                background: kind === k ? 'var(--surface)' : 'transparent',
                color: kind === k ? 'var(--accent)' : 'var(--text-muted)',
              }}>
              {MOVE_SOURCE_LABEL[k]}
            </button>
          ))}
        </div>
        <select value={property} onChange={e => { setProperty(e.target.value); setLease('') }} style={controlStyle} title="Property">
          <option value="">Property…</option>
          {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={lease} onChange={e => setLease(e.target.value)} disabled={!property} style={{ ...controlStyle, maxWidth: 260 }} title="Tenant / lease">
          <option value="">{!property ? 'Pick a property first' : leasesLoading ? 'Loading tenants…' : 'Tenant / lease (optional)'}</option>
          {(leases ?? []).map(l => (
            <option key={l.id} value={l.id}>
              {l.tenantName}{l.unitNumber ? ` — Suite ${l.unitNumber}` : ''}{l.status !== 'active' ? ` (${l.status})` : ''}
            </option>
          ))}
        </select>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={controlStyle}
          title={kind === 'move_in' ? 'Date key given to tenant' : 'Date vacated'} />
        <select value={assignee} onChange={e => setAssignee(e.target.value)} style={controlStyle} title="Assign to">
          <option value="">Auto — property&rsquo;s PM</option>
          {roster.map(u => <option key={u.id} value={u.id}>{u.fullName || u.email}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <button onClick={() => setOpen(false)} disabled={busy} style={btn('ghost')}>Cancel</button>
        <button onClick={() => void submit()} disabled={!property || busy}
          style={{ ...btn('primary'), opacity: property && !busy ? 1 : 0.5 }}>
          {busy ? 'Creating…' : 'Create task'}
        </button>
      </div>
    </div>
  )
}

// ── Row ──────────────────────────────────────────────────────────────────────
function TaskRow({ task, uid, role, users, today, roster, properties, propertyNames, checklist, onChecklistChange, busy, onPatch, onDelete }: {
  task: Task
  uid: string
  role?: string
  users: UserMap
  today: string
  roster: Array<{ id: string; fullName: string | null; email: string }>
  properties: Array<{ id: string; name: string }>
  propertyNames: Record<string, string>
  checklist: ChecklistItem[]
  onChecklistChange: () => void
  busy: boolean
  onPatch: (patch: Parameters<typeof updateTask>[1]) => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle]     = useState(task.title)
  const [details, setDetails] = useState(task.details ?? '')

  const overdue = isOverdue(task, today)
  const done = task.status === 'done'
  const isManager = role === 'admin' || role === 'asset_manager'
  const canDelete = task.createdBy === uid || isManager
  const canEdit   = task.createdBy === uid || task.assignedTo === uid || isManager
  const priVariant = task.priority === 'high' ? 'red' : task.priority === 'low' ? 'gray' : null
  // "New" = someone else assigned this to me and I haven't acknowledged it yet.
  const isNew = task.assignedTo === uid && task.createdBy !== uid && !task.seenByAssignee && !done

  function saveEdit() {
    onPatch({ title, details: details || null })
    setEditing(false)
  }

  return (
    <div style={{
      background: 'var(--surface)', border: `1px solid ${overdue ? 'var(--red-border)' : 'var(--border)'}`,
      borderRadius: 12, padding: '12px 14px', opacity: busy ? 0.55 : 1,
    }}>
      <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
        {/* Done toggle */}
        <button
          onClick={() => canEdit && onPatch({ status: done ? 'open' : 'done' })}
          disabled={!canEdit || busy}
          title={done ? 'Reopen' : 'Mark done'}
          style={{
            marginTop: 2, width: 18, height: 18, flexShrink: 0, borderRadius: 5, padding: 0,
            border: `1.5px solid ${done ? 'var(--green)' : 'var(--border-2)'}`,
            background: done ? 'var(--green-bg)' : 'var(--surface-2)',
            color: 'var(--green)', cursor: canEdit ? 'pointer' : 'default', fontSize: 12, lineHeight: '15px',
          }}
        >
          {done ? '✓' : ' '}
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input value={title} onChange={e => setTitle(e.target.value)} style={{ ...controlStyle, width: '100%', fontSize: 13.5 }} />
              <textarea value={details} onChange={e => setDetails(e.target.value)} rows={2} placeholder="Details" style={{ ...controlStyle, width: '100%', resize: 'vertical' }} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={saveEdit} style={btn('primary')}>Save</button>
                <button onClick={() => { setTitle(task.title); setDetails(task.details ?? ''); setEditing(false) }} style={btn('ghost')}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                {isNew && (
                  <span style={{
                    flexShrink: 0, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', color: '#fff',
                    background: 'var(--red)', borderRadius: 99, padding: '2px 6px', alignSelf: 'center',
                  }}>
                    NEW
                  </span>
                )}
                <div
                  onClick={() => canEdit && setEditing(true)}
                  style={{
                    fontSize: 13.5, fontWeight: 500, lineHeight: 1.4, color: done ? 'var(--text-faint)' : 'var(--text)',
                    textDecoration: done ? 'line-through' : 'none', cursor: canEdit ? 'text' : 'default', wordBreak: 'break-word',
                  }}
                  title={canEdit ? 'Click to edit' : undefined}
                >
                  {task.title}
                </div>
              </div>
              {task.details && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {task.details}
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 7, fontSize: 11, color: 'var(--text-faint)' }}>
                {task.source !== 'manual' && (
                  <span style={{
                    background: 'var(--accent-dim)', color: 'var(--accent)', fontWeight: 600,
                    padding: '2px 8px', borderRadius: 99,
                  }}>
                    {task.source === 'move_in' ? '🔑 Move-in' : '📦 Move-out'}
                  </span>
                )}
                {task.propertyId && (
                  <span style={{ background: 'var(--surface-2)', padding: '2px 8px', borderRadius: 99 }}>
                    {propertyNames[task.propertyId] ?? '—'}
                  </span>
                )}
                {task.dueDate && (
                  <span style={{ color: overdue ? 'var(--red)' : 'var(--text-faint)', fontWeight: overdue ? 600 : 400 }}>
                    {overdue ? '⚠ overdue · ' : 'due '}{fmtDate(task.dueDate)}
                  </span>
                )}
                {priVariant && <Badge variant={priVariant}>{task.priority}</Badge>}
                <span>{task.assignedTo ? `→ ${userLabel(task.assignedTo, users)}` : 'unassigned'}</span>
                {task.createdBy !== uid && <span>· by {userLabel(task.createdBy, users)}</span>}
              </div>
              <ChecklistSection taskId={task.id} items={checklist} canEdit={canEdit} onChange={onChecklistChange} />
            </>
          )}
        </div>

        {/* Operational controls */}
        {canEdit && !editing && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-end', flexShrink: 0 }}>
            <select value={task.status} disabled={busy} onChange={e => onPatch({ status: e.target.value as TaskStatus })} style={miniSelect} title="Status">
              {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
            <select value={task.assignedTo ?? ''} disabled={busy} onChange={e => onPatch({ assignedTo: e.target.value || null })} style={miniSelect} title="Assignee">
              <option value="">Unassigned</option>
              {roster.map(u => <option key={u.id} value={u.id}>{u.fullName || u.email}{u.id === uid ? ' (me)' : ''}</option>)}
            </select>
            <div style={{ display: 'flex', gap: 4 }}>
              <select value={task.priority} disabled={busy} onChange={e => onPatch({ priority: e.target.value as TaskPriority })} style={miniSelect} title="Priority">
                {PRIORITIES.map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
              <select value={task.propertyId ?? ''} disabled={busy} onChange={e => onPatch({ propertyId: e.target.value || null })} style={{ ...miniSelect, maxWidth: 120 }} title="Property">
                <option value="">No property</option>
                {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            {canDelete && (
              <button onClick={onDelete} disabled={busy} title="Delete task"
                style={{ fontSize: 10.5, color: 'var(--text-faint)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Checklist / subtasks (per task row) ──────────────────────────────────────
function ChecklistSection({ taskId, items, canEdit, onChange }: {
  taskId: string
  items: ChecklistItem[]
  canEdit: boolean
  onChange: () => void
}) {
  const [open, setOpen]   = useState(false)
  const [label, setLabel] = useState('')
  const [busy, setBusy]   = useState(false)
  const done = items.filter(i => i.isDone).length

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    try { await fn(); onChange() } finally { setBusy(false) }
  }
  async function add() {
    const l = label.trim()
    if (!l) return
    await run(() => addChecklistItem(taskId, l, items.length))
    setLabel('')
  }

  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--surface-2)',
          border: '1px solid var(--border-2)', borderRadius: 99, padding: '2px 9px', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}
      >
        <span style={{ fontSize: 9, transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .15s' }}>▾</span>
        {items.length > 0 ? `Checklist ${done}/${items.length}` : 'Add checklist'}
      </button>

      {open && (
        <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 2 }}>
          {items.map(it => (
            <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox" checked={it.isDone} disabled={!canEdit || busy}
                onChange={e => run(() => toggleChecklistItem(it.id, e.target.checked))}
                style={{ cursor: canEdit ? 'pointer' : 'default' }}
              />
              <span style={{
                flex: 1, fontSize: 12, lineHeight: 1.4, wordBreak: 'break-word',
                color: it.isDone ? 'var(--text-faint)' : 'var(--text)',
                textDecoration: it.isDone ? 'line-through' : 'none',
              }}>
                {it.label}
              </span>
              {canEdit && (
                <button onClick={() => run(() => deleteChecklistItem(it.id))} disabled={busy} title="Remove"
                  style={{ fontSize: 12, color: 'var(--text-faint)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px' }}>
                  ×
                </button>
              )}
            </div>
          ))}
          {canEdit && (
            <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
              <input
                value={label} onChange={e => setLabel(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void add() }}
                placeholder="Add subtask…" disabled={busy}
                style={{ ...controlStyle, flex: 1, fontSize: 11.5, padding: '4px 8px' }}
              />
              <button onClick={() => void add()} disabled={!label.trim() || busy}
                style={{ fontSize: 11.5, fontWeight: 600, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                  border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text-muted)', opacity: label.trim() ? 1 : 0.5 }}>
                Add
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const miniSelect: CSSProperties = {
  fontSize: 11, color: 'var(--text-muted)', background: 'var(--surface-2)',
  border: '1px solid var(--border-2)', borderRadius: 6, padding: '3px 6px', cursor: 'pointer', outline: 'none',
}

function btn(kind: 'primary' | 'ghost'): CSSProperties {
  if (kind === 'primary') return {
    fontSize: 12.5, fontWeight: 600, padding: '7px 14px', borderRadius: 7, cursor: 'pointer',
    border: '1px solid var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)',
  }
  return {
    fontSize: 12.5, fontWeight: 500, padding: '7px 14px', borderRadius: 7, cursor: 'pointer',
    border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text-muted)',
  }
}
