// coi-extract — parse an ACORD 25/28 certificate of insurance PDF into
// structured coverages, endorsements and dates, then (if a requirement set
// exists) match it and compute deficiencies. Upserts coi_certificates +
// coi_coverages (migration 20240082).
//
// Pipeline:
//   1. Resolve the PDF (pdf_url | document_id | storage_path in the 'documents'
//      bucket) to a signed URL.
//   2. One forced tool-use call to Claude reads the ACORD natively and returns
//      the certificate as already-parsed JSON (limits, policy numbers, dates,
//      the additional-insured / waiver / primary-&-noncontributory boxes,
//      carrier + A.M. Best).
//   3. If an insurance_requirements set governs this party, diff required vs
//      actual → deficiencies[] (Ebix-style taxonomy) + a compliance status;
//      otherwise fall back to a date-only status (expired / expiring / pending).
//   4. Upsert the coi_certificates row (update an existing / Ebix-seeded row when
//      certificate_id, ebix_vendor_num, or property+party+name matches) and
//      replace its coi_coverages child rows.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.
// POST JSON: {
//   property_id: uuid,                       // required
//   pdf_url?: string | document_id?: uuid | storage_path?: string,  // one required
//   party_type?: 'tenant'|'vendor'|'contractor',   // default 'tenant'
//   party_name?: string,                     // override the insured name parsed off the cert
//   tenant_id?: uuid, service_agreement_id?: uuid,
//   certificate_id?: uuid,                   // update this exact row
//   ebix_vendor_num?: string,
//   match?: boolean                          // default true
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

// The tool schema mirrors the ACORD 25 (liability) / 28 (property) face.
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

