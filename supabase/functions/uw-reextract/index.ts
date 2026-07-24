// uw-reextract — user-initiated RE-EXTRACTION of one slice of a deal's
// underwriting from a chosen (or newest) storage PDF. Powers the "Data sources"
// panel on the Underwriting tab: see which file drives each input, replace the
// file, re-run the analysis.
//
// Unlike the weekly fill-blank-only pipeline (extract_underwriting / extract_
// rent_roll / extract_t12 / uw-extract cron), this function is explicitly
// invoked by a staff user and OVERWRITES the targeted slice. Safety rails:
//   - the prior underwriting model is snapshotted into .scenarios ("Pre
//     re-extract <date>") before any model-changing write, keep-first per day;
//   - broker documents (OM / teaser) never write return metrics — numbers are
//     quarantined to a Discussion comment, same discipline as the scripts;
//   - every write stamps underwriting_model.sources.<kind> (provenance) and
//     posts an [AI] audit comment citing file + confidence.
//
// kinds:
//   metrics  — stated levered returns -> pipeline_deals metric columns
//              (ports scripts/extract_underwriting.ps1)
//   rentroll — per-tenant lease lines -> underwriting_model.leases
//              (ports scripts/extract_rent_roll.ps1)
//   opex     — T-12 recoverable/non-recoverable split -> underwriting_model.opex
//              (ports scripts/extract_t12.ps1 / uw-extract)
//
// Body: { dealId: string, kind: 'metrics'|'rentroll'|'opex', documentId?: string, force?: boolean }
// documentId must be linked to the deal (pipeline_deal_documents); omitted =
// auto-pick per kind. Excel/ARGUS models cannot be read here — upload a PDF
// print (the local scripts handle xlsx via Excel COM).
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, corsHeaders, requireUser } from '../_shared/auth.ts'

const MODEL = Deno.env.get('UW_EXTRACT_MODEL') ?? 'claude-sonnet-5'
const REC_CEIL = 60.0    // recoverable OpEx (CAM+tax+ins) never exceeds ~$60/SF/yr; above = mis-parsed total
const NON_CEIL = 30.0    // non-recoverable (mgmt+G&A) ceiling
const RENT_CEIL = 200    // no retail/office base rent exceeds ~$200/SF; above = a mis-parsed total
const MAX_PDF_BYTES = 32 * 1024 * 1024   // Claude url-document cap

type Kind = 'metrics' | 'rentroll' | 'opex'

interface DocInfo { id: string; title: string | null; file_name: string | null; storage_path: string | null; file_size_bytes: number | null; role: string | null }
interface DealRow {
  id: string; name: string; gla_sf: number | null; ask_price: number | null; going_in_cap: number | null
  underwriting_model: any
  proj_irr: number | null; equity_multiple: number | null; avg_coc: number | null; hold_years: number | null
  exit_cap: number | null; stabilized_yield: number | null; equity_required: number | null; total_capitalization: number | null
}

// ── shared helpers (ported from the PS extractors / uw-extract) ───────────────

async function anthropicForcedTool(key: string, signedUrl: string, toolName: string, prompt: string, maxTokens: number): Promise<any> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens,
      tools: [{ name: toolName, description: 'Report the extracted data.', input_schema: { type: 'object', additionalProperties: true } }],
      tool_choice: { type: 'tool', name: toolName },
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'url', url: signedUrl } },
        { type: 'text', text: prompt },
      ] }],
    }),
  })
  const d = await r.json()
  if (!r.ok) {
    const msg = d?.error?.message ?? JSON.stringify(d)
    throw new Error('Anthropic API error: ' + msg)
  }
  const block = (d.content ?? []).find((c: { type: string }) => c.type === 'tool_use')
  if (!block) throw new Error('Model returned no tool_use block')
  return block.input
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
function docYear(doc: DocInfo): number {
  const s = `${doc.title ?? ''} ${doc.file_name ?? ''}`
  const yrs = [...s.matchAll(/20\d\d/g)].map(m => parseInt(m[0], 10)).filter(y => y <= 2099)
  return yrs.length ? Math.max(...yrs) : 0
}

