// coi-extract — parse an ACORD 25/28 certificate of insurance PDF into
// structured coverages, endorsements and dates, AUTO-ROUTE it to a property +
// party, match it against the governing requirement set, and upsert
// coi_certificates + coi_coverages (migrations 20240082/83/85).
//
// Pipeline:
//   1. Resolve the PDF (pdf_url | document_id | storage_path) to a signed URL.
//   2. One forced tool-use call to Claude reads the ACORD natively → parsed JSON
//      (limits, policy numbers, dates, additional-insured / waiver / primary-&-
//      noncontributory boxes, carrier + A.M. Best, certificate holder, insured).
//   3. ROUTING: if property_id was not supplied (folder / mailbox intake), infer
//      the property from the certificate-holder / insured text. Can't resolve or
//      ambiguous → park in coi_review_queue for human triage and stop. Party is
//      inferred from the insured name (tenant if it matches the lease roster,
//      else vendor) unless supplied.
//   4. MATCH: diff required vs actual against the governing insurance_requirements
//      → deficiencies[] (Ebix-style codes) + compliance status; no requirement →
//      date-only status.
//   5. Upsert coi_certificates (upgrading an existing / Ebix-seeded row when
//      certificate_id, ebix_vendor_num, or property+party+name matches) + replace
//      coi_coverages. If invoked with queue_id (a triage "File"), mark that queue
//      row filed.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.
// POST JSON: {
//   pdf_url? | document_id? | storage_path?,   // one required
//   property_id?,                              // omit to auto-route (privileged callers only)
//   party_type?, party_name?, tenant_id?, service_agreement_id?,
//   certificate_id?, ebix_vendor_num?, queue_id?, source?, match?
// }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canReadProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

const MODEL = Deno.env.get('COI_MODEL') ?? 'claude-sonnet-5'

const COVERAGE_TYPES = [
  'cgl', 'auto', 'umbrella_excess', 'workers_comp', 'employers_liability',
  'property', 'business_interruption', 'liquor', 'pollution', 'professional_eo',
  'builders_risk', 'garagekeepers', 'crime', 'cyber', 'other',
]

// Property routing map for the JV assets in scope. Each keyword, if found in the
// certificate-holder / insured text, votes for one property id. Distinct-id count
// decides: exactly one → route; zero → property_unresolved; >1 → ambiguous.
const ROUTE_MAP: { kw: string; id: string }[] = [
  { kw: 'midway plantation',            id: '00000000-0000-0000-0000-000000000010' }, // KM East
  { kw: 'knightdale marketplace east',  id: '00000000-0000-0000-0000-000000000010' },
  { kw: 'midtown commons',              id: '00000000-0000-0000-0000-000000000011' }, // KM West
  { kw: 'knightdale marketplace west',  id: '00000000-0000-0000-0000-000000000011' },
  { kw: 'gateway',                      id: 'd5a4ed03-0b60-4168-9208-83822dd24884' }, // Gateway Port Chester
  { kw: 'port chester',                 id: 'd5a4ed03-0b60-4168-9208-83822dd24884' },
  { kw: 'magnolia',                     id: 'd4f08824-2d88-472d-b7aa-a703310c2aaf' }, // Magnolia Park
]

const SCHEMA = `{
 "acord_form": "25"|"28"|"other",
 "insured": {"name": str, "address": str|null},
 "producer": {"name": str|null, "email": str|null, "phone": str|null},
 "certificate_holder": {"name": str|null, "address": str|null},
 "am_best_rating": str|null,
 "coverages": [{
   "type": "cgl"|"auto"|"umbrella_excess"|"workers_comp"|"employers_liability"|"property"|"business_interruption"|"liquor"|"pollution"|"professional_eo"|"builders_risk"|"garagekeepers"|"crime"|"cyber"|"other",
   "carrier": str|null, "naic": str|null, "policy_number": str|null,
   "effective_date": "YYYY-MM-DD"|null, "expiration_date": "YYYY-MM-DD"|null,
   "each_occurrence": num|null, "aggregate": num|null,
   "other_limits": {"<label>": num},
   "additional_insured": bool|null, "waiver_of_subrogation": bool|null, "primary_noncontributory": bool|null
 }],
 "notes": str|null
}`

async function anthropicJson(key: string, content: any[], maxTokens: number): Promise<any> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens,
      tools: [{ name: 'submit_coi', description: 'Submit the parsed certificate of insurance.', input_schema: { type: 'object', additionalProperties: true } }],
      tool_choice: { type: 'tool', name: 'submit_coi' },
      messages: [{ role: 'user', content }],
    }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Anthropic API error: ' + JSON.stringify(d))
  if (d.stop_reason === 'max_tokens') throw new Error('COI extract truncated at max_tokens')
  const block = (d.content ?? []).find((c: { type: string }) => c.type === 'tool_use')
  if (!block) throw new Error('Model returned no tool_use block')
  return block.input
}

