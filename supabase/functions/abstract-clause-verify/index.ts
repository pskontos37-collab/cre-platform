// abstract-clause-verify — clause-specialist verification layer.
//
// The single verifier (abstract-verify) and the 2-lens ensemble
// (abstract-ensemble) are GENERALISTS: one prompt spread across many fields.
// They catch wrong scalar values, but a generalist pass/fail check structurally
// cannot produce the "the value is right but a MATERIAL NUANCE is missing"
// finding, and it does not carry deep per-clause domain rules. This function
// runs N single-clause SPECIALISTS CONCURRENTLY, each seeing only its own deep
// rubric plus the shared brief/MRI/registry evidence:
//   - exclusives  — beneficiary test; missing-exhibit gap => cannot_verify.
//   - options     — sequenced-option notice math; MRI reconcile; open vs exercised.
//   - guaranty    — succession (silence != release); springing/release/replacement
//                   conditions and null-and-void contingencies = landlord risk.
//   - cotenancy   — co-tenancy (tenant remedy) vs go-dark waiver + landlord recapture.
//
// Prototype (Qdoba stress + Athlete's Foot control, 2026-07-17): 4/4 material
// catches the generalists missed on the hard tenant; 0 false positives on the
// clean one. See docs/clause-specialist-findings.md.
//
// Output = clause_findings (migration 20240113): a SEPARATE provenance layer
// from open_items (generator), qa (verifier), and field_confidence (ensemble);
// it never clobbers any of them. Actionable findings use worklist key
// 'field:' || lower(field) so one resolution clears every layer's item about the
// same field. STICKY HUMAN DECISIONS: a field a human already ruled on
// (locked/human_verified/override/resolution) is marked settled and never raised
// as a fresh red flag. DETECTION ONLY — no auto-correct (auto-apply is proven
// unsafe; corrections flow through the human worklist).
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.
// Optional: OPENAI_API_KEY (fallback + cross-model adjudication), QA_MODEL, QA_OPENAI_MODEL.
// Usage: POST JSON { property_id: uuid, tenant: string, only?: string[], cross_model?: bool }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canReadProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

const MODEL = Deno.env.get('QA_MODEL') ?? 'claude-opus-4-8'
const QA_OPENAI_MODEL = Deno.env.get('QA_OPENAI_MODEL') ?? 'gpt-4.1'
const BRIEF_BUDGET = 150_000
const MAX_CROSS_MODEL = 8            // cap cross-model adjudications per run (cost/latency)

// Layer reviewer overrides (dotted-path -> value) over the AI abstract so the
// specialists audit the HUMAN-CORRECTED values. Identical to abstract-ensemble /
// abstract-verify / AbstractsPage.tsx.
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

// Forced tool-use so a specialist verdict comes back as parsed JSON (quoted lease
// language can never break parsing). Mirrors abstract-ensemble.anthropicJson.
async function anthropicJson(key: string, model: string, content: any[], maxTokens: number): Promise<any> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      tools: [{ name: 'submit_findings', description: 'Submit the clause-specialist findings.', input_schema: { type: 'object', additionalProperties: true } }],
      tool_choice: { type: 'tool', name: 'submit_findings' },
      messages: [{ role: 'user', content }],
    }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Anthropic API error: ' + JSON.stringify(d))
  if (d.stop_reason === 'max_tokens') throw new Error('Specialist truncated at max_tokens — retry')
  const block = (d.content ?? []).find((c: { type: string }) => c.type === 'tool_use')
  if (!block) throw new Error('Model returned no tool_use block')
  return block.input
}

async function openaiJson(key: string, content: any[], maxTokens: number): Promise<any> {
  const oai: any[] = []
  for (const c of content) if (c.type === 'text') oai.push({ type: 'input_text', text: c.text })
  oai.push({ type: 'input_text', text: 'Return ONLY a single valid JSON object as described — no markdown, no commentary.' })
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
  if (d.status === 'incomplete') throw new Error('Adjudicator truncated — retry')
  let out = typeof d.output_text === 'string' ? d.output_text : ''
  if (!out) for (const item of (d.output ?? [])) for (const cc of (item.content ?? [])) if (cc.type === 'output_text') out += cc.text ?? ''
  return JSON.parse(out)
}

