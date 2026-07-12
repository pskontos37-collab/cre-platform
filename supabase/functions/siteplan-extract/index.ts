// siteplan-extract — auto-position suites on a centre-wide site plan.
//
// The user accepted auto-positioning (Claude vision) instead of hand-tracing:
// this function sends the site-plan PDF to a vision model and asks it to read
// every labelled suite/space off the plan and return a NORMALISED [0,1] bounding
// box for each, plus the suite id and any tenant name printed inside it. We then
// reconcile each read suite to the property's latest rent-roll suite (so the map
// can colour it by live occupancy / expiry / A/R) and write site_plan_regions.
//
// Boxes from a vision model are approximate by nature — that's the accepted
// trade-off. The suite labels + reconciliation are the durable value; a suite
// that doesn't reconcile still renders as a hotspot. Manual (source='manual')
// regions are preserved; only prior 'vision' regions for this doc are replaced.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.
// Usage: POST JSON { property_id: uuid, document_id: uuid }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canReadProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

const MODEL = Deno.env.get('SITEPLAN_MODEL') ?? 'claude-opus-4-8'

const SCHEMA = `{
 "tenants_seen": [str],          // STEP 1 — first list EVERY tenant/suite label you can read anywhere on the plan
 "regions": [{                   // STEP 2 — then one entry per suite, with its box
   "page": int,                 // 1-based page the suite appears on
   "suite_label": str,          // suite/space id printed on the plan (e.g. "A01", "D3", "220"); "" if none
   "tenant_label": str,         // tenant/business name printed in that suite; "" if blank/vacant/unlabelled
   "vacant": bool,              // true if the suite reads as vacant/available
   "x": number, "y": number,    // TOP-LEFT of the suite's box, normalised 0..1 (x=left/width, y=top/height)
   "w": number, "h": number,    // width & height of the box, normalised 0..1
   "confidence": number         // 0..1, your confidence in this box + label
 }]
}`

async function anthropicJson(key: string, model: string, content: any[], maxTokens: number): Promise<any> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      tools: [{
        name: 'submit_regions',
        description: 'Submit the suite regions read off the site plan.',
        input_schema: { type: 'object', additionalProperties: true },
      }],
      tool_choice: { type: 'tool', name: 'submit_regions' },
      messages: [{ role: 'user', content }],
    }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Anthropic API error: ' + JSON.stringify(d))
  if (d.stop_reason === 'max_tokens') throw new Error('Region list truncated at max_tokens — retry')
  const block = (d.content ?? []).find((c: { type: string }) => c.type === 'tool_use')
  if (!block) throw new Error('Model returned no tool_use block')
  return block.input
}

