// abstract-verify — independent QA pass over an already-generated lease abstract.
//
// This is the human-in-the-loop assurance layer. Rather than trusting the
// abstractor's own summary, a SECOND model call re-reads the SAME governing
// PDFs the abstract was built from (source_doc_ids) and is told to REFUTE the
// abstract: for every high-value field it must find the source text that
// supports OR contradicts the stored value, quote it, and cite it. It also runs
// arithmetic consistency checks and confirms the latest amendment's terms are
// the ones reflected (the exact failure that left 9 KM tenants with stale
// expirations).
//
// Grounding on the SAME documents (not a fresh search) guarantees the verifier
// sees what the abstractor saw — a disagreement means the abstractor misread,
// not that the two runs looked at different files.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.
// Usage: POST JSON { property_id: uuid, tenant: string, max_pdfs?: number }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canReadProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

// Verification is a reasoning task, not a formatting one — use the strongest
// model available. Override with QA_MODEL if needed.
const MODEL = Deno.env.get('QA_MODEL') ?? 'claude-opus-4-8'
const CHAR_BUDGET = 350_000

// Layer the reviewer's overrides (dotted-path → value) over the AI abstract so
// the verifier audits the human-corrected values. Mirrors applyOverrides in
// src/pages/AbstractsPage.tsx (kept intentionally identical).
function applyOverrides(abstract: any, overrides: Record<string, any> | null | undefined) {
  if (!overrides || !Object.keys(overrides).length) return abstract
  const clone = JSON.parse(JSON.stringify(abstract ?? {}))
  for (const [path, val] of Object.entries(overrides)) {
    const parts = path.split('.')
    let o = clone
    for (let i = 0; i < parts.length - 1; i++) {
      if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {}
      o = o[parts[i]]
    }
    o[parts[parts.length - 1]] = val
  }
  return clone
}

// Forced tool-use so the verdict comes back as parsed JSON (quoted lease
// language in source_quote can never break parsing).
async function anthropicJson(key: string, model: string, content: any[], maxTokens: number): Promise<any> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      tools: [{
        name: 'submit_qa',
        description: 'Submit the completed verification verdict.',
        input_schema: { type: 'object', additionalProperties: true },
      }],
      tool_choice: { type: 'tool', name: 'submit_qa' },
      messages: [{ role: 'user', content }],
    }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Anthropic API error: ' + JSON.stringify(d))
  if (d.stop_reason === 'max_tokens') throw new Error('Verdict truncated at max_tokens — retry')
  const block = (d.content ?? []).find((c: { type: string }) => c.type === 'tool_use')
  if (!block) throw new Error('Model returned no tool_use block')
  return block.input
}

// OpenAI verdict via the Responses API (JSON mode) — the fallback used when the
// Anthropic API is overloaded. Translates the Anthropic content blocks (text +
// base64 PDF documents) to OpenAI input parts and returns the parsed JSON verdict.
// A different model verifying is, if anything, MORE independent than same-model.
const QA_OPENAI_MODEL = Deno.env.get('QA_OPENAI_MODEL') ?? 'gpt-4.1'
async function openaiVerifyJson(key: string, content: any[], maxTokens: number): Promise<any> {
  const oai: any[] = []
  for (const c of content) {
    if (c.type === 'text') oai.push({ type: 'input_text', text: c.text })
    else if (c.type === 'document' && c.source?.type === 'base64') {
      oai.push({ type: 'input_file', filename: 'document.pdf', file_data: `data:${c.source.media_type};base64,${c.source.data}` })
    }
  }
  oai.push({ type: 'input_text', text: 'Return ONLY a single valid JSON object for the submit_qa verdict described above — no markdown, no commentary.' })
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: QA_OPENAI_MODEL, max_output_tokens: maxTokens,
      text: { format: { type: 'json_object' } },
      input: [{ role: 'user', content: oai }],
    }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('OpenAI API error: ' + JSON.stringify(d))
  if (d.status === 'incomplete') throw new Error('Verdict truncated at max_output_tokens — retry')
  let out = typeof d.output_text === 'string' ? d.output_text : ''
  if (!out) for (const item of (d.output ?? [])) for (const cc of (item.content ?? [])) if (cc.type === 'output_text') out += cc.text ?? ''
  return JSON.parse(out)
}

