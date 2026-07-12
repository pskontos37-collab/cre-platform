// work-orders — the ONLY backend surface the tenant work-order portal talks to.
//
// Tenants never hold Supabase Auth credentials (a real `authenticated` JWT
// would reach every broadly-granted table/view/RPC in this project). Portal
// identities live in work_order_portal_users; this function verifies a
// PBKDF2 password, issues an HMAC-signed session token, and performs every
// tenant read/write itself with the service role, scoped to the caller's
// property + tenant. The browser reaches it with the public anon key as the
// gateway bearer; the portal session token travels in the JSON body.
//
// Staff-only actions (creating a portal login, resetting its password) verify
// the caller's real Supabase JWT via _shared/auth.ts instead.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected).
//
// POST JSON { action, ... }:
//   tenant  — portal_login, portal_change_password, portal_me, portal_orders,
//             portal_order, portal_create, portal_comment
//   staff   — staff_create_portal_user, staff_set_portal_password

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireUser, canReadProperty, corsHeaders, AuthError } from '../_shared/auth.ts'

const PBKDF2_ITERS = 120_000
const SESSION_DAYS = 7
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MINUTES = 15
const MAX_PHOTOS = 5
const MAX_PHOTO_BYTES = 5 * 1024 * 1024

const CATEGORIES = ['hvac','plumbing','electrical','roof_leak','doors_locks','lighting',
  'janitorial','pest_control','landscaping','parking_lot','signage','safety','other']
const PRIORITIES = ['low','normal','high','emergency']

// ── crypto helpers ───────────────────────────────────────────────────────────
const te = new TextEncoder()

const b64 = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))))
const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'))

async function pbkdf2(password: string, salt: Uint8Array, iters: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, key, 256)
  return b64(bits)
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await pbkdf2(password, salt, PBKDF2_ITERS)
  return `pbkdf2$${PBKDF2_ITERS}$${b64(salt)}$${hash}`
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iters = parseInt(parts[1], 10)
  const salt = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0))
  const hash = await pbkdf2(password, salt, iters)
  return hash === parts[3]
}