const isPdf = (d: DocInfo) => !!d.storage_path && /\.pdf$/i.test(d.file_name ?? '')
const nameOf = (d: DocInfo) => `${d.title ?? ''} ${d.file_name ?? ''}`

/** Pick the operating-statement PDF the way extract_t12.ps1 does. */
function pickStatement(docs: DocInfo[]): DocInfo | null {
  let cand = docs.filter(d => d.role === 'operating_statement' && isPdf(d))
  if (!cand.length) {
    cand = docs.filter(d => d.role === 'financials' && isPdf(d)
      && /t-?12|trailing|operating\s*stmt|operating\s*statement|income\s*statement|profit.*loss|p&l|cash\s*flow/i.test(nameOf(d)))
  }
  if (!cand.length) {
    cand = docs.filter(d => d.role === 'other' && isPdf(d)
      && /income\s*statement|p&l|profit.*loss|t-?12|trailing|operating\s*statement/i.test(nameOf(d))
      && !/offering|memorandum|\bom\b|sales|rent\s*roll|survey|warranty|easement|overview|guidance|site\s*plan/i.test(nameOf(d)))
  }
  if (!cand.length) return null
  cand.sort((a, b) => (docYear(b) - docYear(a)) || ((b.file_size_bytes ?? 0) - (a.file_size_bytes ?? 0)))
  return cand[0]
}

/** Auto-pick per kind when no documentId was given. */
function pickDoc(kind: Kind, docs: DocInfo[]): DocInfo | null {
  if (kind === 'opex') return pickStatement(docs)
  if (kind === 'rentroll') {
    const cand = docs.filter(d => d.role === 'rent_roll' && isPdf(d))
    cand.sort((a, b) => (b.file_size_bytes ?? 0) - (a.file_size_bytes ?? 0))   // largest, like the script
    return cand[0] ?? null
  }
  // metrics: internal financials first (newest year, then smallest = cap-safe); never auto-pick the broker OM
  const fin = docs.filter(d => d.role === 'financials' && isPdf(d))
  fin.sort((a, b) => (docYear(b) - docYear(a)) || ((a.file_size_bytes ?? 0) - (b.file_size_bytes ?? 0)))
  return fin[0] ?? null
}

/** Snapshot the current model into .scenarios before an overwriting re-extract.
 *  Keep-first per day: the first snapshot of the day is the true pre-state. */
function withPreSnapshot(uwm: any, today: string): any[] {
  const scen: any[] = Array.isArray(uwm?.scenarios) ? uwm.scenarios : []
  const substantive = uwm && (uwm.mode || (Array.isArray(uwm.leases) && uwm.leases.length > 0) || uwm.purchasePrice)
  if (!substantive) return scen
  const name = `Pre re-extract ${today}`
  if (scen.some(s => s?.name === name)) return scen
  return [...scen, { name, model: { ...uwm, scenarios: undefined, sources: undefined }, savedAt: new Date().toISOString() }]
}

function sourceStamp(doc: DocInfo, confidence: unknown, broker?: boolean) {
  const s: Record<string, unknown> = {
    title: doc.title ?? doc.file_name ?? 'document',
    documentId: doc.id,
    extractedAt: new Date().toISOString(),
    confidence: typeof confidence === 'string' ? confidence : null,
  }
  if (broker) s.broker = true
  return s
}

async function postComment(sb: SupabaseClient, dealId: string, body: string): Promise<void> {
  await sb.from('pipeline_deal_comments').insert({ deal_id: dealId, body, author_id: null })
}

// ── kind: metrics (ports extract_underwriting.ps1) ────────────────────────────

const METRIC_FIELDS = ['proj_irr', 'equity_multiple', 'avg_coc', 'hold_years', 'exit_cap', 'stabilized_yield', 'equity_required', 'total_capitalization'] as const

