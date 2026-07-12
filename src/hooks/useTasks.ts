import { useEffect } from 'react'
import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'
import type { UserRole } from '../types/database'

// Team task / to-do feature (migration 20240052_tasks.sql). A task is readable
// by its creator, its assignee, or a manager (RLS); this hook just reads what
// the caller is entitled to and exposes the mutations.
//
// NOTE: we do NOT embed the creator/assignee user rows in the task query. The
// users table's RLS only exposes the caller's OWN row, so an embed would come
// back null for colleagues. Names are resolved client-side from the roster
// returned by assignable_users() (a SECURITY DEFINER RPC everyone can read).

export type TaskStatus   = 'open' | 'in_progress' | 'done'
export type TaskPriority = 'low' | 'normal' | 'high'
// 'move_in' / 'move_out' tasks carry the Policy 16.5 Move In/Move Out checklist
// (migration 20240056) — created by the leases trigger or the /tasks composer.
export type TaskSource   = 'manual' | 'move_in' | 'move_out'

export interface TaskUser {
  id: string
  fullName: string | null
  email: string
  role: UserRole
}

export interface Task {
  id: string
  title: string
  details: string | null
  status: TaskStatus
  priority: TaskPriority
  dueDate: string | null
  propertyId: string | null
  createdBy: string
  assignedTo: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  seenByAssignee: boolean
  source: TaskSource
  leaseId: string | null
}

const SELECT =
  'id, title, details, status, priority, due_date, property_id, ' +
  'created_by, assigned_to, completed_at, created_at, updated_at, seen_by_assignee, ' +
  'source, lease_id'

function mapTask(r: any): Task {
  return {
    id:          r.id,
    title:       r.title,
    details:     r.details ?? null,
    status:      r.status,
    priority:    r.priority,
    dueDate:     r.due_date ?? null,
    propertyId:  r.property_id ?? null,
    createdBy:   r.created_by,
    assignedTo:  r.assigned_to ?? null,
    completedAt: r.completed_at ?? null,
    createdAt:   r.created_at,
    updatedAt:   r.updated_at,
    seenByAssignee: r.seen_by_assignee ?? true,
    source:      (r.source as TaskSource) ?? 'manual',
    leaseId:     r.lease_id ?? null,
  }
}

// All tasks the current user can see (RLS-scoped). Not property-filtered here —
// the pages/widgets filter client-side so the global View: filter and the
// "mine / assigned / created" tabs can compose freely.
export function useTasks() {
  return useQuery<Task[]>(async () => {
    const { data, error } = await supabase
      .from('tasks')
      .select(SELECT)
      // Open work first, then by due date (nulls last), newest created as tiebreak.
      .order('status', { ascending: true })
      .order('due_date', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1000)
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(mapTask)
  }, [])
}

// The roster for the assignee picker + name resolution (SECURITY DEFINER RPC).
export function useAssignableUsers() {
  return useQuery<TaskUser[]>(async () => {
    const { data, error } = await supabase.rpc('assignable_users')
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(u => ({
      id: u.id, fullName: u.full_name ?? null, email: u.email, role: u.role,
    }))
  }, [])
}

export interface NewTask {
  title: string
  details?: string | null
  priority?: TaskPriority
  dueDate?: string | null
  propertyId?: string | null
  assignedTo?: string | null
}

export async function createTask(t: NewTask, createdBy: string): Promise<void> {
  const { error } = await supabase.from('tasks').insert({
    title:       t.title.trim(),
    details:     t.details?.trim() || null,
    priority:    t.priority ?? 'normal',
    due_date:    t.dueDate || null,
    property_id: t.propertyId || null,
    assigned_to: t.assignedTo || null,
    created_by:  createdBy,
  })
  if (error) throw new Error(error.message)
}

export interface TaskPatch {
  title?: string
  details?: string | null
  status?: TaskStatus
  priority?: TaskPriority
  dueDate?: string | null
  propertyId?: string | null
  assignedTo?: string | null
}