// Session tokens: b64url(payload).b64url(hmac). Secret is derived from the
// service-role key, which never leaves the edge runtime.
let hmacKey: CryptoKey | null = null
async function getHmacKey(): Promise<CryptoKey> {
  if (hmacKey) return hmacKey
  const seed = await crypto.subtle.digest('SHA-256',
    te.encode('wo-portal:' + Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')))
  hmacKey = await crypto.subtle.importKey('raw', seed, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  return hmacKey
}

interface TokenPayload { u: string; e: number; te: number }  // user id, expiry (s), token_epoch

async function issueToken(portalUserId: string, tokenEpoch: number): Promise<string> {
  const payload = JSON.stringify({ u: portalUserId, e: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400, te: tokenEpoch })
  const sig = await crypto.subtle.sign('HMAC', await getHmacKey(), te.encode(payload))
  return `${b64url(payload)}.${b64url(String.fromCharCode(...new Uint8Array(sig)))}`
}

async function readToken(token: string): Promise<TokenPayload | null> {
  const dot = token.indexOf('.')
  if (dot < 0) return null
  try {
    const payload = unb64url(token.slice(0, dot))
    const sig = Uint8Array.from(unb64url(token.slice(dot + 1)), c => c.charCodeAt(0))
    const ok = await crypto.subtle.verify('HMAC', await getHmacKey(), sig, te.encode(payload))
    if (!ok) return null
    const parsed = JSON.parse(payload) as TokenPayload
    if (!parsed.u || parsed.e < Math.floor(Date.now() / 1000)) return null
    return parsed
  } catch {
    return null
  }
}

// ── portal caller resolution ─────────────────────────────────────────────────
interface PortalUser {
  id: string; property_id: string; tenant_name: string; unit_label: string | null
  email: string; contact_name: string | null; phone: string | null
  must_change_password: boolean; token_epoch: number; is_active: boolean
  password_hash: string; failed_attempts: number; locked_until: string | null
}

async function requirePortalUser(sb: SupabaseClient, body: Record<string, unknown>): Promise<PortalUser> {
  const parsed = await readToken(String(body.portal_token ?? ''))
  if (!parsed) throw new AuthError('Session expired — please sign in again', 401)
  const { data } = await sb.from('work_order_portal_users').select('*').eq('id', parsed.u).single()
  const pu = data as PortalUser | null
  if (!pu || !pu.is_active) throw new AuthError('Account is inactive', 403)
  if (pu.token_epoch !== parsed.te) throw new AuthError('Session expired — please sign in again', 401)
  return pu
}

const profileOf = (pu: PortalUser, propertyName: string | null) => ({
  id: pu.id,
  email: pu.email,
  tenant_name: pu.tenant_name,
  unit_label: pu.unit_label,
  contact_name: pu.contact_name,
  phone: pu.phone,
  property_id: pu.property_id,
  property_name: propertyName,
  must_change_password: pu.must_change_password,
})

async function propertyName(sb: SupabaseClient, id: string): Promise<string | null> {
  const { data } = await sb.from('properties').select('name').eq('id', id).single()
  return (data as { name: string } | null)?.name ?? null
}

// All of a tenant's orders at their property (covers staff-entered orders for
// the same tenant, and multiple portal logins for one tenant org).
function tenantOrdersQuery(sb: SupabaseClient, pu: PortalUser) {
  return sb.from('work_orders')
    .select('id, wo_number, category, priority, title, description, status, unit_label, contact_phone, permission_to_enter, resolution_notes, acknowledged_at, completed_at, created_at')
    .eq('property_id', pu.property_id)
    .ilike('tenant_name', pu.tenant_name)
}

serve(async (req) => {
  const CORS = corsHeaders(req)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const action = String(body.action ?? '')

    // ══════════════════════════════════════════════════════ tenant actions ══

    if (action === 'portal_login') {
      const email = String(body.email ?? '').trim().toLowerCase()
      const password = String(body.password ?? '')
      if (!email || !password) return json({ error: 'Email and password are required' }, 400)

      const { data } = await sb.from('work_order_portal_users').select('*').eq('email', email).maybeSingle()
      const pu = data as PortalUser | null
      // Uniform error for unknown email / bad password — don't leak which.
      const fail = () => json({ error: 'Invalid email or password' }, 401)
      if (!pu || !pu.is_active) return fail()
      if (pu.locked_until && new Date(pu.locked_until) > new Date()) {
        return json({ error: 'Too many failed attempts — try again in a few minutes' }, 429)
      }

      if (!(await verifyPassword(password, pu.password_hash))) {
        const attempts = (pu.failed_attempts ?? 0) + 1
        const patch: Record<string, unknown> = { failed_attempts: attempts, updated_at: new Date().toISOString() }
        if (attempts >= MAX_FAILED_ATTEMPTS) {
          patch.failed_attempts = 0
          patch.locked_until = new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
        }
        await sb.from('work_order_portal_users').update(patch).eq('id', pu.id)
        return fail()
      }

      await sb.from('work_order_portal_users').update({
        failed_attempts: 0, locked_until: null,
        last_login_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', pu.id)

      return json({
        token: await issueToken(pu.id, pu.token_epoch),
        profile: profileOf(pu, await propertyName(sb, pu.property_id)),
      })
    }

    if (action === 'portal_change_password') {
      const pu = await requirePortalUser(sb, body)
      const current = String(body.current_password ?? '')
      const next = String(body.new_password ?? '')
      if (next.length < 8) return json({ error: 'New password must be at least 8 characters' }, 400)
      if (!(await verifyPassword(current, pu.password_hash))) {
        return json({ error: 'Current password is incorrect' }, 401)
      }
      const newEpoch = pu.token_epoch + 1
      const { error } = await sb.from('work_order_portal_users').update({
        password_hash: await hashPassword(next),
        must_change_password: false,
        token_epoch: newEpoch,
        updated_at: new Date().toISOString(),
      }).eq('id', pu.id)
      if (error) return json({ error: error.message }, 400)
      // Old tokens are dead (epoch bump); hand back a fresh one.
      return json({ token: await issueToken(pu.id, newEpoch) })
    }

    if (action === 'portal_me') {
      const pu = await requirePortalUser(sb, body)
      return json({ profile: profileOf(pu, await propertyName(sb, pu.property_id)) })
    }

    if (action === 'portal_orders') {
      const pu = await requirePortalUser(sb, body)
      const { data, error } = await tenantOrdersQuery(sb, pu).order('created_at', { ascending: false })
      if (error) return json({ error: error.message }, 400)
      return json({ orders: data ?? [] })
    }

    if (action === 'portal_order') {
      const pu = await requirePortalUser(sb, body)
      const id = String(body.id ?? '')
      const { data: order, error } = await tenantOrdersQuery(sb, pu).eq('id', id).maybeSingle()
      if (error) return json({ error: error.message }, 400)
      if (!order) return json({ error: 'Request not found' }, 404)

      const { data: comments } = await sb.from('work_order_comments')
        .select('id, author_kind, author_name, body, created_at')
        .eq('work_order_id', id).eq('is_internal', false)
        .order('created_at', { ascending: true })

      const { data: photos } = await sb.from('work_order_photos')
        .select('id, storage_path, caption, created_at')
        .eq('work_order_id', id).order('created_at', { ascending: true })
      const signed = []
      for (const p of (photos ?? []) as Array<{ id: string; storage_path: string; caption: string | null }>) {
        const { data: s } = await sb.storage.from('work-orders').createSignedUrl(p.storage_path, 3600)
        if (s?.signedUrl) signed.push({ id: p.id, url: s.signedUrl, caption: p.caption })
      }

      return json({ order, comments: comments ?? [], photos: signed })
    }

    if (action === 'portal_create') {
      const pu = await requirePortalUser(sb, body)
      const category = String(body.category ?? 'other')
      const priority = String(body.priority ?? 'normal')
      const title = String(body.title ?? '').trim().slice(0, 140)
      const description = String(body.description ?? '').trim().slice(0, 4000)
      if (!CATEGORIES.includes(category)) return json({ error: 'Invalid category' }, 400)
      if (!PRIORITIES.includes(priority)) return json({ error: 'Invalid priority' }, 400)
      if (!title) return json({ error: 'Please give the request a short title' }, 400)

      const { data: order, error } = await sb.from('work_orders').insert({
        property_id: pu.property_id,
        portal_user_id: pu.id,
        tenant_name: pu.tenant_name,
        unit_label: String(body.unit_label ?? pu.unit_label ?? '').trim() || null,
        category, priority, title,
        description: description || null,
        contact_phone: String(body.contact_phone ?? pu.phone ?? '').trim() || null,
        permission_to_enter: body.permission_to_enter !== false,
        source: 'portal',
      }).select('id, wo_number, title, status, created_at').single()
      if (error || !order) return json({ error: error?.message ?? 'insert failed' }, 400)

      // Photos arrive base64 in the same request (portal users can't touch
      // storage directly). Failures here don't sink the order itself.
      const photos = Array.isArray(body.photos) ? body.photos.slice(0, MAX_PHOTOS) : []
      let photoCount = 0
      for (const raw of photos) {
        const p = raw as { data_b64?: string; content_type?: string }
        if (!p?.data_b64) continue
        let bytes: Uint8Array
        try { bytes = Uint8Array.from(atob(p.data_b64), c => c.charCodeAt(0)) } catch { continue }
        if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) continue
        const ctype = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'].includes(p.content_type ?? '')
          ? p.content_type! : 'image/jpeg'
        const ext = ctype === 'image/png' ? 'png' : ctype === 'image/webp' ? 'webp' : ctype === 'image/heic' ? 'heic' : 'jpg'
        const path = `${pu.property_id}/${(order as { id: string }).id}/${crypto.randomUUID()}.${ext}`
        const { error: upErr } = await sb.storage.from('work-orders').upload(path, bytes, { contentType: ctype })
        if (upErr) continue
        await sb.from('work_order_photos').insert({
          work_order_id: (order as { id: string }).id,
          storage_path: path, content_type: ctype, uploaded_by_kind: 'tenant',
        })
        photoCount++
      }

      return json({ order, photo_count: photoCount })
    }

    if (action === 'portal_comment') {
      const pu = await requirePortalUser(sb, body)
      const orderId = String(body.work_order_id ?? '')
      const text = String(body.body ?? '').trim().slice(0, 2000)
      if (!text) return json({ error: 'Comment is empty' }, 400)
      // Scope check: the order must belong to this tenant at this property.
      const { data: order } = await tenantOrdersQuery(sb, pu).eq('id', orderId).maybeSingle()
      if (!order) return json({ error: 'Request not found' }, 404)

      const { data: comment, error } = await sb.from('work_order_comments').insert({
        work_order_id: orderId,
        author_kind: 'tenant',
        portal_user_id: pu.id,
        author_name: pu.contact_name || pu.tenant_name,
        body: text,
        is_internal: false,
      }).select('id, author_kind, author_name, body, created_at').single()
      if (error) return json({ error: error.message }, 400)
      await sb.from('work_orders').update({ updated_at: new Date().toISOString() }).eq('id', orderId)
      return json({ comment })
    }

    // ═══════════════════════════════════════════════════════ staff actions ══

    if (action === 'staff_create_portal_user') {
      const caller = await requireUser(req, sb)
      const propertyId = String(body.property_id ?? '')
      if (!canReadProperty(caller, propertyId) || !propertyId) {
        throw new AuthError('No access to this property', 403)
      }
      const email = String(body.email ?? '').trim().toLowerCase()
      const tenantName = String(body.tenant_name ?? '').trim()
      const password = String(body.password ?? '')
      if (!email || !email.includes('@')) return json({ error: 'A valid email is required' }, 400)
      if (!tenantName) return json({ error: 'tenant_name is required' }, 400)
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)

      const { data: created, error } = await sb.from('work_order_portal_users').insert({
        property_id: propertyId,
        tenant_name: tenantName,
        unit_label: String(body.unit_label ?? '').trim() || null,
        email,
        contact_name: String(body.contact_name ?? '').trim() || null,
        phone: String(body.phone ?? '').trim() || null,
        password_hash: await hashPassword(password),
        must_change_password: true,
        created_by: caller.id === 'service' ? null : caller.id,
      }).select('id, email, tenant_name').single()
      if (error) {
        const msg = error.message.includes('duplicate') || error.message.includes('unique')
          ? 'A portal login with that email already exists' : error.message
        return json({ error: msg }, 400)
      }
      return json({ success: true, portal_user: created })
    }

    if (action === 'staff_set_portal_password') {
      const caller = await requireUser(req, sb)
      const id = String(body.portal_user_id ?? '')
      const password = String(body.password ?? '')
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)
      const { data } = await sb.from('work_order_portal_users').select('id, property_id, token_epoch').eq('id', id).single()
      const pu = data as { id: string; property_id: string; token_epoch: number } | null
      if (!pu) return json({ error: 'Portal user not found' }, 404)
      if (!canReadProperty(caller, pu.property_id)) throw new AuthError('No access to this property', 403)

      const { error } = await sb.from('work_order_portal_users').update({
        password_hash: await hashPassword(password),
        must_change_password: true,
        token_epoch: pu.token_epoch + 1,     // kill any live tenant sessions
        failed_attempts: 0, locked_until: null,
        updated_at: new Date().toISOString(),
      }).eq('id', id)
      if (error) return json({ error: error.message }, 400)
      return json({ success: true })
    }

    return json({ error: 'unknown action: ' + action }, 400)
  } catch (err: unknown) {
    const status = err instanceof AuthError ? err.status : 500
    return json({ error: err instanceof Error ? err.message : String(err) }, status)
  }
})