function metricsPrompt(dealName: string, docTitle: string, kindLabel: string): string {
  return `You are an acquisitions analyst at M&J Wilkow. The attached PDF belongs to ONE deal: ${dealName}. Attached file: "${docTitle}" [${kindLabel}].

Extract the deal-level PROJECTED (underwritten) LEVERED return metrics. Rules:
- EXTRACT ONLY values stated in the document. NEVER compute, derive, or estimate a number yourself. A field the document doesn't state = null.
- Prefer the BASE CASE over any upside/downside scenario.
- Percentages as decimals (12.4% -> 0.124). Dollars as plain numbers.
- source_kind: 'internal_model' if the figures come from M&J Wilkow's own financial analysis / underwriting file, 'broker_om' if they come from a broker offering memorandum's pro-forma.
- Call the report_underwriting tool with exactly:
{"found": bool, "source_kind": "internal_model"|"broker_om"|null, "source_file": str|null, "source_page": int|null,
 "confidence": "high"|"medium"|"low"|null, "proj_irr": num|null, "equity_multiple": num|null, "avg_coc": num|null,
 "hold_years": num|null, "exit_cap": num|null, "stabilized_yield": num|null, "equity_required": num|null,
 "total_capitalization": num|null, "note": str|null}`
}

async function runMetrics(sb: SupabaseClient, key: string, deal: DealRow, doc: DocInfo, force: boolean, today: string): Promise<string> {
  const brokerDoc = doc.role === 'om' || doc.role === 'teaser'
  const kindLabel = brokerDoc ? 'broker offering memorandum' : 'M&J Wilkow internal financial analysis'
  const { data: signed, error: sErr } = await sb.storage.from('documents').createSignedUrl(doc.storage_path!, 3600)
  if (sErr || !signed?.signedUrl) throw new Error(`could not sign '${doc.title}'`)
  const r = await anthropicForcedTool(key, signed.signedUrl, 'report_underwriting', metricsPrompt(deal.name, doc.title ?? doc.file_name ?? 'document', kindLabel), 800)
  if (!r?.found) return `No stated return metrics found in '${doc.title}'. Nothing changed.`

  const isBroker = r.source_kind === 'broker_om' || brokerDoc
  const summaryBits: string[] = []
  const patch: Record<string, unknown> = {}
  for (const f of METRIC_FIELDS) {
    const v = r[f]
    if (v == null || typeof v !== 'number') continue
    summaryBits.push(`${f}=${v}`)
    if (!isBroker && (force || (deal as any)[f] == null)) patch[f] = v
  }
  if (!summaryBits.length) return `'${doc.title}' states no usable return figures. Nothing changed.`
  const srcLine = `${r.source_file ?? doc.title}${r.source_page ? `, p.${r.source_page}` : ''}`

  if (isBroker) {
    await postComment(sb, deal.id, `[AI] Return metrics found in BROKER PRO-FORMA only (${srcLine}, confidence: ${r.confidence}): ${summaryBits.join(', ')}. NOT written to the deal — broker numbers are quarantined; enter on the Underwriting tab if appropriate. (in-app re-extract)`)
    return `'${doc.title}' is a broker document — its pro-forma numbers were quarantined to a Discussion comment, not written to the deal.`
  }
  if (!Object.keys(patch).length) return `Values in '${doc.title}' match what is already on the deal. Nothing changed.`

  // stamp provenance on the model jsonb (stub {sources} if no model exists yet)
  const uwm = deal.underwriting_model ?? {}
  patch.underwriting_model = { ...uwm, sources: { ...(uwm.sources ?? {}), metrics: sourceStamp(doc, r.confidence) } }
  patch.updated_at = new Date().toISOString()
  const { error: uErr } = await sb.from('pipeline_deals').update(patch).eq('id', deal.id)
  if (uErr) throw new Error('DB update failed — ' + uErr.message)

  await postComment(sb, deal.id, `[AI] Underwriting re-extracted from internal model: ${srcLine} (confidence: ${r.confidence}). Values: ${summaryBits.join(', ')}. ${r.note ? r.note + ' ' : ''}Requested in-app on ${today} — review on the Underwriting tab before relying.`)
  const wrote = Object.keys(patch).filter(k => k !== 'updated_at' && k !== 'underwriting_model')
  return `Returns updated from '${doc.title}' (${r.confidence} confidence): ${wrote.join(', ')}.`
}

