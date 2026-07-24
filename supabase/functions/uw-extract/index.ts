// uw-extract — SERVER-SIDE underwriting extraction from ALREADY-MIRRORED storage
// docs, so it is not hostage to the interactive Windows weekly task (task #26).
//
// This is the storage-only half of the extraction pipeline. Steps that need the
// K:\ file server or Excel/qpdf COM (mirror, model->PDF print, site-plan raster)
// STAY LOCAL in scripts/. Everything here reads a doc already in the `documents`
// storage bucket and calls Claude — no file-server access required.
//
// SCOPE (v1): the T-12 recoverable-OpEx split (controllable CAM vs uncapped tax +
// insurance) that feeds NNN recoveries in the Underwriting tab. Mirrors
// scripts/extract_t12.ps1 exactly (same schema, guardrails, split, audit comment).
// enrich_deals (OM facts) and extract_underwriting (returns) can follow the same
// pattern in later versions.
//
// Invocation:
//   - pg_cron -> pg_net POST with Authorization: Bearer <service-role key> (from
//     Vault). requireUser accepts the service token as privileged.
//   - or a privileged staff user from the app.
//   Body: { dealId?: string, force?: boolean }. No dealId => batch over active
//   tenant-model deals missing a recoverable-OpEx figure.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, corsHeaders, requireUser } from '../_shared/auth.ts'

const MODEL = Deno.env.get('UW_EXTRACT_MODEL') ?? 'claude-sonnet-5'
const REC_CEIL = 60.0   // recoverable OpEx (CAM+tax+ins) never exceeds ~$60/SF/yr; above = mis-parsed total
const NON_CEIL = 30.0   // non-recoverable (mgmt+G&A) ceiling
const ACTIVE_STAGES = ['sourced', 'screening', 'underwriting', 'loi', 'under_contract', 'dd', 'ic_approval', 'closing']

const SCHEMA = `{"gla_sf":num|null,"recoverable_opex_psf":num|null,"non_recoverable_opex_psf":num|null,"tax_insurance_psf":num|null,"recoverable_opex_total":num|null,"non_recoverable_opex_total":num|null,"tax_insurance_total":num|null,"total_opex":num|null,"effective_gross_income":num|null,"period":str|null,"confidence":"high"|"medium"|"low"|null,"note":str|null}`

function instructions(dealName: string, today: string): string {
  return `You are an acquisitions analyst at M&J Wilkow. The attached PDF is the T-12 / trailing operating statement for the deal: ${dealName}. Extract the annual operating expenses split into RECOVERABLE vs NON-RECOVERABLE for a bottoms-up underwrite. Today is ${today}.

Definitions:
- RECOVERABLE (reimbursable under NNN leases): CAM, repairs & maintenance, common-area utilities, landscaping, snow, security, parking-lot, management fee IF the leases reimburse it, real estate TAXES, and property INSURANCE. This TOTAL recoverable pool splits into:
    * CONTROLLABLE recoverable = CAM / R&M / utilities / landscaping / security / mgmt fee (landlord controls; subject to recovery caps and admin fees).
    * NON-CONTROLLABLE recoverable = real estate TAXES + property INSURANCE only (pass-throughs; not capped, no admin fee).
- NON-RECOVERABLE (landlord's own cost): asset/portfolio management fee not billed to tenants, general & administrative, professional/legal/audit, non-reimbursable owner costs, leasing costs. Do NOT include capital expenditures, TI, leasing commissions, or debt service.

Rules:
- Report ANNUAL figures for the trailing-12 period. *_total are dollar totals; *_psf are totals / building GLA ($/SF/yr). If GLA is unknown give totals and leave PSF null.
- tax_insurance_psf / tax_insurance_total = the tax + insurance portion of the recoverable pool ONLY (must be <= recoverable_opex). If not separated, leave null.
- gla_sf = building SF if stated (else null). total_opex = all operating expenses (recoverable + non-recoverable, excluding capital). effective_gross_income = revenue net of vacancy if shown. period = trailing label if shown.
- EXTRACT ONLY what the statement shows; null for anything absent. Do NOT invent. confidence reflects how cleanly recoverable is separable.
- note = one short line on how you classified.
- Call report_t12 with an object matching exactly (all keys present):
${SCHEMA}`
}

async function anthropicT12(key: string, signedUrl: string, dealName: string, today: string): Promise<any> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1500,
      tools: [{ name: 'report_t12', description: 'Report the extracted operating expenses.', input_schema: { type: 'object', additionalProperties: true } }],
      tool_choice: { type: 'tool', name: 'report_t12' },
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'url', url: signedUrl } },
        { type: 'text', text: instructions(dealName, today) },
      ] }],
    }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Anthropic API error: ' + JSON.stringify(d))
  const block = (d.content ?? []).find((c: { type: string }) => c.type === 'tool_use')
  if (!block) throw new Error('Model returned no tool_use block')
  return block.input
}