const num = (v: unknown): number | null => {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}
const isoDate = (v: unknown): string | null => {
  const s = String(v ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}
const minDate = (ds: (string | null)[]): string | null => {
  const xs = ds.filter((d): d is string => !!d).sort()
  return xs.length ? xs[0] : null
}
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

// Infer the property from the cert-holder + insured text via ROUTE_MAP votes.
function routeProperty(parsed: any): { propertyId: string | null; reason: string } {
  const text = [parsed.certificate_holder?.name, parsed.certificate_holder?.address, parsed.insured?.address]
    .filter(Boolean).join(' ').toLowerCase()
  const ids = new Set<string>()
  for (const r of ROUTE_MAP) if (text.includes(r.kw)) ids.add(r.id)
  if (ids.size === 1) return { propertyId: [...ids][0], reason: 'routed' }
  if (ids.size > 1) return { propertyId: null, reason: 'ambiguous_property' }
  return { propertyId: null, reason: 'property_unresolved' }
}

// Classify the insured as a tenant (matched to the property's lease roster) or a
// vendor. Returns tenant_id when a lease row matches.
async function classifyParty(sb: any, propertyId: string, insured: string): Promise<{ type: string; tenantId: string | null }> {
  const n = norm(insured)
  if (n.length < 4) return { type: 'vendor', tenantId: null }
  const { data } = await sb.from('leases').select('tenant_id, tenants(id, name, trade_name)').eq('property_id', propertyId)
  for (const r of (data ?? []) as any[]) {
    for (const nm of [r.tenants?.name, r.tenants?.trade_name]) {
      const k = norm(nm)
      if (k.length >= 4 && (k === n || (k.length >= 5 && (n.includes(k) || k.includes(n)))))
        return { type: 'tenant', tenantId: r.tenants?.id ?? r.tenant_id ?? null }
    }
  }
  return { type: 'vendor', tenantId: null }
}

function evaluate(cert: any, coverages: any[], req: any, reqCovs: any[]): { code: string; label: string; detail?: string }[] {
  const out: { code: string; label: string; detail?: string }[] = []
  const byType = new Map<string, any>()
  for (const c of coverages) if (!byType.has(c.coverage_type)) byType.set(c.coverage_type, c)
  for (const rc of reqCovs) {
    if (rc.required === false) continue
    const cov = byType.get(rc.coverage_type)
    const nm = String(rc.coverage_type).toUpperCase()
    if (!cov) { out.push({ code: 'coverage_missing', label: `Missing required ${nm} coverage` }); continue }
    if (rc.min_each_occurrence != null && cov.each_occurrence != null && cov.each_occurrence < Number(rc.min_each_occurrence))
      out.push({ code: 'limit_below', label: `${nm} each-occurrence below required minimum`, detail: `${cov.each_occurrence} < ${rc.min_each_occurrence}` })
    if (rc.min_aggregate != null && cov.aggregate != null && cov.aggregate < Number(rc.min_aggregate))
      out.push({ code: 'limit_below', label: `${nm} aggregate below required minimum`, detail: `${cov.aggregate} < ${rc.min_aggregate}` })
  }
  const cgl = byType.get('cgl') ?? byType.get('umbrella_excess')
  if (req.additional_insureds?.length || req.requires_primary_noncontrib || req.requires_waiver_subrogation) {
    if (cgl && cgl.additional_insured === false) out.push({ code: 'not_additional_insured', label: 'Not properly named as an Additional Insured' })
    if (req.requires_primary_noncontrib && cgl && cgl.primary_noncontrib === false) out.push({ code: 'not_primary_noncontrib', label: 'Coverage is not Primary & Non-Contributory' })
    if (req.requires_waiver_subrogation && cgl && cgl.waiver_subrogation === false) out.push({ code: 'no_waiver', label: 'Missing Waiver of Subrogation' })
  }
  if (req.min_am_best_rating && !cert.am_best_rating) out.push({ code: 'am_best_unknown', label: `A.M. Best rating not shown (requires ${req.min_am_best_rating})` })
  return out
}

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const caller = await requireUser(req, sb)

    const body = await req.json().catch(() => ({}))
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')

    let propertyId: string | null = body.property_id ?? null
    if (propertyId && !canReadProperty(caller, propertyId)) throw new AuthError('No access to this property', 403)
    // Auto-routing (no property_id) is cross-property, so it's privileged-only.
    if (!propertyId && !caller.isPrivileged) throw new AuthError('property_id is required for your role', 403)

    // ── 1. Resolve the PDF ──
    let pdfUrl: string = body.pdf_url ?? ''
    const documentId: string | null = body.document_id ?? null
    const storagePath: string = body.storage_path ?? ''
    if (!pdfUrl) {
      let sp = storagePath
      if (!sp && documentId) {
        const { data: doc } = await sb.from('documents').select('storage_path').eq('id', documentId).single()
        if (!doc?.storage_path) throw new Error('document has no storage_path')
        sp = doc.storage_path
      }
      if (!sp) throw new Error('one of pdf_url, document_id, storage_path is required')
      const { data: signed, error: sErr } = await sb.storage.from('documents').createSignedUrl(sp, 3600)
      if (sErr || !signed?.signedUrl) throw new Error('could not sign storage_path: ' + (sErr?.message ?? 'unknown'))
      pdfUrl = signed.signedUrl
    }

    // ── 2. Parse the ACORD ──
    const prompt = `You are an insurance analyst for M&J Wilkow, a commercial real estate landlord. Parse the attached ACORD certificate of insurance PDF into the submit_coi schema. Rules:
- Read EVERY coverage row present (CGL, Automobile, Umbrella/Excess, Workers Comp, Employers Liability, Property, and any others) — one entry per policy line.
- Map each to the closest "type". Use "cgl" for Commercial General Liability, "umbrella_excess" for Umbrella/Excess, "employers_liability" for the EL limits shown alongside Workers Comp (a separate entry from "workers_comp").
- Limits: "each_occurrence" = per-occurrence / combined-single limit; "aggregate" = general or policy aggregate. Put other named limits (Products/Completed-Ops Agg, Personal & Adv Injury, Med Exp, EL per accident/disease, umbrella limit) into "other_limits" keyed by their ACORD label. Numbers only (no $ or commas).
- Endorsement boxes: set additional_insured / waiver_of_subrogation / primary_noncontributory per coverage from the Y/N columns or the Description of Operations text. If genuinely not indicated, use null (not false).
- Dates strictly YYYY-MM-DD. Read the exact insured name, producer (broker) with email/phone, the CERTIFICATE HOLDER name + address (used to identify the property), and any A.M. Best rating.
- Do NOT invent values not on the certificate; use null.
Call submit_coi with an object matching exactly:
${SCHEMA}`

    const parsed = await anthropicJson(anthropicKey, [
      { type: 'document', source: { type: 'url', url: pdfUrl } },
      { type: 'text', text: prompt },
    ], 4000)

    // ── 3. Normalize ──
    const rawCovs: any[] = Array.isArray(parsed.coverages) ? parsed.coverages : []
    const coverages = rawCovs.map((c) => ({
      coverage_type: COVERAGE_TYPES.includes(c.type) ? c.type : 'other',
      carrier: c.carrier ?? null,
      am_best_rating: null,
      policy_number: c.policy_number ?? null,
      effective_date: isoDate(c.effective_date),
      expiration_date: isoDate(c.expiration_date),
      each_occurrence: num(c.each_occurrence),
      aggregate: num(c.aggregate),
      other_limits: c.other_limits && typeof c.other_limits === 'object' ? c.other_limits : null,
      additional_insured: typeof c.additional_insured === 'boolean' ? c.additional_insured : null,
      waiver_subrogation: typeof c.waiver_of_subrogation === 'boolean' ? c.waiver_of_subrogation : null,
      primary_noncontrib: typeof c.primary_noncontributory === 'boolean' ? c.primary_noncontributory : null,
    }))
    const effectiveDate = minDate(coverages.map(c => c.effective_date))
    const expirationDate = minDate(coverages.map(c => c.expiration_date))
    const insuredName: string = (parsed.insured?.name ?? '').trim()

    // ── 3b. Route to a property when not supplied ──
    if (!propertyId) {
      const r = routeProperty(parsed)
      if (!r.propertyId) {
        // Park for human triage instead of guessing.
        const { data: q, error: qErr } = await sb.from('coi_review_queue').insert({
          storage_path: storagePath || null,
          document_id: documentId,
          cert_type: parsed.acord_form === '28' ? 'acord28' : parsed.acord_form === '25' ? 'acord25' : 'other',
          insured_name: insuredName || null,
          producer_name: parsed.producer?.name ?? null,
          effective_date: effectiveDate,
          expiration_date: expirationDate,
          suggested_party_name: insuredName || null,
          reason: r.reason,
          raw_extract: parsed,
          coverages,
          source: body.source === 'email_inbound' ? 'email_inbound' : body.source === 'folder' ? 'folder' : 'ai_extraction',
        }).select('id').single()
        if (qErr) throw new Error('queue insert failed: ' + qErr.message)
        return new Response(JSON.stringify({
          success: true, queued: true, review_id: q!.id, reason: r.reason,
          insured_name: insuredName, coverages_parsed: coverages.length,
        }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      propertyId = r.propertyId
    }

    // ── 3c. Party ──
    let partyType: string = ['tenant', 'vendor', 'contractor'].includes(body.party_type) ? body.party_type : ''
    let tenantId: string | null = body.tenant_id ?? null
    const partyName: string = (body.party_name ?? insuredName).trim()
    if (!partyName) throw new Error('could not determine the insured / party name')
    if (!partyType) {
      const cls = await classifyParty(sb, propertyId, partyName)
      partyType = cls.type
      if (!tenantId) tenantId = cls.tenantId
    }

    // ── 3d. Match against the governing requirement set ──
    let deficiencies: { code: string; label: string; detail?: string }[] = []
    let matched = false
    if (body.match !== false) {
      const { data: reqs } = await sb.from('insurance_requirements')
        .select('*').eq('property_id', propertyId).eq('party_type', partyType).eq('active', true)
      const list = (reqs ?? []) as any[]
      const reqRow = list.find(r => (body.service_agreement_id && r.service_agreement_id === body.service_agreement_id) ||
                                    (r.party_name && r.party_name.toLowerCase() === partyName.toLowerCase()))
                  ?? list.find(r => r.scope === 'property_default')
      if (reqRow) {
        const { data: rc } = await sb.from('insurance_requirement_coverages').select('*').eq('requirement_id', reqRow.id)
        deficiencies = evaluate(parsed, coverages, reqRow, (rc ?? []) as any[])
        matched = true
      }
    }

    const today = new Date().toISOString().slice(0, 10)
    const daysUntil = expirationDate ? Math.round((Date.parse(expirationDate) - Date.parse(today)) / 86400000) : null
    let status: string
    if (expirationDate && expirationDate < today) status = 'expired'
    else if (deficiencies.length) status = 'deficient'
    else if (daysUntil != null && daysUntil <= 60) status = 'expiring'
    else if (matched) status = 'compliant'
    else status = 'pending'

    // ── 4. Upsert the certificate ──
    let certId: string | null = body.certificate_id ?? null
    if (!certId && body.ebix_vendor_num) {
      const { data: ex } = await sb.from('coi_certificates').select('id').eq('property_id', propertyId).eq('ebix_vendor_num', body.ebix_vendor_num).limit(1)
      certId = (ex?.[0]?.id as string) ?? null
    }
    if (!certId) {
      const { data: ex } = await sb.from('coi_certificates').select('id')
        .eq('property_id', propertyId).eq('party_type', partyType).ilike('party_name', partyName).limit(1)
      certId = (ex?.[0]?.id as string) ?? null
    }

    const row: Record<string, unknown> = {
      property_id: propertyId,
      party_type: partyType,
      party_name: partyName,
      tenant_id: tenantId,
      service_agreement_id: body.service_agreement_id ?? null,
      document_id: documentId,
      ebix_vendor_num: body.ebix_vendor_num ?? null,
      cert_type: parsed.acord_form === '28' ? 'acord28' : parsed.acord_form === '25' ? 'acord25' : 'other',
      insured_name: insuredName || partyName,
      insured_address: parsed.insured?.address ?? null,
      producer_name: parsed.producer?.name ?? null,
      producer_email: parsed.producer?.email ?? null,
      producer_phone: parsed.producer?.phone ?? null,
      effective_date: effectiveDate,
      expiration_date: expirationDate,
      am_best_rating: parsed.am_best_rating ?? null,
      status,
      deficiencies,
      source: body.source === 'email_inbound' ? 'email_inbound' : body.source === 'folder' ? 'ai_extraction' : (body.source === 'manual' ? 'manual' : 'ai_extraction'),
      raw_extract: parsed,
      updated_at: today,
    }

    if (certId) {
      const { error } = await sb.from('coi_certificates').update(row).eq('id', certId)
      if (error) throw new Error('update failed: ' + error.message)
    } else {
      const { data: ins, error } = await sb.from('coi_certificates').insert(row).select('id').single()
      if (error) throw new Error('insert failed: ' + error.message)
      certId = ins!.id as string
    }

    await sb.from('coi_coverages').delete().eq('certificate_id', certId)
    if (coverages.length) {
      const { error: cErr } = await sb.from('coi_coverages').insert(coverages.map(c => ({ ...c, certificate_id: certId })))
      if (cErr) throw new Error('coverage insert failed: ' + cErr.message)
    }

    // If this run resolved a queued item, mark it filed.
    if (body.queue_id) {
      await sb.from('coi_review_queue').update({
        status: 'filed', resolved_by: caller.id === 'service' ? null : caller.id, resolved_at: new Date().toISOString(),
      }).eq('id', body.queue_id)
    }

    return new Response(JSON.stringify({
      success: true, certificate_id: certId, property_id: propertyId, party_name: partyName, party_type: partyType,
      status, matched, deficiencies, coverages_parsed: coverages.length,
      effective_date: effectiveDate, expiration_date: expirationDate,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