function isOverloaded(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e)
  return /overloaded_error|"Overloaded"|\b529\b|rate_limit|too many requests|credit balance|Plans & Billing|insufficient|billing/i.test(m)
}
async function specialistJson(aKey: string, oKey: string, content: any[], maxTokens: number): Promise<any> {
  try { return await anthropicJson(aKey, MODEL, content, maxTokens) }
  catch (e) {
    if (oKey && isOverloaded(e)) return await openaiJson(oKey, content, maxTokens)
    throw e
  }
}

const norm = (v: any): string => {
  const s = (typeof v === 'string' ? v : JSON.stringify(v ?? '')).trim().toLowerCase()
  const num = s.replace(/[$,\s]/g, '')
  if (/^-?\d+(\.\d+)?$/.test(num)) return String(Number(num))
  return s.replace(/\s+/g, ' ')
}
const str = (v: any) => v == null ? 'null' : (typeof v === 'string' ? v : JSON.stringify(v))

// ── The clause specialists. Each audits only its own field(s) with a deep
// domain rubric. `present` gates the specialist: it runs only when its clause is
// worth checking (avoids paying for a specialist on a field the abstract has no
// data for AND that neither MRI nor the registry implicates). `fields` are the
// abstract paths it owns (used for worklist keying + sticky-decision skip). ──
const SPECIALISTS = [
  {
    name: 'exclusives',
    fields: ['exclusives.exists', 'exclusives.exact_language'],
    // Always run — exists=false is exactly the case the missing-exhibit test targets.
    present: (_a: any) => true,
    rubric: `You are the EXCLUSIVE-USE specialist. Depth rules:
- exists=true is correct ONLY if a QUOTED covenant restricts the LANDLORD or other occupants FOR THIS TENANT'S benefit. Permitted-use language, use-restrictions ON this tenant, another tenant's exclusive quoted in an exhibit, an MRI flag, a no-conflict warranty, or a radius clause do NOT make exists=true.
- CRITICAL GAP TEST: if the tenant's own exclusive covenant would live in an exhibit/schedule that is NOT in the file (e.g. an "Exhibit E - Prohibited and Exclusive Uses" referenced but not attached), then exists=false is NOT verifiable — return verdict "cannot_verify" and name the missing exhibit. A confident exists=false on a missing-exhibit lease is a defect.
- Check carve-outs (existing-tenant grandfathering), conditions (open/operating/not-in-default), and remedies (substitute rent / go-dark / termination). If a stored exclusive is correct but omits a material carve-out or remedy, use verdict "enrich".`,
  },
  {
    name: 'options',
    fields: ['options'],
    present: (a: any) => {
      const o = a?.options
      const arr = Array.isArray(o) ? o : (o && Array.isArray(o.options) ? o.options : [])
      return arr.length > 0
    },
    rubric: `You are the RENEWAL-OPTION specialist. Depth rules:
- SEQUENCED OPTIONS: the Nth renewal's notice deadline is computed from the expiration of the (N-1)th renewal period, so two consecutive options CANNOT share the same notice_by date unless the documents explicitly say so. Two open options showing an identical notice_by is almost always a defect — verdict "revise", give the corrected date logic.
- notice_by must reconcile with MRI RETAILRR (system of record for option notice deadlines) where MRI has an entry.
- Distinguish open vs exercised; superseded original-lease options should be marked exercised/superseded, not open.
- If the stored options value is empty/[]/an object-wrapper while the documents clearly describe renewal options, that is a high-severity structural defect (verdict "revise").`,
  },
  {
    name: 'guaranty',
    fields: ['guarantor.name', 'guaranty_chain'],
    present: (a: any) => !!(a?.guarantor?.exists || a?.guarantor?.name || a?.guaranty_chain),
    rubric: `You are the GUARANTY specialist. Depth rules:
- Succession through assignments: an assignment SILENT on release does NOT release the prior guarantor/assignor — that party stays surviving. A guarantor dropped on that basis is a defect (verdict "revise").
- SPRINGING guaranties (obligation triggered by a future condition) and RELEASE/REPLACEMENT conditions (e.g. individual guarantors released once N stores open; group replaceable by a $X net-worth guarantor) and NULL-AND-VOID contingencies (guaranty void if a closing notice is not received by a deadline) are MATERIAL LANDLORD RISK. If the stored guarantor name is right but these conditions are not surfaced, verdict "enrich" and state the condition + its trigger/date. A bare correct name is insufficient if the guaranty can evaporate.
- Identify who is CURRENTLY liable and any residual liability window of a prior tenant/assignor.`,
  },
  {
    name: 'cotenancy',
    fields: ['co_tenancy'],
    present: (a: any) => !!a?.co_tenancy,
    rubric: `You are the CO-TENANCY / CONTINUOUS-OPERATIONS specialist. Depth rules:
- Distinguish precisely: (a) CO-TENANCY = TENANT remedy (rent abatement / reduced rent / termination) triggered when occupancy or a named anchor drops below a threshold; (b) CONTINUOUS-OPERATIONS / GO-DARK WAIVER = tenant relieved of the duty to stay open under stated conditions; (c) KICK-OUT = termination right tied to sales. These are frequently mislabeled.
- If a clause stored as "co_tenancy" is actually a go-dark waiver coupled with a LANDLORD recapture/termination right, verdict "revise" on the characterization — the remedy runs to the landlord, which is materially different from a tenant co-tenancy protection.
- Surface the exact trigger threshold, cure/reopen mechanics, and which party holds the remedy.`,
  },
]

