import { useEffect, useState } from 'react'
import { supabase } from './supabase'

// ── Action-level capabilities, client side (audit Phase 3b) ──────────────────
// useCan('imports.approve') resolves the caller's effective capability via the
// can_do_action RPC (role defaults + per-user grants, migration 20240131).
// Returns null while loading — callers should only hard-disable UI on an
// explicit false; the server enforces regardless, this is UX.

export function useCan(action: string): boolean | null {
  const [v, setV] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    void supabase.rpc('can_do_action', { p_action: action }).then(({ data, error }) => {
      if (alive) setV(error ? null : data === true)
    })
    return () => { alive = false }
  }, [action])
  return v
}

export interface EffectiveAction {
  action: string
  label: string
  description: string | null
  allowed: boolean
  source: string // 'admin' | 'granted' | 'denied' | 'role default' | 'no default'
}

export async function fetchEffectiveActions(userId?: string): Promise<EffectiveAction[]> {
  const { data, error } = await supabase.rpc('effective_actions', userId ? { p_user: userId } : {})
  if (error) throw new Error(error.message)
  return (data ?? []) as EffectiveAction[]
}