// verify_jwt=true means the platform gateway has already validated the JWT
// signature before this code runs, so a decoded role claim is trustworthy. The
// cron sends the project service_role key; that JWT is a validly-signed
// service_role token but not necessarily byte-identical to the function's
// injected SUPABASE_SERVICE_ROLE_KEY (so requireUser's exact-match service check
// misses it). Trust the role claim for the cron; staff users still go through
// requireUser below.
function bearerRole(req: Request): string | null {
  const tok = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const parts = tok.split('.')
  if (parts.length !== 3) return null
  try {
    const b = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(b + '='.repeat((4 - b.length % 4) % 4)))
    return typeof payload.role === 'string' ? payload.role : null
  } catch { return null }
}

// Prefer the stated PSF when plausible, else total / GLA; repair mis-parsed totals.
function resolvePsf(psf: unknown, total: unknown, gla: number, ceil: number): number {
  let p = typeof psf === 'number' ? psf : 0
  const t = typeof total === 'number' ? total : 0
  if ((p <= 0 || p > ceil) && t > 0 && gla > 0) p = t / gla
  if (p < 0 || p > ceil) return 0
  return Math.round(p * 100) / 100
}

// Newest 4-digit year (20xx) in a doc's title/filename; 0 if none.
function docYear(doc: { title?: string | null; file_name?: string | null }): number {
  const s = `${doc.title ?? ''} ${doc.file_name ?? ''}`
  const yrs = [...s.matchAll(/20\d\d/g)].map(m => parseInt(m[0], 10)).filter(y => y <= 2099)
  return yrs.length ? Math.max(...yrs) : 0
}

interface DocRow { role: string; documents: { id: string; title: string | null; file_name: string | null; storage_path: string | null; file_size_bytes: number | null } }

/** Pick the operating-statement PDF the way extract_t12.ps1 does. */
function pickStatement(rows: DocRow[]): DocRow['documents'] | null {
  const isPdf = (d: DocRow['documents']) => !!d.storage_path && /\.pdf$/i.test(d.file_name ?? '')
  const nameOf = (d: DocRow['documents']) => `${d.title ?? ''} ${d.file_name ?? ''}`
  let cand = rows.filter(r => r.role === 'operating_statement' && isPdf(r.documents)).map(r => r.documents)
  if (!cand.length) {
    cand = rows.filter(r => r.role === 'financials' && isPdf(r.documents)
      && /t-?12|trailing|operating\s*stmt|operating\s*statement|income\s*statement|profit.*loss|p&l|cash\s*flow/i.test(nameOf(r.documents))).map(r => r.documents)
  }
  if (!cand.length) {
    cand = rows.filter(r => r.role === 'other' && isPdf(r.documents)
      && /income\s*statement|p&l|profit.*loss|t-?12|trailing|operating\s*statement/i.test(nameOf(r.documents))
      && !/offering|memorandum|\bom\b|sales|rent\s*roll|survey|warranty|easement|overview|guidance|site\s*plan/i.test(nameOf(r.documents))).map(r => r.documents)
  }
  if (!cand.length) return null
  // newest-year first; size breaks ties
  cand.sort((a, b) => (docYear(b) - docYear(a)) || ((b.file_size_bytes ?? 0) - (a.file_size_bytes ?? 0)))
  return cand[0]
}

interface DealRow { id: string; name: string; gla_sf: number | null; underwriting_model: any }