const FINDING_SCHEMA = `{ "findings": [ {
  "field": str,                                   // echo one of the field paths for your clause EXACTLY
  "verdict": "confirm"|"revise"|"cannot_verify"|"enrich",
  "severity": "high"|"medium"|"low",
  "current_value": str,                            // the stored value you evaluated (short)
  "correct_value": str|null,                       // what it should be (for revise), else null
  "missing_nuance": str|null,                      // for enrich: the material nuance not captured, else null
  "citation": str,                                 // document + section
  "quote": str,                                    // VERBATIM supporting text from the briefs
  "rationale": str                                 // one sentence
} ] }`

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const caller = await requireUser(req, sb)

    const body = await req.json().catch(() => ({}))
    const propertyId: string = body.property_id ?? ''
    const tenant: string = (body.tenant ?? '').trim()
    const only: string[] | null = Array.isArray(body.only) && body.only.length ? body.only.map((s: any) => String(s)) : null
    const crossModel: boolean = body.cross_model !== false     // default ON (accuracy over cost)
    if (!propertyId || !tenant) throw new Error('property_id and tenant are required')
    if (!canReadProperty(caller, propertyId)) throw new AuthError('No access to this property', 403)

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')
    const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? ''

    // ── 1. The abstract (human-corrected values applied) ──
    const { data: row, error: rErr } = await sb.from('lease_abstracts')
      .select('id, abstract, overrides, source_doc_ids, locked, human_verified')
      .eq('property_id', propertyId).eq('tenant_name', tenant).maybeSingle()
    if (rErr) throw new Error('load abstract failed: ' + rErr.message)
    if (!row || !row.abstract) throw new Error(`No abstract exists for "${tenant}" — generate it first`)
    const auditAbstract = applyOverrides(row.abstract, row.overrides)
    const sourceIds: string[] = Array.isArray(row.source_doc_ids) ? row.source_doc_ids : []

    // ── 1a. STICKY HUMAN DECISIONS (mirror abstract-ensemble). A field a human
    // has ruled on (locked/human_verified/override/non-archived resolution) is
    // SETTLED: a specialist finding about it is marked settled and never raised
    // as a fresh red worklist item. ──
    const { data: resRows } = await sb.from('abstract_item_resolutions')
      .select('item_key, status, archived')
      .eq('abstract_id', row.id).eq('archived', false)
    const settledKeys = new Set<string>()
    const wholeAbstractSettled = row.locked === true || row.human_verified === true
    for (const p of Object.keys((row.overrides && typeof row.overrides === 'object') ? row.overrides : {})) {
      settledKeys.add(`field:${p.toLowerCase()}`)
    }
    for (const r of (resRows ?? []) as any[]) {
      if (['accepted', 'waived', 'corrected'].includes(r.status)) settledKeys.add(String(r.item_key).toLowerCase())
    }
    const isSettled = (field: string) => wholeAbstractSettled || settledKeys.has(`field:${field.toLowerCase()}`)

    // ── 2. Source-doc briefs (100%-of-text extractions) ──
    const { data: sdocs } = await sb.from('documents')
      .select('id, doc_type, title, file_name')
      .in('id', sourceIds.length ? sourceIds : ['00000000-0000-0000-0000-000000000000'])
    const orderIdx = new Map(sourceIds.map((id, i) => [id, i]))
    const docs = ((sdocs ?? []) as any[]).sort((a, b) => (orderIdx.get(a.id) ?? 999) - (orderIdx.get(b.id) ?? 999))
    const { data: briefRows } = await sb.from('doc_briefs')
      .select('document_id, doc_class, chain_role, brief, status')
      .in('document_id', docs.length ? docs.map(d => d.id) : ['00000000-0000-0000-0000-000000000000'])
    const briefBy = new Map<string, any>()
    for (const b of (briefRows ?? []) as any[]) if (b.status === 'complete' && b.brief) briefBy.set(b.document_id, b)
    let briefChars = 0
    const briefParts: string[] = []
    for (const d of docs) {
      const b = briefBy.get(d.id)
      if (!b) continue
      const json = JSON.stringify(b.brief)
      if (briefChars + json.length > BRIEF_BUDGET) continue
      briefParts.push(`===== BRIEF (100%-of-text): "${d.title ?? d.file_name}" [${b.doc_class ?? '?'}/${b.chain_role ?? '?'}] =====\n${json}`)
      briefChars += json.length
    }
    const inventory = docs.map((d: any) => `- "${d.title ?? d.file_name}" [${d.doc_type}]`).join('\n')

    // ── 3. MRI system-of-record (options are the reconciler ground truth) ──
    const { data: leaseRows } = await sb.from('leases')
      .select('id, commencement_date, expiration_date, leased_sf, has_percentage_rent, has_co_tenancy_clause, tenants!inner(name, trade_name)')
      .eq('property_id', propertyId)
    const tl = tenant.toLowerCase().trim()
    const nm = (s: string | null | undefined) => (s ?? '').toLowerCase().trim()
    const cands = (leaseRows ?? []) as any[]
    const leaseRow =
      cands.find(l => { const t = nm(l.tenants?.trade_name), n = nm(l.tenants?.name); return (!!t && t === tl) || (!!n && n === tl) }) ??
      cands.find(l => { for (const c of [nm(l.tenants?.trade_name), nm(l.tenants?.name)]) if (c.length >= 4 && (tl.includes(c) || c.includes(tl))) return true; return false }) ?? null
    let mriOptions: any[] = []
    if (leaseRow?.id) {
      const { data: lo } = await sb.from('lease_options')
        .select('option_type, notice_days_required, notice_deadline, exercise_deadline, is_exercised, requires_landlord_reminder, notes')
        .eq('lease_id', leaseRow.id)
      mriOptions = (lo ?? []) as any[]
    }
    const leaseOut = leaseRow ? { ...leaseRow, id: undefined } : null

    // ── 3a. EXCLUSIVES-OWNERSHIP REGISTRY (migration 20240112). Deterministic
    // guard: reject a specialist asserting THIS tenant holds an exclusive the
    // registry/structure says belongs to another tenant (the misattribution class). ──
    const { data: registryRows } = await sb.from('property_exclusives')
      .select('owner_tenant, keywords').eq('property_id', propertyId)
    const foreignOwners: string[] = []
    const foreignKeywords: string[] = []
    for (const e of (registryRows ?? []) as any[]) {
      if (nm(e.owner_tenant) === tl) continue
      const owner = nm(e.owner_tenant)
      if (owner.length >= 4) foreignOwners.push(owner)
      for (const kw of (Array.isArray(e.keywords) ? e.keywords : [])) {
        const k = String(kw).toLowerCase().trim()
        if (k.length >= 4 && k !== tl) foreignKeywords.push(k)
      }
    }
    const guardExclusive = (field: string, f: any): string | null => {
      if (!field.startsWith('exclusives')) return null
      // Only guard an ASSERTION that this tenant HOLDS an exclusive (exists->true
      // or exact_language populated from empty). cannot_verify/enrich/confirm are safe.
      const asserts = (f.verdict === 'revise' || f.verdict === 'enrich') &&
        ((field === 'exclusives.exists' && norm(f.correct_value) === 'true') ||
         (field === 'exclusives.exact_language' && f.correct_value != null && String(f.correct_value).trim() !== ''))
      if (!asserts) return null
      const hay = `${f.correct_value ?? ''} ${f.quote ?? ''} ${f.citation ?? ''}`.toLowerCase()
      if (/existing\s+exclusiv/.test(hay)) return 'cites an "Existing Exclusives" exhibit — another tenant\'s protection, not this tenant\'s'
      for (const o of foreignOwners) if (hay.includes(o)) return `attributes an exclusive registered to another tenant ("${o}")`
      for (const k of foreignKeywords) if (hay.includes(k)) return `matches a registry exclusive owned by another tenant ("${k}")`
      return null
    }

    // ── 4. Gate + run the specialists CONCURRENTLY ──
    const baseContext = `SOURCE FILE INVENTORY (every document exists and was available):
${inventory || '(no source documents recorded)'}
${leaseOut ? `\nMRI system-of-record values (a SEPARATE system, NOT a lease document): ${JSON.stringify(leaseOut)}` : ''}
${mriOptions.length ? `\nMRI option data (RETAILRR-verified; system of record for option notice deadlines & exercise state): ${JSON.stringify(mriOptions)}` : ''}

CURRENT STORED ABSTRACT VALUES (what you are auditing):
exclusives = ${str(auditAbstract?.exclusives)}
permitted_use = ${str(auditAbstract?.permitted_use)}
use_restrictions_on_tenant = ${str(auditAbstract?.use_restrictions_on_tenant)}
options = ${str(auditAbstract?.options)}
guarantor = ${str(auditAbstract?.guarantor)}
guaranty_chain = ${str(auditAbstract?.guaranty_chain)}
co_tenancy = ${str(auditAbstract?.co_tenancy)}

SOURCE DOCUMENT BRIEFS (each extracted from 100% of the document's text — full evidence of contents):
${briefParts.join('\n\n') || '(no briefs available)'}`

    const toRun = SPECIALISTS.filter(sp => (!only || only.includes(sp.name)) && sp.present(auditAbstract))
    const skipped = SPECIALISTS.filter(sp => !toRun.includes(sp)).map(sp => sp.name)

    const runSpecialist = async (sp: typeof SPECIALISTS[number]) => {
      const prompt = `You are a single-clause specialist auditing a commercial lease abstract for M&J Wilkow. Audit ONLY the field(s) in your domain: ${sp.fields.join(', ')}. Do not comment on other clauses.

${sp.rubric}

Evaluate the current stored value against the briefs and MRI. Verify clean values too (do not only hunt for errors); when the stored value is right yet a material nuance is missing, use verdict "enrich". Ground every finding in a verbatim quote from the briefs. Emit one finding per field in your domain.

${baseContext}

Call submit_findings with an object matching this schema exactly:
${FINDING_SCHEMA}`
      try {
        const out = await specialistJson(anthropicKey, openaiKey, [{ type: 'text', text: prompt }], 2500)
        const findings = Array.isArray(out?.findings) ? out.findings : []
        return { specialist: sp.name, findings }
      } catch (e) {
        return { specialist: sp.name, findings: [], error: e instanceof Error ? e.message : String(e) }
      }
    }
    const results = await Promise.all(toRun.map(runSpecialist))
    const errors = results.filter(r => r.error).map(r => `${r.specialist}: ${r.error}`)
    if (toRun.length > 0 && results.every(r => r.error)) throw new Error('all specialists failed :: ' + errors.join(' | '))

    // ── 5. Normalize findings; apply registry guard + sticky-decision settling ──
    const validFields = new Set(SPECIALISTS.flatMap(s => s.fields))
    const findings: any[] = []
    for (const r of results) {
      const sp = SPECIALISTS.find(s => s.name === r.specialist)!
      for (const raw of r.findings) {
        let field = String(raw?.field ?? '').trim()
        if (!validFields.has(field)) field = sp.fields[0]     // coerce to an owned field
        const verdict = ['confirm', 'revise', 'cannot_verify', 'enrich'].includes(raw?.verdict) ? raw.verdict : 'confirm'
        const severity = ['high', 'medium', 'low'].includes(raw?.severity) ? raw.severity : 'medium'
        const f: any = {
          specialist: sp.name, field, verdict, severity,
          current_value: raw?.current_value ?? null, correct_value: raw?.correct_value ?? null,
          missing_nuance: raw?.missing_nuance ?? null, citation: raw?.citation ?? '',
          quote: raw?.quote ?? '', rationale: raw?.rationale ?? '',
          settled: isSettled(field), cross_model: null,
        }
        const rej = guardExclusive(field, f)
        if (rej) { f.verdict = 'confirm'; f.guarded = rej; f.severity = 'low' }
        findings.push(f)
      }
    }

    // ── 5a. CROSS-MODEL ADJUDICATION (default on). Break the shared blind spot:
    // an independent OpenAI model reviews each HIGH-severity actionable finding
    // and votes confirm/refute/uncertain from the same cited evidence. A refuted
    // finding is downgraded (kept, but not red) so a single-model false positive
    // does not reach the worklist. Capped for cost/latency. ──
    const actionableVerdicts = new Set(['revise', 'cannot_verify', 'enrich'])
    if (crossModel && openaiKey) {
      const targets = findings
        .filter(f => actionableVerdicts.has(f.verdict) && f.severity === 'high' && !f.settled && !f.guarded)
        .slice(0, MAX_CROSS_MODEL)
      const adjudicate = async (f: any) => {
        const prompt = `You are an independent second reviewer (different model family) breaking a possible shared blind spot. A clause specialist made this finding about a commercial lease abstract. Using the cited evidence and your own judgment, decide whether it is CORRECT and MATERIAL.

FIELD: ${f.field}
SPECIALIST VERDICT: ${f.verdict} (${f.severity})
STORED VALUE: ${str(f.current_value)}
PROPOSED CORRECTION / NUANCE: ${str(f.correct_value ?? f.missing_nuance)}
CITATION: ${f.citation}
VERBATIM QUOTE THE SPECIALIST RELIED ON: "${f.quote}"
RATIONALE: ${f.rationale}

Reply with a JSON object: { "verdict": "confirm"|"refute"|"uncertain", "note": "one sentence" }. Confirm only if the quote genuinely supports the finding and it is material; refute if the finding is wrong or immaterial; uncertain if the quote is insufficient.`
        try {
          const out = await openaiJson(openaiKey, [{ type: 'text', text: prompt }], 300)
          const v = ['confirm', 'refute', 'uncertain'].includes(out?.verdict) ? out.verdict : 'uncertain'
          f.cross_model = { verdict: v, note: out?.note ?? '' }
          if (v === 'refute') f.severity = 'low'      // downgrade so a refuted finding is not red
        } catch (e) {
          f.cross_model = { verdict: 'error', note: e instanceof Error ? e.message : String(e) }
        }
      }
      await Promise.all(targets.map(adjudicate))
    }

    // ── 6. Assemble + save (own column — never touches abstract/open_items/qa/field_confidence) ──
    const actionable = findings.filter(f => actionableVerdicts.has(f.verdict) && !f.settled && f.cross_model?.verdict !== 'refute')
    const clauseFindings = {
      generated_at: new Date().toISOString(),
      model: MODEL,
      cross_model: crossModel && !!openaiKey ? QA_OPENAI_MODEL : null,
      specialists: toRun.map(s => s.name),
      skipped,
      errors,
      findings,
      summary: {
        run: toRun.length,
        confirm: findings.filter(f => f.verdict === 'confirm').length,
        revise: findings.filter(f => f.verdict === 'revise').length,
        enrich: findings.filter(f => f.verdict === 'enrich').length,
        cannot_verify: findings.filter(f => f.verdict === 'cannot_verify').length,
        actionable: actionable.length,
        settled: findings.filter(f => f.settled).length,
      },
    }

    const { error: upErr } = await sb.from('lease_abstracts')
      .update({ clause_findings: clauseFindings, clause_findings_model: MODEL, clause_findings_at: clauseFindings.generated_at, updated_at: new Date().toISOString() })
      .eq('property_id', propertyId).eq('tenant_name', tenant)
    if (upErr) throw new Error('save failed: ' + upErr.message)

    return new Response(JSON.stringify({ success: true, tenant, property_id: propertyId, summary: clauseFindings.summary, actionable, skipped, errors }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
