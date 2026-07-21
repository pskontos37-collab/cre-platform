// generate-recurring-events — P1f-b. Materializes recurring management-agreement
// obligations (management_agreement_deadlines) into the critical_events ledger,
// using the pure recurrence engine (_shared/recurrence). A parseable schedule
// gets a dated 'operational' event (next occurrence on/after the as-of date); an
// underspecified one ("within 90 days of agreement", "per owner schedule") gets a
// dateless 'informational' event so the obligation is still visible rather than
// silently dropped. Idempotent per deadline (dedupe_key); NEVER un-resolves a
// human decision on re-run.
//
// Portfolio-wide materialization → full-write callers only (service/admin). The
// deterministic date math lives in _shared/recurrence.ts (golden-tested in src/).
//
// POST { as_of?: 'YYYY-MM-DD' } (defaults to today, UTC).

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canWriteProperty, corsHeaders, requireUser } from '../_shared/auth.ts'
import { parseRecurrence, nextOccurrence } from '../_shared/recurrence.ts'

const RESOLVED = new Set(['completed', 'waived', 'not_applicable'])

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const caller = await requireUser(req, sb)
    if (!canWriteProperty(caller, null)) throw new AuthError('Not permitted to materialize recurring events', 403)

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    const asOf = typeof body.as_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.as_of)
      ? body.as_of
      : new Date().toISOString().slice(0, 10)

    // Current agreements only, then their deadlines.
    const { data: ags, error: aErr } = await sb.from('management_agreements').select('id').eq('is_current', true)
    if (aErr) throw new Error('load agreements failed: ' + aErr.message)
    const agreementIds = ((ags ?? []) as Array<{ id: string }>).map(a => a.id)
    if (!agreementIds.length) {
      return new Response(JSON.stringify({ success: true, as_of: asOf, total: 0, dated: 0, informational: 0 }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    const { data: rows, error: dErr } = await sb.from('management_agreement_deadlines')
      .select('id, agreement_id, property_id, kind, label, frequency, due_rule')
      .in('agreement_id', agreementIds)
    if (dErr) throw new Error('load deadlines failed: ' + dErr.message)

    const now = new Date().toISOString()
    let dated = 0, informational = 0
    const events = ((rows ?? []) as any[]).map(d => {
      const spec = parseRecurrence(d.frequency, d.due_rule)
      const computed = spec ? nextOccurrence(spec, asOf) : null
      const parseable = computed != null
      if (parseable) dated++; else informational++
      return {
        property_id: d.property_id ?? null,
        management_agreement_id: d.agreement_id,
        event_type: 'recurring_obligation',
        obligation_class: parseable ? 'operational' : 'informational',
        title: d.label ?? `${d.kind ?? 'Recurring'} obligation`,
        description: `Recurs ${d.frequency ?? '(unspecified)'}${d.due_rule ? ` — ${d.due_rule}` : ''}`.trim(),
        computed_date: computed,
        trigger_event: 'recurring schedule',
        formula: parseable
          ? `next ${d.frequency} occurrence on/after ${asOf}`
          : `schedule not machine-derivable from "${d.due_rule ?? ''}"`,
        computation_version: 'recurrence@2026-07-19',
        status: 'open',
        generated_by: 'deterministic',
        dedupe_key: `mad:${d.id}:recurring`,
        updated_at: now,
      }
    })

    // Preserve human resolutions: never overwrite a deadline event a human has
    // completed/waived/marked N/A. (Per-occurrence advancement after completion
    // is a later refinement; for now a resolved recurring row stays put.)
    const keys = events.map(e => e.dedupe_key)
    const { data: existing } = await sb.from('critical_events').select('dedupe_key, status').in('dedupe_key', keys)
    const resolved = new Set(((existing ?? []) as Array<{ dedupe_key: string; status: string }>)
      .filter(r => RESOLVED.has(r.status)).map(r => r.dedupe_key))
    const toWrite = events.filter(e => !resolved.has(e.dedupe_key))

    if (toWrite.length) {
      const { error: upErr } = await sb.from('critical_events').upsert(toWrite, { onConflict: 'dedupe_key' })
      if (upErr) throw new Error('upsert failed: ' + upErr.message)
    }

    return new Response(JSON.stringify({
      success: true, as_of: asOf, total: events.length, dated, informational,
      written: toWrite.length, skipped_resolved: events.length - toWrite.length,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
