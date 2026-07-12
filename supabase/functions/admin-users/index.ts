// admin-users — privileged user administration for the admin panel.
//
// The browser cannot create Supabase Auth logins (that needs the service-role
// key), so those operations live here. Every request is guarded: the caller's
// JWT is resolved to a user, and that user must be an active `admin` in the
// public.users table before any action runs.
//
// Role / page / entitlement edits on EXISTING users are done straight from the
// frontend (admin RLS already allows them) — this function only owns the parts
// that require the service role: creating a login, resetting a password, and
// deleting a login.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Usage: POST JSON { action, ... }
//   action='create'       { email, full_name, password, role, allowed_pages?, template_id?,
//                           entitlements?: [{scope, portfolio_id?, property_id?, fund_id?,
//                                            can_read?, can_write?, can_upload?}] }
//   action='set_password' { user_id, password }
//   action='delete'       { user_id }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // ── Authenticate + authorize the caller as an active admin.
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!token) return json({ error: 'Missing bearer token' }, 401)
    const { data: { user: caller }, error: authErr } = await sb.auth.getUser(token)
    if (authErr || !caller) return json({ error: 'Invalid session' }, 401)
    const { data: prof } = await sb.from('users').select('role, is_active').eq('id', caller.id).single()
    if (!prof || prof.role !== 'admin' || !prof.is_active) return json({ error: 'Admin access required' }, 403)

    const body = await req.json().catch(() => ({}))
    const action: string = body.action ?? ''

    // ────────────────────────────────────────────────────────── create
    if (action === 'create') {
      const email: string = (body.email ?? '').trim().toLowerCase()
      const password: string = body.password ?? ''
      const fullName: string = (body.full_name ?? '').trim()
      const role: string = body.role ?? 'property_manager'
      if (!email || !password) return json({ error: 'email and password are required' }, 400)
      if (password.length < 8) return json({ error: 'password must be at least 8 characters' }, 400)

      const { data: created, error: cErr } = await sb.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      })
      if (cErr || !created?.user) return json({ error: 'create failed: ' + (cErr?.message ?? 'unknown') }, 400)
      const newId = created.user.id

      // The on_auth_user_created trigger inserts a public.users row (default role).
      // Upsert to set the intended role / pages, tolerant of trigger timing.
      const { error: uErr } = await sb.from('users').upsert({
        id: newId,
        email,
        full_name: fullName || null,
        role,
        allowed_pages: body.allowed_pages ?? null,
        template_id: body.template_id ?? null,
        is_active: true,
      })
      if (uErr) return json({ error: 'profile write failed: ' + uErr.message }, 400)

      const ents = Array.isArray(body.entitlements) ? body.entitlements : []
      if (ents.length) {
        const rows = ents.map((e: Record<string, unknown>) => ({
          user_id: newId,
          scope: e.scope,
          portfolio_id: e.portfolio_id ?? null,
          property_id: e.property_id ?? null,
          fund_id: e.fund_id ?? null,
          can_read: e.can_read ?? true,
          can_write: e.can_write ?? false,
          can_upload: e.can_upload ?? false,
          granted_by: caller.id,
        }))
        const { error: eErr } = await sb.from('entitlements').insert(rows)
        if (eErr) return json({ error: 'entitlement write failed: ' + eErr.message }, 400)
      }

      return json({ success: true, user_id: newId, email })
    }

    // ────────────────────────────────────────────────── set_password
    if (action === 'set_password') {
      const userId: string = body.user_id ?? ''
      const password: string = body.password ?? ''
      if (!userId || !password) return json({ error: 'user_id and password are required' }, 400)
      if (password.length < 8) return json({ error: 'password must be at least 8 characters' }, 400)
      const { error } = await sb.auth.admin.updateUserById(userId, { password })
      if (error) return json({ error: 'password reset failed: ' + error.message }, 400)
      return json({ success: true })
    }

    // ─────────────────────────────────────────────────────────── delete
    if (action === 'delete') {
      const userId: string = body.user_id ?? ''
      if (!userId) return json({ error: 'user_id is required' }, 400)
      if (userId === caller.id) return json({ error: 'You cannot delete your own account' }, 400)
      // Remove the auth login, then the profile (entitlements cascade off users).
      const { error: aErr } = await sb.auth.admin.deleteUser(userId)
      if (aErr) return json({ error: 'auth delete failed: ' + aErr.message }, 400)
      const { error: pErr } = await sb.from('users').delete().eq('id', userId)
      if (pErr) return json({ error: 'profile delete failed: ' + pErr.message }, 400)
      return json({ success: true })
    }

    return json({ error: 'unknown action: ' + action }, 400)
  } catch (err: unknown) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