// ── kind: rentroll (ports extract_rent_roll.ps1) ──────────────────────────────

function rentRollPrompt(dealName: string, today: string): string {
  return `You are an acquisitions analyst at M&J Wilkow. The attached PDF is the RENT ROLL for the deal: ${dealName}. Extract a tenant-level lease schedule for underwriting. Today is ${today}.

Rules:
- One row per tenant/suite. name = tenant name; sf = leased square feet.
- base_rent_psf = CURRENT annual base rent PER SQUARE FOOT (annual rent / SF). This is NOT the annual total dollar rent. Retail/office base rents are typically $8-$60/SF; if the rent roll shows a monthly amount, x12 then / SF; if it shows an annual total $, divide by SF. Exclude recoveries/CAM. If unsure, leave null rather than putting a total.
- annual_bump_pct = contractual annual escalation as a decimal (3% -> 0.03); if fixed steps, approximate the average annual rate; null if flat/unknown.
- term_remaining_years = years from TODAY (${today}) to lease expiration (decimal ok); month-to-month or holdover/expired -> 0.5; NEVER negative; null if unknown.
- recovery: 'nnn' if tenant reimburses CAM/tax/insurance (triple net), 'gross' if full-service/gross, 'base_year' if base-year stop. Retail is usually nnn.
- gla_sf = total building GLA if stated. recoverable_opex_psf / non_recoverable_opex_psf = annual $/SF if the rent roll or notes state operating expenses (else null). market_rent_psf = stated market/asking rent if shown.
- EXTRACT ONLY what the rent roll shows; use null for anything absent. Do NOT invent rents.
- Call report_rent_roll with an object matching exactly (all keys present):
{"gla_sf":num|null,"recoverable_opex_psf":num|null,"non_recoverable_opex_psf":num|null,"market_rent_psf":num|null,"leases":[{"name":str,"sf":num,"base_rent_psf":num,"annual_bump_pct":num|null,"term_remaining_years":num|null,"recovery":"nnn"|"gross"|"base_year"|null}]}`
}

function normRecovery(r: unknown): 'nnn' | 'gross' | 'base_year' {
  const s = String(r ?? '')
  if (/nnn|triple|net/i.test(s)) return 'nnn'
  if (/base/i.test(s)) return 'base_year'
  if (/gross|full/i.test(s)) return 'gross'
  return 'nnn'
}

const D_ROLL = { renewalProbPct: 0.7, marketRentPsf: 0, marketRentGrowthPct: 0.03, downtimeMonths: 6, tiNewPsf: 30, tiRenewPsf: 10, lcNewPsf: 15, lcRenewPsf: 5, freeRentMonthsNew: 3, releaseTermYears: 7 }
const D_OPEX = { recoverableOpexPsf: 0, nonRecoverableOpexPsf: 0, opexGrowthPct: 0.03, generalVacancyPct: 0, creditLossPct: 0.005, capitalReservePsf: 0.25, otherIncomePsf: 0 }