// Anthropic is overloaded intermittently; on that specific signal, fall back to
// OpenAI so verification still completes. Cap/other errors propagate unchanged.
// Fall back to OpenAI whenever the Anthropic API is UNUSABLE — transient
// overload/rate-limit, or a hard credit/billing block. All are "provider down
// right now, use the other one" for our purposes.
function isOverloaded(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e)
  return /overloaded_error|"Overloaded"|\b529\b|rate_limit|too many requests|credit balance|Plans & Billing|insufficient|billing/i.test(m)
}
async function verifyJson(aKey: string, oKey: string, model: string, content: any[], maxTokens: number): Promise<any> {
  try { return await anthropicJson(aKey, model, content, maxTokens) }
  catch (e) {
    if (oKey && isOverloaded(e)) return await openaiVerifyJson(oKey, content, maxTokens)
    throw e
  }
}

const QA_SCHEMA = `{
 "confidence": "high"|"medium"|"low",
 "summary": str,                                  // 1-2 sentences: is this abstract trustworthy, and where are the risks
 "field_checks": [{                               // verify the abstract against the DOCUMENTS ONLY (never against MRI — that goes in mri_reconciliation)
   "field": str,                                  // dotted path, e.g. "term.expiration", "base_rent_schedule[0].annual", "options[1]"
   "abstract_value": str,                         // what the abstract currently says (stringify)
   "verdict": "confirmed"|"discrepancy"|"unsupported"|"needs_source",
   "source_quote": str,                           // VERBATIM text from the documents that supports or contradicts the value ("" if none exists)
   "citation": str,                               // document title + section/article where the quote lives
   "severity": "high"|"medium"|"low",             // economic/legal impact of the field being wrong
   "note": str                                    // what is right/wrong and, if a discrepancy, the correct value
 }],
 "mri_reconciliation": [{                          // ONLY where the documents and MRI MATERIALLY DISAGREE on a field MRI is the system of record for. NEVER add an entry to confirm agreement — if the values match (or are the same date/number in a different format), OMIT the field entirely. This array is an MRI-CORRECTION worklist, not a checklist. Scope it to: current-term commencement, current-term expiration, leased SF, suite/unit, current base rent, and the percentage-rent flag. Do NOT emit entries for security deposit, TI allowance, breakpoints, guarantor, or legal-name-vs-DBA formatting — the DOCUMENTS govern those and they are not MRI conflicts.
   "field": str,
   "abstract_value": str,
   "mri_value": str,
   "governs": "abstract"|"mri"|"unclear",         // which source is authoritative: 'abstract' when the documents (esp. the latest amendment) clearly control; 'mri' when MRI is right and the abstract is wrong; 'unclear' otherwise
   "note": str
 }],
 "arithmetic": [{ "check": str, "ok": bool, "detail": str }],   // monthly*12 vs annual; annual vs psf*sf; commencement+term vs expiration. ok=false ONLY for a GENUINE numeric contradiction between STATED values; a value that merely cannot be computed/confirmed is NOT an arithmetic failure (record that as a needs_source field_check instead).
 "amendment_currency": { "current": bool, "note": str },        // are the CURRENT (latest-amendment) terms the ones abstracted, not a superseded earlier value? Judge against the DOCUMENTS' amendment chain — do NOT set current=false merely because MRI shows different values (that is an mri_reconciliation item).
 "fabrication_risk": [str],                       // any abstract value that no attached/excerpted document supports (specific field + value)
 "recommended_fixes": [str]                       // concrete edits to make the abstract correct (empty if none)
}`

