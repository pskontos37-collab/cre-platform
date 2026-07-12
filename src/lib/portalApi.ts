// Tenant work-order portal client. The portal has its own identity system
// (work_order_portal_users) — tenants are NOT Supabase auth users, so every
// call goes to the work-orders edge function with the public anon key as the
// gateway bearer and the portal session token in the body. The token lives in
// localStorage for 7 days (matching the server-side expiry).

const FN = import.meta.env.VITE_SUPABASE_URL + '/functions/v1/work-orders'
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string

const TOKEN_KEY = 'wo_portal_token'
const PROFILE_KEY = 'wo_portal_profile'

export interface PortalProfile {
  id: string
  email: string
  tenant_name: string
  unit_label: string | null
  contact_name: string | null
  phone: string | null
  property_id: string
  property_name: string | null
  must_change_password: boolean
}

export interface PortalOrder {
  id: string
  wo_number: number
  category: string
  priority: string
  title: string
  description: string | null
  status: string
  unit_label: string | null
  location_type: 'unit' | 'common_area'
  location_detail: string | null
  assigned_vendor: string | null
  contact_phone: string | null
  permission_to_enter: boolean
  resolution_notes: string | null
  acknowledged_at: string | null
  completed_at: string | null
  created_at: string
}

export interface PortalComment {
  id: string
  author_kind: 'tenant' | 'staff'
  author_name: string | null
  body: string
  created_at: string
}

export interface PortalPhoto { id: string; url: string; caption: string | null }

export class PortalAuthExpired extends Error {}

export const getPortalToken = () => localStorage.getItem(TOKEN_KEY)

export function getCachedProfile(): PortalProfile | null {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null') } catch { return null }
}

export function portalSignOut() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(PROFILE_KEY)
}

async function call<T>(action: string, payload: Record<string, unknown> = {}, withToken = true): Promise<T> {
  const body: Record<string, unknown> = { action, ...payload }
  if (withToken) body.portal_token = getPortalToken() ?? ''
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${ANON}` },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401 && withToken) {
      portalSignOut()
      throw new PortalAuthExpired(data.error ?? 'Session expired')
    }
    throw new Error(data.error ?? `Request failed (${res.status})`)
  }
  return data as T
}

export async function portalLogin(email: string, password: string): Promise<PortalProfile> {
  const { token, profile } = await call<{ token: string; profile: PortalProfile }>(
    'portal_login', { email, password }, false)
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))
  return profile
}

export async function portalChangePassword(currentPassword: string, newPassword: string): Promise<void> {
  const { token } = await call<{ token: string }>('portal_change_password', {
    current_password: currentPassword, new_password: newPassword,
  })
  localStorage.setItem(TOKEN_KEY, token)
  const prof = getCachedProfile()
  if (prof) localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...prof, must_change_password: false }))
}

export const portalOrders = () =>
  call<{ orders: PortalOrder[] }>('portal_orders').then(r => r.orders)

export const portalOrderDetail = (id: string) =>
  call<{ order: PortalOrder; comments: PortalComment[]; photos: PortalPhoto[] }>('portal_order', { id })

export interface NewOrderInput {
  category: string
  priority: string
  title: string
  description: string
  unit_label?: string
  location_type: 'unit' | 'common_area'
  location_detail?: string
  contact_phone?: string
  permission_to_enter: boolean
  photos: { data_b64: string; content_type: string }[]
}

export const portalCreateOrder = (input: NewOrderInput) =>
  call<{ order: { id: string; wo_number: number }; photo_count: number }>('portal_create', { ...input })

export const portalAddComment = (workOrderId: string, body: string) =>
  call<{ comment: PortalComment }>('portal_comment', { work_order_id: workOrderId, body })
    .then(r => r.comment)

/** Read a File into the base64 payload the edge function expects (≤5MB each). */
export function fileToPhotoPayload(file: File): Promise<{ data_b64: string; content_type: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.onload = () => {
      const url = String(reader.result ?? '')
      const comma = url.indexOf(',')
      resolve({ data_b64: url.slice(comma + 1), content_type: file.type || 'image/jpeg' })
    }
    reader.readAsDataURL(file)
  })
}
