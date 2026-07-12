import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'

// Staff-side data access for the work-order system (/workorders). Staff read
// and mutate work_orders / comments / photos straight through PostgREST under
// the can_access_property RLS (migration 20240077). Only the two operations
// that need the service role — creating a tenant portal login and resetting
// its password — go through the work-orders edge function.

export interface WorkOrder {
  id: string
  woNumber: number
  propertyId: string
  propertyName: string
  portalUserId: string | null
  tenantName: string
  unitLabel: string | null
  category: string
  priority: string
  title: string
  description: string | null
  status: string
  source: string
  contactPhone: string | null
  permissionToEnter: boolean
  assignedTo: string | null
  resolutionNotes: string | null
  acknowledgedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface WoComment {
  id: string
  authorKind: 'tenant' | 'staff'
  authorName: string | null
  userId: string | null
  body: string
  isInternal: boolean
  createdAt: string
}

export interface WoPhoto {
  id: string
  storagePath: string
  caption: string | null
  uploadedByKind: string
}

export interface PortalUserRow {
  id: string
  propertyId: string
  propertyName: string
  tenantName: string
  unitLabel: string | null
  email: string
  contactName: string | null
  phone: string | null
  mustChangePassword: boolean
  lastLoginAt: string | null
  isActive: boolean
  createdAt: string
}

const WO_SELECT = 'id, wo_number, property_id, portal_user_id, tenant_name, unit_label, category, priority, title, description, status, source, contact_phone, permission_to_enter, assigned_to, resolution_notes, acknowledged_at, completed_at, created_at, updated_at'

function mapOrder(r: any, names: Record<string, string>): WorkOrder {
  return {
    id: r.id,
    woNumber: Number(r.wo_number),
    propertyId: r.property_id,
    propertyName: names[r.property_id] ?? '—',
    portalUserId: r.portal_user_id,
    tenantName: r.tenant_name,
    unitLabel: r.unit_label,
    category: r.category,
    priority: r.priority,
    title: r.title,
    description: r.description,
    status: r.status,
    source: r.source,
    contactPhone: r.contact_phone,
    permissionToEnter: r.permission_to_enter,
    assignedTo: r.assigned_to,
    resolutionNotes: r.resolution_notes,
    acknowledgedAt: r.acknowledged_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function useWorkOrders(propertyIds: string[], propertyNames: Record<string, string>, refreshKey = 0) {
  return useQuery<WorkOrder[]>(async () => {
    if (!propertyIds.length) return []
    const { data, error } = await supabase
      .from('work_orders')
      .select(WO_SELECT)
      .in('property_id', propertyIds)
      .order('created_at', { ascending: false })
      .limit(2000)
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(r => mapOrder(r, propertyNames))
  }, [propertyIds.join(','), refreshKey])
}

export async function fetchOrderThread(orderId: string): Promise<{ comments: WoComment[]; photos: WoPhoto[] }> {
  const [{ data: comments, error: cErr }, { data: photos, error: pErr }] = await Promise.all([
    supabase.from('work_order_comments')
      .select('id, author_kind, author_name, user_id, body, is_internal, created_at')
      .eq('work_order_id', orderId).order('created_at', { ascending: true }),
    supabase.from('work_order_photos')
      .select('id, storage_path, caption, uploaded_by_kind')
      .eq('work_order_id', orderId).order('created_at', { ascending: true }),
  ])
  if (cErr) throw new Error(cErr.message)
  if (pErr) throw new Error(pErr.message)
  return {
    comments: ((comments ?? []) as any[]).map(c => ({
      id: c.id, authorKind: c.author_kind, authorName: c.author_name,
      userId: c.user_id, body: c.body, isInternal: c.is_internal, createdAt: c.created_at,
    })),
    photos: ((photos ?? []) as any[]).map(p => ({
      id: p.id, storagePath: p.storage_path, caption: p.caption, uploadedByKind: p.uploaded_by_kind,
    })),
  }
}

/** Staff-side signed URL (storage RLS lets any staff JWT read the bucket). */
export async function signPhotoUrl(storagePath: string): Promise<string | null> {
  const { data } = await supabase.storage.from('work-orders').createSignedUrl(storagePath, 3600)
  return data?.signedUrl ?? null
}

export async function updateWorkOrder(id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('work_orders')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

export async function setWorkOrderStatus(order: WorkOrder, status: string, resolutionNotes?: string): Promise<void> {
  const patch: Record<string, unknown> = { status }
  if (status === 'acknowledged' && !order.acknowledgedAt) patch.acknowledged_at = new Date().toISOString()
  if (status === 'completed') {
    patch.completed_at = new Date().toISOString()
    if (resolutionNotes !== undefined) patch.resolution_notes = resolutionNotes || null
  }
  await updateWorkOrder(order.id, patch)
}

export async function addStaffComment(
  orderId: string,
  author: { id: string; name: string },
  body: string,
  isInternal: boolean,
): Promise<void> {
  const { error } = await supabase.from('work_order_comments').insert({
    work_order_id: orderId,
    author_kind: 'staff',
    user_id: author.id,
    author_name: author.name,
    body,
    is_internal: isInternal,
  })
  if (error) throw new Error(error.message)
  await updateWorkOrder(orderId, {})
}

export async function createStaffWorkOrder(input: {
  propertyId: string; tenantName: string; unitLabel?: string; category: string; priority: string
  title: string; description?: string; contactPhone?: string; createdBy: string
}): Promise<void> {
  const { error } = await supabase.from('work_orders').insert({
    property_id: input.propertyId,
    tenant_name: input.tenantName,
    unit_label: input.unitLabel || null,
    category: input.category,
    priority: input.priority,
    title: input.title,
    description: input.description || null,
    contact_phone: input.contactPhone || null,
    source: 'staff',
    created_by: input.createdBy,
  })
  if (error) throw new Error(error.message)
}

// ── Portal user administration ───────────────────────────────────────────────

export function usePortalUsers(propertyIds: string[], propertyNames: Record<string, string>, refreshKey = 0) {
  return useQuery<PortalUserRow[]>(async () => {
    if (!propertyIds.length) return []
    // Explicit column list: password_hash / token_epoch are not granted to
    // authenticated (column-level grants in 20240077), so select=* would 403.
    const { data, error } = await supabase
      .from('work_order_portal_users')
      .select('id, property_id, tenant_name, unit_label, email, contact_name, phone, must_change_password, last_login_at, is_active, created_at')
      .in('property_id', propertyIds)
      .order('tenant_name', { ascending: true })
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(r => ({
      id: r.id,
      propertyId: r.property_id,
      propertyName: propertyNames[r.property_id] ?? '—',
      tenantName: r.tenant_name,
      unitLabel: r.unit_label,
      email: r.email,
      contactName: r.contact_name,
      phone: r.phone,
      mustChangePassword: r.must_change_password,
      lastLoginAt: r.last_login_at,
      isActive: r.is_active,
      createdAt: r.created_at,
    }))
  }, [propertyIds.join(','), refreshKey])
}

async function invokeWorkOrdersFn(body: Record<string, unknown>): Promise<any> {
  const { data, error } = await supabase.functions.invoke('work-orders', { body })
  if (error) {
    // supabase-js swallows the response body on non-2xx; surface it if we can.
    const ctx = (error as any)?.context
    let msg = error.message
    try {
      const parsed = ctx && typeof ctx.json === 'function' ? await ctx.json() : null
      if (parsed?.error) msg = parsed.error
    } catch { /* keep original */ }
    throw new Error(msg)
  }
  if (data?.error) throw new Error(data.error)
  return data
}

export async function createPortalUser(input: {
  propertyId: string; tenantName: string; unitLabel?: string; email: string
  contactName?: string; phone?: string; password: string
}): Promise<void> {
  await invokeWorkOrdersFn({
    action: 'staff_create_portal_user',
    property_id: input.propertyId,
    tenant_name: input.tenantName,
    unit_label: input.unitLabel ?? '',
    email: input.email,
    contact_name: input.contactName ?? '',
    phone: input.phone ?? '',
    password: input.password,
  })
}

export async function resetPortalPassword(portalUserId: string, password: string): Promise<void> {
  await invokeWorkOrdersFn({ action: 'staff_set_portal_password', portal_user_id: portalUserId, password })
}

export async function setPortalUserActive(id: string, isActive: boolean): Promise<void> {
  const { error } = await supabase.from('work_order_portal_users')
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

/** Generates a readable temporary password like "Maple-4829-Cedar". */
export function tempPassword(): string {
  const words = ['Maple', 'Cedar', 'Oak', 'Birch', 'Aspen', 'Willow', 'Elm', 'Pine', 'Laurel', 'Hazel']
  const pick = () => words[Math.floor(Math.random() * words.length)]
  const num = Math.floor(1000 + Math.random() * 9000)
  return `${pick()}-${num}-${pick()}`
}

export interface AssignableUser { id: string; full_name: string | null; email: string; role: string }

export function useAssignableUsers() {
  return useQuery<AssignableUser[]>(async () => {
    const { data, error } = await supabase.rpc('assignable_users')
    if (error) throw new Error(error.message)
    return (data ?? []) as AssignableUser[]
  }, [])
}