// verdict → row status. 'issues' = something a human must fix before relying on
// the abstract; 'review' = softer flags worth a look; 'verified' = clean.
function deriveStatus(qa: any): string {
  const checks = Array.isArray(qa?.field_checks) ? qa.field_checks : []
  const arith = Array.isArray(qa?.arithmetic) ? qa.arithmetic : []
  const badVerdict = (v: string) => v === 'discrepancy' || v === 'unsupported'
  // ISSUES = something a human must fix before relying on the abstract: a
  // HIGH-severity discrepancy/unsupported claim, failed arithmetic, or a stale
  // (superseded-amendment) term.
  const highIssue = checks.some((c: any) => badVerdict(c?.verdict) && c?.severity === 'high')
  const arithFail = arith.some((a: any) => a?.ok === false)
  const stale = qa?.amendment_currency?.current === false
  if (highIssue || arithFail || stale) return 'issues'
  // REVIEW = softer flags worth a look: medium/low discrepancies, needs-source,
  // or derived-value disclosures. fabrication_risk is NOT an issues trigger — post
  // grounding-fix it mostly holds "computed, not quoted verbatim" notes, and a
  // genuinely invented fact also surfaces as a HIGH 'unsupported' field_check above.
  const softFlag = checks.some((c: any) => badVerdict(c?.verdict) || c?.verdict === 'needs_source')
  const fabrication = Array.isArray(qa?.fabrication_risk) && qa.fabrication_risk.length > 0
  if (softFlag || fabrication) return 'review'
  return 'verified'
}

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const caller = await requireUser(req, sb)

    const body = await req.json().catch(() => ({}))
    const propertyId: string = body.property_id ?? ''
    const tenant: string = (body.tenant ?? '').trim()
    if (!propertyId || !tenant) throw new Error('property_id and tenant are required')
    if (!canReadProperty(caller, propertyId)) throw new AuthError('No access to this property', 403)

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')
    const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? ''   // fallback provider when Anthropic is overloaded

    // ── 1. The abstract to verify ──
    const { data: row, error: rErr } = await sb.from('lease_abstracts')
      .select('id, abstract, overrides, source_doc_ids, model')
      .eq('property_id', propertyId)
      .eq('tenant_name', tenant)
      .maybeSingle()
    if (rErr) throw new Error('load abstract failed: ' + rErr.message)
    if (!row || !row.abstract) throw new Error(`No abstract exists for "${tenant}" — generate it first`)
    // Audit the HUMAN-CORRECTED abstract: layer the reviewer's overrides
    // (dotted-path → value) over the AI JSON so a corrected field is verified
    // as corrected and stops getting re-flagged. Matches applyOverrides in the
    // frontend (AbstractsPage.tsx) and migration 20240105's resolution model.
    const auditAbstract = applyOverrides(row.abstract, row.overrides)
    const sourceIds: string[] = Array.isArray(row.source_doc_ids) ? row.source_doc_ids : []
    if (!sourceIds.length) throw new Error('Abstract has no recorded source documents — regenerate it before verifying')

    // ── 2. The SAME source documents the abstractor used ──
    const { data: sdocs, error: dErr } = await sb.from('documents')
      .select('id, doc_type, title, file_name, file_path, storage_path, file_size_bytes')
      .in('id', sourceIds)
    if (dErr) throw new Error('document load failed: ' + dErr.message)
    // Preserve the abstractor's ordering (governing lease + newest amendments
    // first) so the attach/text budget favours the same primary sources.
    const orderIdx = new Map(sourceIds.map((id, i) => [id, i]))
    const docs = ((sdocs ?? []) as any[]).sort(
      (a, b) => (orderIdx.get(a.id) ?? 999) - (orderIdx.get(b.id) ?? 999))
    if (!docs.length) throw new Error('Source documents no longer available')

    // ── 3. Full chunk text, capped ──
    const { data: chunks } = await sb.from('document_chunks')
      .select('document_id, chunk_index, content')
      .in('document_id', docs.map(d => d.id))
      .order('chunk_index')
    const byDoc = new Map<string, string[]>()
    for (const c of (chunks ?? []) as any[]) {
      if (!byDoc.has(c.document_id)) byDoc.set(c.document_id, [])
      byDoc.get(c.document_id)!.push(c.content ?? '')
    }
    let used = 0
    const parts: string[] = []
    const fullTextIds = new Set<string>()
    const truncatedIds = new Set<string>()
    for (const d of docs) {
      const text = (byDoc.get(d.id) ?? []).join('\n')
      if (!text) continue
      const room = CHAR_BUDGET - used
      if (room < 2000) break
      const slice = text.slice(0, room)
      parts.push(`===== DOCUMENT: "${d.title ?? d.file_name}" (type: ${d.doc_type}) =====\n${slice}`)
      used += slice.length
      if (slice.length >= text.length) fullTextIds.add(d.id)
      else truncatedIds.add(d.id)
    }

    // ── 3a. Briefs for docs BEYOND the raw-text budget (v7). The v27
    // abstractor synthesizes from compact briefs covering the WHOLE file; a
    // verifier that only sees raw text under CHAR_BUDGET has a NARROWER window
    // than the writer and produced false "instrument is not among the provided
    // documents" flags (Burlington's 2026 exercise letter, Wade Jurney's 4th
    // Amd). Every source doc that didn't fit as raw text rides along as its
    // structured brief, and the inventory below makes existence undeniable. ──
    const { data: briefRows } = await sb.from('doc_briefs')
      .select('document_id, doc_class, chain_role, brief, status')
      .in('document_id', docs.map(d => d.id))
    const briefBy = new Map<string, any>()
    for (const b of (briefRows ?? []) as any[]) if (b.status === 'complete' && b.brief) briefBy.set(b.document_id, b)
    const BRIEF_BUDGET = 150_000
    let briefChars = 0
    const briefParts: string[] = []
    const briefIncluded = new Set<string>()
    for (const d of docs) {
      if (fullTextIds.has(d.id)) continue          // full raw text already in
      const b = briefBy.get(d.id)
      if (!b) continue
      const json = JSON.stringify(b.brief)
      if (briefChars + json.length > BRIEF_BUDGET) continue
      briefParts.push(`===== BRIEF (100%-of-text extraction): "${d.title ?? d.file_name}" [${b.doc_class ?? '?'}/${b.chain_role ?? '?'}] =====\n${json}`)
      briefChars += json.length
      briefIncluded.add(d.id)
    }
    const inventory = docs.map((d: any) => {
      const how = fullTextIds.has(d.id) ? 'FULL RAW TEXT below'
        : briefIncluded.has(d.id) ? (truncatedIds.has(d.id) ? 'raw text TRUNCATED below + full brief below' : 'structured brief below')
        : truncatedIds.has(d.id) ? 'raw text TRUNCATED below'
        : 'IN FILE — title only in this request'
      return `- "${d.title ?? d.file_name}" [${d.doc_type}] — ${how}`
    }).join('\n')

    // ── 3b. Re-attach the governing PDFs (primary sources for verbatim quotes) ──
    const MAX_ATTACH_BYTES = 8_000_000
    const MAX_ATTACH_TOTAL = 20_000_000
    const mp = Number(body.max_pdfs)
    const MAX_ATTACH_DOCS = Number.isFinite(mp) ? Math.max(0, Math.min(mp, 5)) : 5
    let attachBytes = 0
    const attachable: any[] = []
    for (const d of docs) {
      if (attachable.length >= MAX_ATTACH_DOCS) break
      if (typeof d.storage_path !== 'string' || !d.storage_path.startsWith('p/')) continue
      const sz = Number(d.file_size_bytes)
      if (!(sz > 0) || sz > MAX_ATTACH_BYTES || attachBytes + sz > MAX_ATTACH_TOTAL) continue
      attachable.push(d)
      attachBytes += sz
    }
    let attachments: any[] = []
    if (attachable.length) {
      const { data: signedUrls } = await sb.storage.from('documents')
        .createSignedUrls(attachable.map((d: any) => d.storage_path), 3600)
      attachments = (signedUrls ?? [])
        .filter((s: any) => s.signedUrl)
        .map((s: any) => ({ type: 'document', source: { type: 'url', url: s.signedUrl } }))
    }

    // ── 3c. MRI system-of-record cross-check (independent ground truth) ──
    const { data: leaseRows } = await sb.from('leases')
      .select('id, status, commencement_date, expiration_date, leased_sf, security_deposit, ti_allowance, has_percentage_rent, percentage_rent_rate, natural_breakpoint, artificial_breakpoint, tenants!inner(name, trade_name)')
      .eq('property_id', propertyId)
    const tl = tenant.toLowerCase().trim()
    const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().trim()
    // Match the abstract's tenant to its MRI lease row. Exact match on trade
    // name or legal name FIRST; then a GUARDED substring match (both sides
    // non-empty, ≥4 chars). Never use includes('') — a null/empty trade_name
    // would otherwise match every tenant and feed the wrong row as ground truth.
    const leaseCands = (leaseRows ?? []) as any[]
    const leaseRow =
      leaseCands.find(l => { const t = norm(l.tenants?.trade_name), n = norm(l.tenants?.name); return (!!t && t === tl) || (!!n && n === tl) }) ??
      leaseCands.find(l => {
        for (const cand of [norm(l.tenants?.trade_name), norm(l.tenants?.name)]) {
          if (cand.length >= 4 && (tl.includes(cand) || cand.includes(tl))) return true
        }
        return false
      }) ?? null

    // MRI option data — RETAILRR-verified system of record for option notice
    // deadlines & exercise state. The v2 abstract carries options[].notice_by /
    // status; verify them against this payload.
    let mriOptions: any[] = []
    if (leaseRow?.id) {
      const { data: lo } = await sb.from('lease_options')
        .select('option_type, notice_days_required, notice_deadline, exercise_deadline, term_if_exercised_months, rent_at_exercise, is_exercised, requires_landlord_reminder, notes')
        .eq('lease_id', leaseRow.id)
      mriOptions = (lo ?? []) as any[]
    }
    const leaseRowOut = leaseRow ? { ...leaseRow, id: undefined } : null

    // ── 4. Verify ──
    const attachNote = attachments.length
      ? `\nThe ${attachments.length} attached PDF(s) are the PRIMARY SOURCES (${attachable.map((d: any) => `"${d.title ?? d.file_name}"`).join(', ')}). Quote from them for source_quote; the text excerpts below cover the remaining instruments.`
      : ''
    const prompt = `You are an independent QA reviewer auditing a commercial lease abstract produced by another analyst for M&J Wilkow. Your job is NOT to re-abstract the lease — it is to ADVERSARIALLY VERIFY the abstract below against the source documents. Assume it may contain errors and try to prove each material value wrong.${attachNote}

SOURCE FILE INVENTORY (every document the abstractor used — a document listed here EXISTS AND WAS AVAILABLE to the abstractor, full stop):
${inventory}

EXISTENCE DISCIPLINE (critical): NEVER claim an instrument "is not among the provided documents", "does not exist in the source documents", or set amendment_currency.current=false on the ground that a document is absent, when that document IS in the inventory above. Some documents arrive as structured BRIEFS (each extracted from 100% of that document's text) instead of raw text — a brief is full evidence of the document's existence and contents; judge from it exactly as you would from raw text. Only when a value can be confirmed by NEITHER the raw text NOR a brief NOR an attached PDF may you use needs_source — and an instrument referenced by the abstract that appears nowhere in the inventory may still be challenged as unsupported.

Method:
- For every HIGH-VALUE field (tenant legal name, suite, square footage, rent commencement, expiration, term length, every base_rent_schedule row, options, percentage rent rate/breakpoint, CAM methodology, guarantor, security deposit, tenant allowance, co-tenancy, exclusives, kickout/termination), locate the governing language in the documents and decide:
    confirmed    — the abstract value matches the source (quote it).
    discrepancy  — the source says something different (quote it; give the correct value in "note").
    unsupported  — the abstract asserts a value no document backs up.
    needs_source — the field can only be confirmed from a document NOT in this request (say which).
- THE LATEST AMENDMENT CONTROLS. Establish the amendment chain from the recitals. If the abstract reflects a term that a later amendment superseded (e.g. an expiration or rent step from the original lease when a Fourth Amendment extended it), that is a discrepancy AND set amendment_currency.current = false. This is the single most important check. Judge currency against the DOCUMENTS only — never set current=false just because MRI differs.
- MRI IS NOT A DOCUMENT. field_checks and amendment_currency judge the abstract against the LEASE DOCUMENTS ONLY. Any disagreement with the MRI system-of-record values goes in the separate "mri_reconciliation" array — NOT in field_checks. MRI is frequently stale or points to a different tenant/space (renamed units, old records); when the documents (especially the latest amendment) clearly control, set governs="abstract" and do NOT treat the abstract as wrong. Only when MRI is right and the abstract misread the documents does the abstract itself get a field_checks discrepancy.
- MRI RECONCILIATION IS A DISAGREEMENT LOG, NOT A CHECKLIST. Add a field to mri_reconciliation ONLY when the two sides materially disagree AND MRI is the system of record for that field. If they agree — including the same date or number written in a different format, or both being "no percentage rent" — DO NOT log it at all. Never write a reconciliation entry whose note says the sources agree.
- MRI DATE SEMANTICS. MRI's commencement_date and expiration_date reflect the CURRENT ACTIVE TERM — the start/end of the current option, renewal, or rent-schedule window — NOT the original lease commencement. This is expected and correct. Do NOT log a reconciliation entry merely because the abstract reports the ORIGINAL lease commencement (or original expiration) while MRI shows the current-term dates; that is two different fields, not a conflict. Log a date entry ONLY when the CURRENT-term commencement/expiration genuinely disagree with what the documents establish for that same current term.
- MRI DOES NOT GOVERN these — never put them in mri_reconciliation: security deposit, TI/tenant allowance, natural/artificial breakpoint, guarantor, and tenant legal-name vs trade-name/DBA formatting. The documents are the source of truth for those; a difference from MRI there is not an MRI error.
- source_quote MUST be verbatim text copied from the documents — never paraphrase, never invent a citation. If you cannot find supporting text, source_quote = "" and verdict is unsupported or needs_source.
- Only list a field in field_checks if you actually examined the source for it. Do not pad with trivially-confirmed fields; prioritise money, dates, and the amendment chain.
- ABSTRACTION-STANDARD CHECKS (v2 abstracts; skip any the abstract's shape predates):
    DATE HYGIENE — term.* and options[].notice_by and critical_dates[].date must be bare ISO dates (YYYY-MM-DD) or null; a date field containing prose/parentheticals/formulas is a discrepancy (severity medium).
    DOCUMENT TAXONOMY — lease_documents must contain ONLY operative instruments and executed ancillary instruments. Any correspondence, email, default/past-due notice, force-majeure letter, CAM reconciliation, sales report, or invoice listed there is a discrepancy (field "lease_documents", severity medium).
    EXCLUSIVES DISCIPLINE — exclusives.exact_language must actually restrict the LANDLORD/other occupants for THIS tenant's benefit. Language that restricts the tenant itself, lists OTHER tenants' protections (exhibit schedules), or merely cites an MRI note code is a discrepancy: it belongs in use_restrictions_on_tenant/prohibited_uses (severity high — this poisons leasing decisions).
    OPTION LIFECYCLE — each options[] entry: status consistent with the documents and the MRI option data below (an executed exercise notice or amendment reciting exercise ⇒ exercised; a later amendment voiding it ⇒ superseded); notice_by must equal the MRI notice_deadline when one exists for that option (disagreement ⇒ mri_reconciliation entry with governs per the durable rule: MRI is the system of record for option notice dates) or be consistent with the notice period arithmetic otherwise.
    GUARANTY CHAIN — guaranty_chain events must trace to executed instruments in the sources; the derived guarantor.name must equal the chain's current/surviving guarantor(s). An assignment in the chain silent on release ⇒ status "surviving", not "released".
- Run the arithmetic checks: monthly rent × 12 vs. annual; annual vs. $PSF × square footage; rent_commencement + term_years vs. expiration. Set ok=false ONLY for a GENUINE numeric contradiction between values the documents STATE. If a figure simply cannot be computed or confirmed (e.g. a formula-based date with an unknown input), that is NOT an arithmetic failure — leave it out of arithmetic and record a needs_source field_check instead.

Call the submit_qa tool with an object matching this schema exactly (all keys present):
${QA_SCHEMA}
${leaseRowOut ? `\nMRI system-of-record values (a SEPARATE system, NOT one of the lease documents — use ONLY to populate mri_reconciliation; do not treat as document truth): ${JSON.stringify(leaseRowOut)}` : ''}
${mriOptions.length ? `\nMRI option data (RETAILRR-verified; system of record for option notice deadlines & exercise state): ${JSON.stringify(mriOptions)}` : ''}

THE ABSTRACT UNDER REVIEW (produced by model "${row.model ?? 'unknown'}", with any human corrections applied):
${JSON.stringify(auditAbstract)}

SOURCE DOCUMENTS (raw text):
${parts.join('\n\n')}
${briefParts.length ? `\nSOURCE DOCUMENTS (structured briefs — each extracted from 100% of the document's text; full evidence of existence and contents):\n${briefParts.join('\n\n')}` : ''}`

    const textPrompt = attachments.length && used > 150_000
      ? prompt.slice(0, prompt.length - used + 150_000)
      : prompt
    const isCapError = (e: unknown) =>
      /page|too long|too large|exceed|prompt is too long/i.test(e instanceof Error ? e.message : String(e))
    let qa: any
    try {
      qa = await verifyJson(anthropicKey, openaiKey, MODEL,[...attachments, { type: 'text', text: textPrompt }], 16000)
    } catch (e) {
      if (!attachments.length || !isCapError(e)) throw e
      if (attachments.length > 2) {
        try {
          attachments = attachments.slice(0, 2)
          qa = await verifyJson(anthropicKey, openaiKey, MODEL,[...attachments, { type: 'text', text: textPrompt }], 16000)
        } catch (e2) {
          if (!isCapError(e2)) throw e2
          qa = await verifyJson(anthropicKey, openaiKey, MODEL,[{ type: 'text', text: prompt }], 16000)
          attachments = []
        }
      } else {
        qa = await verifyJson(anthropicKey, openaiKey, MODEL,[{ type: 'text', text: prompt }], 16000)
        attachments = []
      }
    }

    const qaStatus = deriveStatus(qa)

    // ── 5. Save ──
    const { error: upErr } = await sb.from('lease_abstracts')
      .update({
        qa,
        qa_status: qaStatus,
        qa_model: MODEL,
        qa_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('property_id', propertyId)
      .eq('tenant_name', tenant)
    if (upErr) throw new Error('save failed: ' + upErr.message)

    return new Response(JSON.stringify({
      success: true, tenant, property_id: propertyId,
      qa_status: qaStatus, pdf_sources: attachments.length, docs_reviewed: docs.length, qa,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