async function runRentRoll(sb: SupabaseClient, key: string, deal: DealRow, doc: DocInfo, today: string): Promise<string> {
  const { data: signed, error: sErr } = await sb.storage.from('documents').createSignedUrl(doc.storage_path!, 3600)
  if (sErr || !signed?.signedUrl) throw new Error(`could not sign '${doc.title}'`)
  const r = await anthropicForcedTool(key, signed.signedUrl, 'report_rent_roll', rentRollPrompt(deal.name, today), 4000)

  const leases: any[] = []
  for (const t of (Array.isArray(r?.leases) ? r.leases : [])) {
    if (!t?.name || t.sf == null) continue
    const sf = Number(t.sf) || 0
    let rent = Number(t.base_rent_psf) || 0
    if (sf > 0 && rent > RENT_CEIL) rent = rent / sf              // looks like an annual total -> per SF
    if (rent > RENT_CEIL || rent < 0) rent = 0                    // still implausible -> unknown (analyst fills)
    let term = t.term_remaining_years != null ? Number(t.term_remaining_years) : 5
    if (!isFinite(term) || term < 0) term = 0.5
    let bump = t.annual_bump_pct != null ? Number(t.annual_bump_pct) : 0.03
    if (!isFinite(bump) || bump < 0 || bump > 0.15) bump = 0.03
    leases.push({ name: String(t.name), sf, baseRentPsf: Math.round(rent * 100) / 100, annualBumpPct: bump, termRemainingYears: term, recovery: normRecovery(t.recovery) })
  }
  if (!leases.length) return `No lease lines could be extracted from '${doc.title}'. Nothing changed.`

  const uwm = deal.underwriting_model ?? null
  const sumSfAll = leases.reduce((s, l) => s + l.sf, 0)
  const gla = (typeof r.gla_sf === 'number' && r.gla_sf > 0) ? r.gla_sf
    : (typeof uwm?.glaSf === 'number' && uwm.glaSf > 0) ? uwm.glaSf
    : (typeof deal.gla_sf === 'number' && deal.gla_sf > 0) ? deal.gla_sf : sumSfAll
  // market rent = SF-weighted average of the (corrected, non-zero) in-place rents
  const paid = leases.filter(l => l.baseRentPsf > 0)
  const sumSf = paid.reduce((s, l) => s + l.sf, 0)
  const sumRent = paid.reduce((s, l) => s + l.sf * l.baseRentPsf, 0)
  const avgInPlace = sumSf > 0 ? sumRent / sumSf : 0
  const mkt = (typeof r.market_rent_psf === 'number' && r.market_rent_psf > 0 && r.market_rent_psf <= RENT_CEIL)
    ? r.market_rent_psf : Math.round(avgInPlace * 100) / 100
  const recOpex = typeof r.recoverable_opex_psf === 'number' ? resolvePsf(r.recoverable_opex_psf, null, gla, REC_CEIL) : 0
  const nonRec = typeof r.non_recoverable_opex_psf === 'number' ? resolvePsf(r.non_recoverable_opex_psf, null, gla, NON_CEIL) : 0

  let next: any
  if (uwm && (uwm.mode || (Array.isArray(uwm.leases) && uwm.leases.length))) {
    // existing model: replace the lease lines + market rent; keep financing /
    // opex / promote / periodicity (no silent NOI-basis shift) — snapshot first.
    next = {
      ...uwm, mode: 'tenant', glaSf: gla, leases,
      rollover: { ...D_ROLL, ...(uwm.rollover ?? {}), marketRentPsf: mkt },
      opex: { ...D_OPEX, ...(uwm.opex ?? {}) },
      scenarios: withPreSnapshot(uwm, today),
    }
    // rent-roll opex is a weak signal — fill only when the model has none (T-12 wins)
    if (recOpex > 0 && !(Number(uwm.opex?.recoverableOpexPsf) > 0)) next.opex.recoverableOpexPsf = recOpex
    if (nonRec > 0 && !(Number(uwm.opex?.nonRecoverableOpexPsf) > 0)) next.opex.nonRecoverableOpexPsf = nonRec
  } else {
    // no model yet: seed a fresh tenant model like extract_rent_roll.ps1
    next = {
      purchasePrice: deal.ask_price ?? 0, acqCostsPct: 0.02, capexUpfront: 0, inPlaceNoi: 0, noiGrowthPct: 0.03,
      holdYears: 5, exitCapPct: deal.going_in_cap ?? 0.065, sellingCostsPct: 0.02,
      ltvPct: 0.6, loanRatePct: 0.065, amortYears: 30, mode: 'tenant', periodicity: 'monthly', glaSf: gla, leases,
      rollover: { ...D_ROLL, marketRentPsf: mkt },
      opex: { ...D_OPEX, recoverableOpexPsf: recOpex, nonRecoverableOpexPsf: nonRec },
      sources: uwm?.sources ?? undefined,
    }
  }
  next.sources = { ...(next.sources ?? {}), rentRoll: sourceStamp(doc, null) }

  const { error: uErr } = await sb.from('pipeline_deals')
    .update({ underwriting_model: next, updated_at: new Date().toISOString() }).eq('id', deal.id)
  if (uErr) throw new Error('DB update failed — ' + uErr.message)

  await postComment(sb, deal.id, `[AI] Rent roll re-extracted from '${doc.title}': ${leases.length} tenant lease lines (GLA ${Math.round(gla).toLocaleString()} SF, SF-weighted in-place $${mkt}/SF as market rent). The prior model was snapshotted as a scenario. Requested in-app on ${today} — review the Underwriting tab before relying.`)
  return `Rent roll replaced from '${doc.title}': ${leases.length} tenants (GLA ${Math.round(gla).toLocaleString()} SF). Prior model saved as a scenario.`
}