async function processDeal(sb: SupabaseClient, anthropicKey: string, deal: DealRow, force: boolean, today: string): Promise<string> {
  const uwm = deal.underwriting_model
  if (!uwm || uwm.mode !== 'tenant') return `${deal.name}: no tenant model (run extract_rent_roll first)`
  const curRec = typeof uwm.opex?.recoverableOpexPsf === 'number' ? uwm.opex.recoverableOpexPsf : 0
  if (!force && curRec > 0) return `${deal.name}: recoverable OpEx already set ($${curRec}/sf)`

  const { data: rows } = await sb.from('pipeline_deal_documents')
    .select('role, documents(id,title,file_name,storage_path,file_size_bytes)')
    .eq('deal_id', deal.id).in('role', ['operating_statement', 'financials', 'other'])
  const doc = pickStatement((rows ?? []) as unknown as DocRow[])
  if (!doc || !doc.storage_path) return `${deal.name}: no operating statement in storage`

  const { data: signed, error: sErr } = await sb.storage.from('documents').createSignedUrl(doc.storage_path, 3600)
  if (sErr || !signed?.signedUrl) return `${deal.name}: could not sign '${doc.title}'`

  let r: any
  try { r = await anthropicT12(anthropicKey, signed.signedUrl, deal.name, today) }
  catch (e) { return `${deal.name}: extraction failed — ${e instanceof Error ? e.message : String(e)}` }

  const gla = (typeof r.gla_sf === 'number' && r.gla_sf > 0) ? r.gla_sf
    : (typeof uwm.glaSf === 'number' && uwm.glaSf > 0) ? uwm.glaSf
    : (typeof deal.gla_sf === 'number' && deal.gla_sf > 0) ? deal.gla_sf : 0
  if (gla <= 0) return `${deal.name}: no GLA known; cannot derive PSF`

  let recPsf = resolvePsf(r.recoverable_opex_psf, r.recoverable_opex_total, gla, REC_CEIL)
  let nonPsf = resolvePsf(r.non_recoverable_opex_psf, r.non_recoverable_opex_total, gla, NON_CEIL)
  if (recPsf <= 0 && typeof r.total_opex === 'number' && r.total_opex > 0) {
    const tot = r.total_opex / gla
    if (tot <= REC_CEIL) { recPsf = Math.round(tot * 0.85 * 100) / 100; if (nonPsf <= 0) nonPsf = Math.round(tot * 0.15 * 100) / 100 }
  }
  if (recPsf <= 0) return `${deal.name}: could not derive a recoverable OpEx figure (confidence ${r.confidence})`

  // split recoverable into controllable (CAM/R&M) vs non-controllable (tax + insurance)
  let taxPsf = resolvePsf(r.tax_insurance_psf, r.tax_insurance_total, gla, REC_CEIL)
  if (taxPsf > recPsf) taxPsf = recPsf
  const ctrlPsf = Math.round(Math.max(0, recPsf - taxPsf) * 100) / 100

  const opex = { ...(uwm.opex ?? { opexGrowthPct: 0.03, generalVacancyPct: 0, creditLossPct: 0.005, capitalReservePsf: 0.25, otherIncomePsf: 0 }) }
  opex.recoverableOpexPsf = ctrlPsf
  opex.taxInsurancePsf = taxPsf
  if (nonPsf > 0) opex.nonRecoverableOpexPsf = nonPsf
  // provenance: stamp which statement drove the split (app's Data sources panel)
  const nextModel = {
    ...uwm, opex,
    sources: { ...(uwm.sources ?? {}), opex: { title: doc.title ?? doc.file_name ?? 'document', documentId: (doc as { id?: string }).id ?? null, extractedAt: new Date().toISOString(), confidence: typeof r.confidence === 'string' ? r.confidence : null } },
  }

  const { error: uErr } = await sb.from('pipeline_deals')
    .update({ underwriting_model: nextModel, updated_at: new Date().toISOString() }).eq('id', deal.id)
  if (uErr) return `${deal.name}: DB update failed — ${uErr.message}`

  // audit comment (dedup: skip if an [AI] Recoverable comment already exists)
  const { data: prior } = await sb.from('pipeline_deal_comments')
    .select('id').eq('deal_id', deal.id).like('body', '[AI] Recoverable%').limit(1)
  if (!prior || prior.length === 0) {
    const note = r.note ? ' ' + r.note : ''
    const period = r.period ? ` (${r.period})` : ''
    const body = `[AI] Recoverable OpEx derived from T-12 '${doc.title}'${period}: controllable CAM $${ctrlPsf}/sf + tax/insurance $${taxPsf}/sf (recoverable $${recPsf}/sf total), non-recoverable $${nonPsf}/sf (GLA ${Math.round(gla)} SF; confidence ${r.confidence}).${note} Controllable is subject to the recovery cap/admin fee; tax + insurance pass through uncapped. Extracted server-side — review before relying.`
    await sb.from('pipeline_deal_comments').insert({ deal_id: deal.id, body, author_id: null })
  }
  return `${deal.name}: SET controllable $${ctrlPsf}/sf + tax/ins $${taxPsf}/sf (recoverable $${recPsf}/sf total), non-recov $${nonPsf}/sf [${r.confidence}]`
}

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    // cron path: gateway-verified service_role JWT. Staff path: requireUser (must be privileged).
    if (bearerRole(req) !== 'service_role') {
      const caller = await requireUser(req, sb)
      if (!caller.isPrivileged) throw new AuthError('Deal data is restricted', 403)
    }

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')

    const body = await req.json().catch(() => ({}))
    const dealId: string | undefined = body.dealId
    const force = body.force === true
    const today = new Date().toISOString().slice(0, 10)

    let deals: DealRow[] = []
    if (dealId) {
      const { data } = await sb.from('pipeline_deals').select('id,name,gla_sf,underwriting_model').eq('id', dealId).limit(1)
      deals = (data ?? []) as DealRow[]
    } else {
      const { data } = await sb.from('pipeline_deals').select('id,name,gla_sf,underwriting_model').in('stage', ACTIVE_STAGES).limit(200)
      deals = (data ?? []) as DealRow[]
    }

    const results: string[] = []
    for (const d of deals) {
      try { results.push(await processDeal(sb, anthropicKey, d, force, today)) }
      catch (e) { results.push(`${d.name}: error — ${e instanceof Error ? e.message : String(e)}`) }
    }
    const setCount = results.filter(r => r.includes(': SET ')).length
    return new Response(JSON.stringify({ success: true, scanned: deals.length, set: setCount, results }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