export async function updateTask(id: string, patch: TaskPatch): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.title      !== undefined) row.title       = patch.title.trim()
  if (patch.details    !== undefined) row.details     = patch.details?.trim() || null
  if (patch.priority   !== undefined) row.priority    = patch.priority
  if (patch.dueDate    !== undefined) row.due_date    = patch.dueDate || null
  if (patch.propertyId !== undefined) row.property_id = patch.propertyId || null
  if (patch.assignedTo !== undefined) row.assigned_to = patch.assignedTo || null
  if (patch.status     !== undefined) {
    row.status = patch.status
    row.completed_at = patch.status === 'done' ? new Date().toISOString() : null
  }
  const { error } = await supabase.from('tasks').update(row).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteTask(id: string): Promise<void> {
  const { error } = await supabase.from('tasks').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// ── Move-in / move-out events (Policy Manual 16.5) ──────────────────────────
// One RPC does everything server-side: builds the task with the full Move
// In/Move Out form checklist, auto-assigns the property's PM when no assignee
// is given, and dedupes (one task per lease per event kind). The same function
// backs the leases trigger, so manual logging and data-driven detection can't
// double-create.

export type MoveKind = 'move_in' | 'move_out'

export const MOVE_SOURCE_LABEL: Record<MoveKind, string> = {
  move_in: 'Move-in', move_out: 'Move-out',
}

export interface MoveEventInput {
  kind: MoveKind
  propertyId: string
  leaseId?: string | null
  eventDate?: string | null   // key date (move-in) / vacate date (move-out)
  assignedTo?: string | null  // blank = property's PM
  details?: string | null
}

export async function createMoveEventTask(i: MoveEventInput): Promise<void> {
  const { error } = await supabase.rpc('create_move_task', {
    p_kind:        i.kind,
    p_property_id: i.propertyId,
    p_lease_id:    i.leaseId || null,
    p_event_date:  i.eventDate || null,
    p_assigned_to: i.assignedTo || null,
    p_details:     i.details?.trim() || null,
  })
  if (error) throw new Error(error.message)
}

// Leases for one property, for the move-event lease picker.
export interface LeaseOption {
  id: string
  tenantName: string
  unitNumber: string | null
  leaseNumber: string | null
  status: string
}

export function usePropertyLeases(propertyId: string | null) {
  return useQuery<LeaseOption[]>(async () => {
    if (!propertyId) return []
    const { data, error } = await supabase
      .from('leases')
      .select('id, lease_number, status, tenant:tenants(name), unit:units(unit_number)')
      .eq('property_id', propertyId)
      .limit(1000)
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[])
      .map(r => ({
        id:          r.id,
        tenantName:  r.tenant?.name ?? '—',
        unitNumber:  r.unit?.unit_number ?? null,
        leaseNumber: r.lease_number ?? null,
        status:      r.status,
      }))
      .sort((a, b) =>
        // active leases first, then alphabetical by tenant
        (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1)
        || a.tenantName.localeCompare(b.tenantName))
  }, [propertyId])
}

// ── Assignment notification badge ───────────────────────────────────────────
// Fired when a user acknowledges their assigned tasks so the sidebar badge (a
// separate query in a persistent component) can refetch without a route change.
export const TASKS_SEEN_EVENT = 'cre-tasks-seen'

// Count of open tasks freshly assigned to `uid` that they haven't seen yet.
// Refetches on TASKS_SEEN_EVENT so the badge clears the moment they're marked.
export function useAssignedTaskCount(uid: string) {
  const q = useQuery<number>(async () => {
    if (!uid) return 0
    const { count, error } = await supabase
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('assigned_to', uid)
      .eq('seen_by_assignee', false)
      .neq('status', 'done')
    if (error) throw new Error(error.message)
    return count ?? 0
  }, [uid])
  const { refetch } = q
  useEffect(() => {
    const h = () => refetch()
    window.addEventListener(TASKS_SEEN_EVENT, h)
    return () => window.removeEventListener(TASKS_SEEN_EVENT, h)
  }, [refetch])
  return q
}

// Mark every unseen task assigned to `uid` as seen (called when they open the
// board). The seen flag isn't touched by the reset trigger unless assigned_to
// changes, so this write sticks.
export async function markAssignedSeen(uid: string): Promise<void> {
  if (!uid) return
  const { error } = await supabase
    .from('tasks')
    .update({ seen_by_assignee: true })
    .eq('assigned_to', uid)
    .eq('seen_by_assignee', false)
  if (error) throw new Error(error.message)
  window.dispatchEvent(new Event(TASKS_SEEN_EVENT))
}

// ── Checklists / subtasks ───────────────────────────────────────────────────
export interface ChecklistItem {
  id: string
  taskId: string
  label: string
  isDone: boolean
  position: number
}

// All checklist items the caller can see (RLS-scoped via can_access_task),
// grouped by task id. One fetch covers every task on the board.
export function useChecklists() {
  return useQuery<Record<string, ChecklistItem[]>>(async () => {
    const { data, error } = await supabase
      .from('task_checklist_items')
      .select('id, task_id, label, is_done, position')
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(5000)
    if (error) throw new Error(error.message)
    const out: Record<string, ChecklistItem[]> = {}
    for (const r of (data ?? []) as any[]) {
      const item: ChecklistItem = { id: r.id, taskId: r.task_id, label: r.label, isDone: r.is_done, position: r.position }
      ;(out[item.taskId] ??= []).push(item)
    }
    return out
  }, [])
}

export async function addChecklistItem(taskId: string, label: string, position: number): Promise<void> {
  const { error } = await supabase
    .from('task_checklist_items')
    .insert({ task_id: taskId, label: label.trim(), position })
  if (error) throw new Error(error.message)
}

export async function toggleChecklistItem(id: string, isDone: boolean): Promise<void> {
  const { error } = await supabase.from('task_checklist_items').update({ is_done: isDone }).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteChecklistItem(id: string): Promise<void> {
  const { error } = await supabase.from('task_checklist_items').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// ── Presentation helpers ────────────────────────────────────────────────────

export const STATUS_LABEL: Record<TaskStatus, string> = {
  open: 'Open', in_progress: 'In progress', done: 'Done',
}
export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: 'Low', normal: 'Normal', high: 'High',
}

export type UserMap = Record<string, TaskUser>
export const indexUsers = (list: TaskUser[] | null): UserMap =>
  Object.fromEntries((list ?? []).map(u => [u.id, u]))

export const userLabel = (id: string | null, users: UserMap): string => {
  if (!id) return '—'
  const u = users[id]
  return u ? (u.fullName || u.email) : '—'
}

// A task is overdue when it has a due date in the past and isn't done.
export function isOverdue(t: Task, todayIso: string): boolean {
  return t.status !== 'done' && !!t.dueDate && t.dueDate < todayIso
}
