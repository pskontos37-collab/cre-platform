// _shared/auth.ts — caller authentication + authorization for edge functions.
//
// Every function that runs with the SERVICE ROLE key (which bypasses RLS) must
// first prove who is calling and what they may see. Before this existed, a
// valid gateway credential (incl. the public anon key shipped in the frontend
// bundle) was enough to reach the service-role logic and read the whole corpus.
//
//   requireUser(req, sb)  -> resolves the JWT to an ACTIVE public.users row and
//                            returns the caller's read scope.
//   requireAdmin(req, sb) -> same, but insists on role='admin'.
//   canReadProperty(...)  -> per-document gate mirroring the documents_select RLS.
//   canWriteProperty(...) -> mutation gate: "may view" is NOT "may change".
//   corsHeaders(req)      -> CORS locked to an origin allowlist (no more "*").
//
// The pure read/write decisions live in ./access.ts (no imports) so the exact
// rules are unit-tested by Vitest in src/; this module re-exports them.
//
// On failure the require* helpers throw AuthError; each function's catch turns
// its .status into the HTTP status.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
export { canReadProperty, canWriteProperty } from './access.ts'

export class AuthError extends Error {
  status: number
  constructor(message: string, status = 401) {
    super(message)
    this.status = status
  }
}

export interface Caller {
  id: string
  email: string | null
  role: string
  isPrivileged: boolean            // admin or asset_manager => full portfolio
  // 'all' when privileged or holding a global entitlement; otherwise the
  // explicit set of property ids the caller may read. A document with
  // property_id = null is company-wide and readable by everyone (this mirrors
  // the documents_select RLS policy in 20240009_rls.sql).
  access: 'all' | Set<string>
  // Separate WRITE scope (review #2): "may view" is not "may change". Derived
  // from entitlements.can_write, NOT the read set — a read-only grant must not
  // confer write. 'all' for privileged/service or a global can_write grant.
  writeAccess: 'all' | Set<string>
}

const bearer = (req: Request) =>
  (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()

// Trusted server-side callers (the local ingestion / batch-abstract PowerShell
// scripts) present a SERVICE credential rather than a user JWT. Possession of a
// service key already grants full DB access, so accepting it here — and ONLY it,
// never the public anon key — is consistent. Recognized values: the
// auto-injected SUPABASE_SERVICE_ROLE_KEY plus, if set as function secrets,
// SUPABASE_SECRET_KEY / EDGE_SERVICE_SECRET (so scripts can keep sending the key
// they already use). The anon key is deliberately NOT in this set.
function isServiceToken(token: string): boolean {
  const candidates = [
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    Deno.env.get('SUPABASE_SECRET_KEY'),
    Deno.env.get('EDGE_SERVICE_SECRET'),
  ].filter((v): v is string => !!v && v.length > 20)
  return candidates.includes(token)
}

// A service-role client can still validate a caller-supplied user JWT via
// getUser(token) — same pattern the admin-users function uses.
export async function requireUser(req: Request, sb: SupabaseClient): Promise<Caller> {
  const token = bearer(req)
  if (!token) throw new AuthError('Missing bearer token', 401)

  // Trusted service caller (batch/ingest scripts) → full access, no user lookup.
  if (isServiceToken(token)) {
    return { id: 'service', email: null, role: 'service', isPrivileged: true, access: 'all', writeAccess: 'all' }
  }

  const { data: { user }, error } = await sb.auth.getUser(token)
  if (error || !user) throw new AuthError('Invalid session', 401)

  const { data: prof } = await sb
    .from('users')
    .select('role, is_active, email')
    .eq('id', user.id)
    .single()
  if (!prof || prof.is_active !== true) throw new AuthError('Account is inactive', 403)

  const role = String(prof.role)
  const email = (prof.email as string | null) ?? user.email ?? null
  if (role === 'admin' || role === 'asset_manager') {
    return { id: user.id, email, role, isPrivileged: true, access: 'all', writeAccess: 'all' }
  }

  // Non-privileged: expand entitlements into SEPARATE read and write scopes.
  // can_read and can_write are distinct columns (entitlements, mig 20240008);
  // the write gate must honor can_write, not the read set (review #2). A global
  // grant confers all-read and/or all-write only for the column it actually sets.
  const { data: ents } = await sb
    .from('entitlements')
    .select('scope, property_id, portfolio_id, can_read, can_write')
    .eq('user_id', user.id)
  const rows = (ents ?? []) as Array<{ scope: string; property_id: string | null; portfolio_id: string | null; can_read: boolean; can_write: boolean }>

  // Resolve one scope set for a grant predicate (portfolio grants expand to
  // their member properties).
  const resolveScope = async (granted: (r: typeof rows[number]) => boolean): Promise<'all' | Set<string>> => {
    const grant = rows.filter(granted)
    if (grant.some(e => e.scope === 'global')) return 'all'
    const props = new Set<string>()
    for (const e of grant) if (e.scope === 'property' && e.property_id) props.add(e.property_id)
    const portfolioIds = grant.filter(e => e.scope === 'portfolio' && e.portfolio_id).map(e => e.portfolio_id as string)
    if (portfolioIds.length) {
      const { data: pp } = await sb.from('properties').select('id').in('portfolio_id', portfolioIds)
      for (const p of (pp ?? []) as Array<{ id: string }>) props.add(p.id)
    }
    return props
  }
  const access = await resolveScope(e => e.can_read === true)
  const writeAccess = await resolveScope(e => e.can_write === true)
  return { id: user.id, email, role, isPrivileged: false, access, writeAccess }
}

export async function requireAdmin(req: Request, sb: SupabaseClient): Promise<Caller> {
  const caller = await requireUser(req, sb)
  if (caller.role !== 'admin') throw new AuthError('Admin access required', 403)
  return caller
}

// CORS locked to an origin allowlist. Override with the ALLOWED_ORIGINS secret
// (comma-separated) when the production URL changes or previews need access.
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ??
  'https://cre-platform-mjw2.vercel.app,https://cre-platform-pskontos-4793-mjw2.vercel.app,http://localhost:5173')
  .split(',').map(s => s.trim()).filter(Boolean)

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Vary': 'Origin',
  }
}