function normSuite(s?: string | null): string {
  const raw = (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const m = raw.match(/^([A-Z]*)0*(\d+)$/)
  return m ? m[1] + m[2] : raw
}

const clamp01 = (n: unknown): number => {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const caller = await requireUser(req, sb)

    const body = await req.json().catch(() => ({}))
    const propertyId: string = body.property_id ?? ''
    const documentId: string = body.document_id ?? ''
    if (!propertyId || !documentId) throw new Error('property_id and document_id are required')
    if (!canReadProperty(caller, propertyId)) throw new AuthError('No access to this property', 403)
    // Writing regions mirrors the table's write policy (admin / asset_manager).
    if (!caller.isPrivileged) throw new AuthError('Auto-mapping requires asset-manager access', 403)

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')

    // ── 1. The site-plan document ──
    const { data: doc, error: dErr } = await sb.from('documents')
      .select('id, property_id, doc_type, title, file_name, storage_path, file_size_bytes')
      .eq('id', documentId).maybeSingle()
    if (dErr) throw new Error('document load failed: ' + dErr.message)
    if (!doc) throw new Error('Site-plan document not found')
    if (doc.property_id !== propertyId) throw new Error('Document does not belong to this property')
    if (typeof doc.storage_path !== 'string' || !doc.storage_path.startsWith('p/')) {
      throw new Error('This site plan has no stored PDF to analyse')
    }
    const sz = Number(doc.file_size_bytes)
    if (sz > 0 && sz > 24_000_000) throw new Error('Site-plan PDF is too large to analyse (>24MB)')

    const { data: signed, error: sErr } = await sb.storage.from('documents')
      .createSignedUrl(doc.storage_path, 3600)
    if (sErr || !signed?.signedUrl) throw new Error('Could not sign the site-plan PDF')

    // ── 2. Vision read ──
    const prompt = `You are reading a commercial shopping-centre SITE PLAN (a leasing/tenant-directory map) for M&J Wilkow. Identify every labelled tenant suite / retail space drawn on the plan and return a bounding box for each.

Work in two steps. STEP 1: read the plan carefully and fill "tenants_seen" with EVERY tenant name and suite/space id you can see anywhere on the map (this forces you to actually look). STEP 2: for each one, add a region with its bounding box.

Rules:
- One region per distinct suite/space footprint on the plan. Skip pure legend/logo/title-block text, parking fields, roads, and the tenant-list table if one is printed alongside the map (only box the SHAPES on the map itself).
- suite_label = the space/suite id printed on or beside the unit (e.g. "A01", "D3", "Pad 2", "220"). If the unit only shows a tenant name and no id, set suite_label to "".
- tenant_label = the business name printed inside/at the unit; "" if the unit is blank, says vacant/available, or is unlabelled. Set vacant=true when it reads vacant/available.
- Coordinates are NORMALISED to the page: x,y is the TOP-LEFT corner (x = left ÷ page width, y = top ÷ page height), w,h are the box width/height ÷ page dimensions. All four in [0,1]. Give your best visual estimate — approximate is fine.
- page is the 1-based page index the suite is drawn on.
- Return every suite you can read. Do not invent suites that aren't on the plan.

Call submit_regions with an object matching this schema exactly:
${SCHEMA}

Site plan: "${doc.title ?? doc.file_name}".`

    const out = await anthropicJson(
      anthropicKey, MODEL,
      [{ type: 'document', source: { type: 'url', url: signed.signedUrl } }, { type: 'text', text: prompt }],
      12000,
    )
    const raw: any[] = Array.isArray(out?.regions) ? out.regions : []

    // ── 3. Reconcile suites to the latest rent roll ──
    const { data: snaps } = await sb.from('rent_roll_snapshots')
      .select('id, period_year, period_month')
      .eq('property_id', propertyId)
      .order('period_year', { ascending: false })
      .order('period_month', { ascending: false })
      .limit(1)
    const snapId = (snaps ?? [])[0]?.id ?? null
    const rrBySuite = new Map<string, { suite: string; unit_id: string | null }>()
    if (snapId) {
      const { data: rr } = await sb.from('rent_roll_rows')
        .select('suite, unit_id').eq('snapshot_id', snapId)
      for (const r of (rr ?? []) as any[]) {
        const ns = normSuite(r.suite)
        if (ns && !rrBySuite.has(ns)) rrBySuite.set(ns, { suite: r.suite, unit_id: r.unit_id ?? null })
      }
    }

    const rows = raw
      .filter(r => (r.w ?? 0) > 0 && (r.h ?? 0) > 0)
      .map(r => {
        const ns = normSuite(r.suite_label)
        const match = ns ? rrBySuite.get(ns) : undefined
        return {
          document_id: documentId,
          property_id: propertyId,
          page: Math.max(1, Math.round(Number(r.page) || 1)),
          x: clamp01(r.x), y: clamp01(r.y), w: clamp01(r.w), h: clamp01(r.h),
          suite_label: (r.suite_label ?? '').toString().slice(0, 40) || null,
          tenant_label: (r.tenant_label ?? '').toString().slice(0, 200) || null,
          unit_id: match?.unit_id ?? null,
          rr_suite: match?.suite ?? null,
          confidence: Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : null,
          source: 'vision',
        }
      })

    // ── 4. Replace prior vision regions (keep manual ones) ──
    const { error: delErr } = await sb.from('site_plan_regions')
      .delete().eq('document_id', documentId).eq('source', 'vision')
    if (delErr) throw new Error('clear prior regions failed: ' + delErr.message)
    if (rows.length) {
      const { error: insErr } = await sb.from('site_plan_regions').insert(rows)
      if (insErr) throw new Error('insert regions failed: ' + insErr.message)
    }

    const matched = rows.filter(r => r.rr_suite).length
    return new Response(JSON.stringify({
      success: true, document_id: documentId, property_id: propertyId,
      regions: rows.length, matched,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