// ── kind: opex (ports extract_t12.ps1 / uw-extract) ───────────────────────────

function t12Prompt(dealName: string, today: string): string {
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
{"gla_sf":num|null,"recoverable_opex_psf":num|null,"non_recoverable_opex_psf":num|null,"tax_insurance_psf":num|null,"recoverable_opex_total":num|null,"non_recoverable_opex_total":num|null,"tax_insurance_total":num|null,"total_opex":num|null,"effective_gross_income":num|null,"period":str|null,"confidence":"high"|"medium"|"low"|null,"note":str|null}`
}

async function runOpex(sb: SupabaseClient, key: string, deal: DealRow, doc: DocInfo, today: string): Promise<string> {
  const uwm = deal.underwriting_model
  if (!uwm || uwm.mode !== 'tenant') return `${deal.name} has no tenant-level model yet — extract the rent roll first (the OpEx split belongs to the tenant model).`
  const { data: signed, error: sErr } = await sb.storage.from('documents').createSignedUrl(doc.storage_path!, 3600)
  if (sErr || !signed?.signedUrl) throw new Error(`could not sign '${doc.title}'`)
  const r = await anthropicForcedTool(key, signed.signedUrl, 'report_t12', t12Prompt(deal.name, today), 1500)

  const gla = (typeof r.gla_sf === 'number' && r.gla_sf > 0) ? r.gla_sf
    : (typeof uwm.glaSf === 'number' && uwm.glaSf > 0) ? uwm.glaSf
    : (typeof deal.gla_sf === 'number' && deal.gla_sf > 0) ? deal.gla_sf : 0
  if (gla <= 0) return `No GLA known for ${deal.name}; cannot derive $/SF figures.`

  let recPsf = resolvePsf(r.recoverable_opex_psf, r.recoverable_opex_total, gla, REC_CEIL)
  let nonPsf = resolvePsf(r.non_recoverable_opex_psf, r.non_recoverable_opex_total, gla, NON_CEIL)
  if (recPsf <= 0 && typeof r.total_opex === 'number' && r.total_opex > 0) {
    const tot = r.total_opex / gla
    if (tot <= REC_CEIL) { recPsf = Math.round(tot * 0.85 * 100) / 100; if (nonPsf <= 0) nonPsf = Math.round(tot * 0.15 * 100) / 100 }
  }
  if (recPsf <= 0) return `Could not derive a recoverable OpEx figure from '${doc.title}' (confidence ${r.confidence}). Nothing changed.`

  let taxPsf = resolvePsf(r.tax_insurance_psf, r.tax_insurance_total, gla, REC_CEIL)
  if (taxPsf > recPsf) taxPsf = recPsf
  const ctrlPsf = Math.round(Math.max(0, recPsf - taxPsf) * 100) / 100

  const opex = { ...(uwm.opex ?? { opexGrowthPct: 0.03, generalVacancyPct: 0, creditLossPct: 0.005, capitalReservePsf: 0.25, otherIncomePsf: 0 }) }
  opex.recoverableOpexPsf = ctrlPsf
  opex.taxInsurancePsf = taxPsf
  if (nonPsf > 0) opex.nonRecoverableOpexPsf = nonPsf
  const next = {
    ...uwm, opex,
    scenarios: withPreSnapshot(uwm, today),
    sources: { ...(uwm.sources ?? {}), opex: sourceStamp(doc, r.confidence) },
  }

  const { error: uErr } = await sb.from('pipeline_deals')
    .update({ underwriting_model: next, updated_at: new Date().toISOString() }).eq('id', deal.id)
  if (uErr) throw new Error('DB update failed — ' + uErr.message)

  const period = r.period ? ` (${r.period})` : ''
  await postComment(sb, deal.id, `[AI] Recoverable OpEx re-extracted from T-12 '${doc.title}'${period}: controllable CAM $${ctrlPsf}/sf + tax/insurance $${taxPsf}/sf (recoverable $${recPsf}/sf total), non-recoverable $${nonPsf}/sf (GLA ${Math.round(gla)} SF; confidence ${r.confidence}).${r.note ? ' ' + r.note : ''} The prior model was snapshotted as a scenario. Requested in-app on ${today} — review before relying.`)
  return `OpEx split updated from '${doc.title}'${period}: controllable $${ctrlPsf}/sf + tax/ins $${taxPsf}/sf, non-recoverable $${nonPsf}/sf (${r.confidence} confidence). Prior model saved as a scenario.`
}

// ── entrypoint ────────────────────────────────────────────────────────────────

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const caller = await requireUser(req, sb)
    if (!caller.isPrivileged) throw new AuthError('Deal data is restricted', 403)

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')

    const body = await req.json().catch(() => ({}))
    const dealId: string | undefined = body.dealId
    const kind: Kind | undefined = body.kind
    const documentId: string | undefined = body.documentId
    const force = body.force !== false
    if (!dealId || !kind || !['metrics', 'rentroll', 'opex'].includes(kind)) {
      throw new Error('Body must include dealId and kind (metrics | rentroll | opex)')
    }
    const today = new Date().toISOString().slice(0, 10)

    const { data: dRows, error: dErr } = await sb.from('pipeline_deals')
      .select('id,name,gla_sf,ask_price,going_in_cap,underwriting_model,proj_irr,equity_multiple,avg_coc,hold_years,exit_cap,stabilized_yield,equity_required,total_capitalization')
      .eq('id', dealId).limit(1)
    if (dErr) throw new Error(dErr.message)
    const deal = (dRows ?? [])[0] as DealRow | undefined
    if (!deal) throw new Error('Deal not found')

    // linked docs only — a documentId must belong to this deal
    const { data: linkRows, error: lErr } = await sb.from('pipeline_deal_documents')
      .select('role, documents(id,title,file_name,storage_path,file_size_bytes)')
      .eq('deal_id', dealId)
    if (lErr) throw new Error(lErr.message)
    const docs: DocInfo[] = ((linkRows ?? []) as any[])
      .filter(rw => rw.documents)
      .map(rw => ({ ...(rw.documents as any), role: rw.role ?? null }) as DocInfo)

    let doc: DocInfo | null = null
    if (documentId) {
      doc = docs.find(d => d.id === documentId) ?? null
      if (!doc) throw new Error('That document is not linked to this deal')
      if (!isPdf(doc)) throw new Error('Only PDFs can be re-extracted here — for Excel/ARGUS models print to PDF first (or run the local per-deal command)')
    } else {
      doc = pickDoc(kind, docs)
      if (!doc) {
        const need = kind === 'rentroll' ? 'a rent-roll PDF' : kind === 'opex' ? 'a T-12 / operating-statement PDF' : 'an internal financials/model PDF'
        return new Response(JSON.stringify({ success: false, message: `No candidate document on this deal — upload ${need} first.` }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    }
    if ((doc.file_size_bytes ?? 0) > MAX_PDF_BYTES) {
      throw new Error(`'${doc.title}' is ${(Math.round((doc.file_size_bytes ?? 0) / 1048576))}MB — over the ~32MB extraction cap. Upload a smaller PDF (e.g. just the summary pages).`)
    }

    let message: string
    if (kind === 'metrics') message = await runMetrics(sb, anthropicKey, deal, doc, force, today)
    else if (kind === 'rentroll') message = await runRentRoll(sb, anthropicKey, deal, doc, today)
    else message = await runOpex(sb, anthropicKey, deal, doc, today)

    return new Response(JSON.stringify({ success: true, message, kind, documentId: doc.id }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
