// _shared/access.ts — pure property-access decisions for edge functions.
// NO imports (Deno OR Node): imported by the Deno edge functions via auth.ts
// AND by a Vitest unit test in src/, so it must stay runtime-agnostic.
//
// Two DISTINCT questions (audit finding #5 — "may view" is not "may change"):
//   canReadProperty  — may the caller SEE this property's data?
//   canWriteProperty — may the caller MUTATE state / spend AI credits for it?
//
// Phase-0 write policy (chosen 2026-07-18): staff with access to a property may
// operate on it (generate/verify/brief/reindex — minimal behavior change for
// current users), EXCEPT:
//   - company-wide targets (null property) are writable only by callers with
//     full access ('all': service token, admin, asset_manager, global grant);
//   - the server-side ensemble auto-apply lever is hard-disabled separately.
// This function is the single choke point to tighten at the enterprise phase
// (per-action roles, entitlements.can_write) without touching every function.

export interface CallerScope {
  isPrivileged: boolean
  // 'all' when privileged or holding a global entitlement; otherwise the
  // explicit set of property ids the caller may read.
  access: 'all' | Set<string>
}

// A property is readable if the caller has full access, or the doc is
// company-wide (null property), or its property is in the caller's set.
// (Mirrors the documents_select RLS policy in 20240009_rls.sql.)
export function canReadProperty(caller: CallerScope, propertyId: string | null): boolean {
  if (caller.access === 'all') return true
  if (propertyId == null) return true
  return caller.access.has(propertyId)
}

// Mutations: full-access callers may write anywhere. Scope-limited staff may
// write only to properties they hold access to — and NOT to company-wide
// (null-property) targets, which read-side is everyone-visible but write-side
// is privileged-only.
export function canWriteProperty(caller: CallerScope, propertyId: string | null): boolean {
  if (caller.access === 'all') return true
  if (propertyId == null) return false
  return caller.access.has(propertyId)
}
