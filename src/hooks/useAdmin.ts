import { supabase } from '../lib/supabase'
import { useQuery } from './useQuery'
import type { User, Entitlement, AccessTemplate } from '../types/database'

// Data + mutations for the admin panel (/admin). Reads and non-privileged
// writes (role / pages / entitlements on existing users, template CRUD) go
// straight through RLS as the admin. Creating a login, resetting a password
// and deleting a login require the service role, so those call the
// `admin-users` edge function.

const FN = import.meta.env.VITE_SUPABASE_URL + '/functions/v1/admin-users'

export interface AdminUser extends User {
  entitlements: Entitlement[]
}

export function useUsers() {
  return useQuery<AdminUser[]>(async () => {
    const { data, error } = await supabase
      .from('users')
      .select('*, entitlements!entitlements_user_id_fkey(*)')
      .order('created_at', { ascending: true })
    if (error) throw new Error(error.message)
    return (data ?? []) as AdminUser[]
  }, [])
}

export function useAccessTemplates() {
  return useQuery<AccessTemplate[]>(async () => {
    const { data, error } = await supabase
      .from('access_templates')
      .select('*')
      .order('name')
    if (error) throw new Error(error.message)
    return (data ?? []) as AccessTemplate[]
  }, [])
}

// ── Privileged operations via the edge function ─────────────────────────────

async function callAdminFn(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(FN, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session?.access_token ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok || out.error) throw new Error(String(out.error ?? `request failed (${res.status})`))
  return out
}

export interface NewEntitlement {
  scope: Entitlement['scope']
  portfolio_id?: string | null
  property_id?: string | null
  fund_id?: string | null
  can_read?: boolean
  can_write?: boolean
  can_upload?: boolean
}

export function createUser(payload: {
  email: string
  full_name: string
  password: string
  role: User['role']
  allowed_pages?: string[] | null
  template_id?: string | null
  entitlements?: NewEntitlement[]
}) {
  return callAdminFn({ action: 'create', ...payload })
}

export function setPassword(user_id: string, password: string) {
  return callAdminFn({ action: 'set_password', user_id, password })
}

export function deleteUser(user_id: string) {
  return callAdminFn({ action: 'delete', user_id })
}

// ── Non-privileged writes (admin RLS) ───────────────────────────────────────

export async function updateUser(id: string, patch: Partial<Pick<User,
  'role' | 'is_active' | 'allowed_pages' | 'template_id' | 'full_name' | 'dashboard_widgets'>>) {
  const { error } = await supabase
    .from('users')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

/** Replace a user's entitlement rows wholesale (delete + insert). */
export async function setUserEntitlements(userId: string, ents: NewEntitlement[]) {
  const { error: delErr } = await supabase.from('entitlements').delete().eq('user_id', userId)
  if (delErr) throw new Error(delErr.message)
  if (!ents.length) return
  const rows = ents.map(e => ({
    user_id: userId,
    scope: e.scope,
    portfolio_id: e.portfolio_id ?? null,
    property_id: e.property_id ?? null,
    fund_id: e.fund_id ?? null,
    can_read: e.can_read ?? true,
    can_write: e.can_write ?? false,
    can_upload: e.can_upload ?? false,
  }))
  const { error: insErr } = await supabase.from('entitlements').insert(rows)
  if (insErr) throw new Error(insErr.message)
}

export async function saveTemplate(t: Partial<AccessTemplate> & { name: string; role: AccessTemplate['role'] }) {
  const row = {
    ...(t.id ? { id: t.id } : {}),
    name: t.name,
    description: t.description ?? null,
    role: t.role,
    pages: t.pages ?? null,
    grant_scope: t.grant_scope ?? 'global',
    resource_ids: t.resource_ids ?? [],
    can_write: t.can_write ?? false,
    can_upload: t.can_upload ?? false,
    dashboard_widgets: t.dashboard_widgets ?? null,
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await supabase
    .from('access_templates')
    .upsert(row)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as AccessTemplate
}

export async function deleteTemplate(id: string) {
  const { error } = await supabase.from('access_templates').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

/** Turn a template's grant into concrete entitlement rows. */
export function entitlementsFromTemplate(t: AccessTemplate): NewEntitlement[] {
  if (t.grant_scope === 'global') {
    return [{ scope: 'global', can_read: true, can_write: t.can_write, can_upload: t.can_upload }]
  }
  const col =
    t.grant_scope === 'portfolio' ? 'portfolio_id' :
    t.grant_scope === 'property'  ? 'property_id'  : 'fund_id'
  return (t.resource_ids ?? []).map(id => ({
    scope: t.grant_scope,
    [col]: id,
    can_read: true,
    can_write: t.can_write,
    can_upload: t.can_upload,
  } as NewEntitlement))
}

/** Apply a template to an existing user: role + pages + dashboard + entitlements. */
export async function applyTemplate(userId: string, t: AccessTemplate) {
  await updateUser(userId, {
    role: t.role, allowed_pages: t.pages, template_id: t.id,
    dashboard_widgets: t.dashboard_widgets ?? null,
  })
  await setUserEntitlements(userId, entitlementsFromTemplate(t))
}
