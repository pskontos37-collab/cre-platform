import { useEffect, useState } from 'react'
import { supabase } from './supabase'

// ── Firm identity as data (audit Phase 3a: de-hard-code M&J config) ──────────
// Source of truth is app_config key 'firm.identity' (admin-editable, migration
// 20240130). The literals below are only the render-first defaults and the
// fail-open fallback — consumers show them until the config row loads, so a
// missing/unreadable row exactly reproduces pre-Phase-3a behavior.
//
// Adopt in components via useFirmIdentity(); in non-React code (exports, PDF
// builders) via fetchFirmIdentity().

export interface FirmIdentity {
  name: string          // legal name, e.g. report headers
  short: string         // short form for prose
  wordmark: string      // sidebar wordmark text
  report_footer: string // confidentiality footer on branded PDFs
}

export const FIRM_DEFAULTS: FirmIdentity = {
  name: 'M&J Wilkow, Ltd.',
  short: 'Wilkow',
  wordmark: 'M&J WILKOW',
  report_footer: 'M&J Wilkow, Ltd. - Confidential',
}

let cached: FirmIdentity | null = null
let inflight: Promise<FirmIdentity> | null = null

export async function fetchFirmIdentity(): Promise<FirmIdentity> {
  if (cached) return cached
  if (!inflight) {
    inflight = (async () => {
      try {
        const { data } = await supabase.from('app_config')
          .select('value').eq('key', 'firm.identity').maybeSingle()
        cached = { ...FIRM_DEFAULTS, ...((data?.value ?? {}) as Partial<FirmIdentity>) }
      } catch {
        cached = FIRM_DEFAULTS
      }
      return cached
    })()
  }
  return inflight
}

export function useFirmIdentity(): FirmIdentity {
  const [v, setV] = useState<FirmIdentity>(cached ?? FIRM_DEFAULTS)
  useEffect(() => {
    let alive = true
    void fetchFirmIdentity().then(x => { if (alive) setV(x) })
    return () => { alive = false }
  }, [])
  return v
}