// Diff a parsed cert against a governing requirement set → deficiency list.
function evaluate(cert: any, coverages: any[], req: any, reqCovs: any[]): { code: string; label: string; detail?: string }[] {
  const out: { code: string; label: string; detail?: string }[] = []
  const byType = new Map<string, any>()
  for (const c of coverages) if (!byType.has(c.coverage_type)) byType.set(c.coverage_type, c)

  for (const rc of reqCovs) {
    if (rc.required === false) continue
    const cov = byType.get(rc.coverage_type)
    const nm = rc.coverage_type.toUpperCase()
    if (!cov) { out.push({ code: 'coverage_missing', label: `Missing required ${nm} coverage` }); continue }
    if (rc.min_each_occurrence != null && cov.each_occurrence != null && cov.each_occurrence < Number(rc.min_each_occurrence))
      out.push({ code: 'limit_below', label: `${nm} each-occurrence below required minimum`, detail: `${cov.each_occurrence} < ${rc.min_each_occurrence}` })
    if (rc.min_aggregate != null && cov.aggregate != null && cov.aggregate < Number(rc.min_aggregate))
      out.push({ code: 'limit_below', label: `${nm} aggregate below required minimum`, detail: `${cov.aggregate} < ${rc.min_aggregate}` })
  }

  // Endorsement checks keyed off the primary liability coverage.
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
    const propertyId: string = body.property_id ?? ''
    if (!propertyId) throw new Error('property_id is required')
    if (!canReadProperty(caller, propertyId)) throw new AuthError('No access to this property', 403)

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')

    // ── 1. Resolve the PDF to a URL Claude can read natively ──
    let pdfUrl: string = body.pdf_url ?? ''
    let documentId: string | null = body.document_id ?? null
    if (!pdfUrl) {
      let storagePath: string = body.storage_path ?? ''
      if (!storagePath && documentId) {
        const { data: doc } = await sb.from('documents').select('storage_path, property_id').eq('id', documentId).single()
        if (!doc?.storage_path) throw new Error('document has no storage_path')
        storagePath = doc.storage_path
      }
      if (!storagePath) throw new Error('one of pdf_url, document_id, storage_path is required')
      const { data: signed, error: sErr } = await sb.storage.from('documents').createSignedUrl(storagePath, 3600)
      if (sErr || !signed?.signedUrl) throw new Error('could not sign storage_path: ' + (sErr?.message ?? 'unknown'))
      pdfUrl = signed.signedUrl
    }

    // ── 2. Parse the ACORD ──
    const prompt = `You are an insurance analyst for M&J Wilkow, a commercial real estate landlord. Parse the attached ACORD certificate of insurance PDF into the submit_coi schema. Rules:
- Read EVERY coverage row present (CGL, Automobile, Umbrella/Excess, Workers Comp, Employers Liability, Property, and any others) — one entry per policy line.
- Map each to the closest "type". Use "cgl" for Commercial General Liability, "umbrella_excess" for Umbrella/Excess, "employers_liability" for the EL limits shown alongside Workers Comp (a separate entry from "workers_comp").
- Limits: "each_occurrence" = the per-occurrence / combined-single limit; "aggregate" = the general or policy aggregate. Put any other named limits (Products/Completed-Ops Agg, Personal & Adv Injury, Med Exp, EL per accident/disease, umbrella limit) into "other_limits" keyed by their ACORD label. Numbers only (no $ or commas).
- Endorsement boxes: set additional_insured / waiver_of_subrogation / primary_noncontributory per coverage from the Y/N columns or the Description of Operations text. If genuinely not indicated, use null (not false).
- Dates strictly YYYY-MM-DD. Read the exact insured name, the producer (broker) with email/phone if shown, the certificate holder, and any A.M. Best rating.
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
    const expirationDate = minDate(coverages.map(c => c.expiration_date))   // earliest lapse governs
    const partyType: string = ['tenant', 'vendor', 'contractor'].includes(body.party_type) ? body.party_type : 'tenant'
    const partyName: string = (body.party_name ?? parsed.insured?.name ?? '').trim()
    if (!partyName) throw new Error('could not determine the insured / party name')

    // ── 3b. Match against a governing requirement set, if one exists ──
    let deficiencies: { code: string; label: string; detail?: string }[] = []
    let matched = false
    if (body.match !== false) {
      const { data: reqs } = await sb.from('insurance_requirements')
        .select('*').eq('property_id', propertyId).eq('party_type', partyType).eq('active', true)
      const list = (reqs ?? []) as any[]
      // most specific first: party-scoped → property_default
      const req = list.find(r => (body.service_agreement_id && r.service_agreement_id === body.service_agreement_id) ||
                                 (r.party_name && partyName && r.party_name.toLowerCase() === partyName.toLowerCase()))
                ?? list.find(r => r.scope === 'property_default')
      if (req) {
        const { data: rc } = await sb.from('insurance_requirement_coverages').select('*').eq('requirement_id', req.id)
        deficiencies = evaluate(parsed, coverages, req, (rc ?? []) as any[])
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
    else status = 'pending'   // parsed but no requirement to judge against

    // ── 4. Upsert the certificate (update an existing/Ebix-seeded row if we can identify it) ──
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
      tenant_id: body.tenant_id ?? null,
      service_agreement_id: body.service_agreement_id ?? null,
      document_id: documentId,
      ebix_vendor_num: body.ebix_vendor_num ?? null,
      cert_type: parsed.acord_form === '28' ? 'acord28' : parsed.acord_form === '25' ? 'acord25' : 'other',
      insured_name: parsed.insured?.name ?? partyName,
      insured_address: parsed.insured?.address ?? null,
      producer_name: parsed.producer?.name ?? null,
      producer_email: parsed.producer?.email ?? null,
      producer_phone: parsed.producer?.phone ?? null,
      effective_date: effectiveDate,
      expiration_date: expirationDate,
      am_best_rating: parsed.am_best_rating ?? null,
      status,
      deficiencies,
      source: body.source === 'email_inbound' ? 'email_inbound' : 'ai_extraction',
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

    // Replace coverage child rows.
    await sb.from('coi_coverages').delete().eq('certificate_id', certId)
    if (coverages.length) {
      const { error: cErr } = await sb.from('coi_coverages').insert(coverages.map(c => ({ ...c, certificate_id: certId })))
      if (cErr) throw new Error('coverage insert failed: ' + cErr.message)
    }

    return new Response(JSON.stringify({
      success: true, certificate_id: certId, party_name: partyName, party_type: partyType,
      status, matched, deficiencies, coverages_parsed: coverages.length,
      effective_date: effectiveDate, expiration_date: expirationDate,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
