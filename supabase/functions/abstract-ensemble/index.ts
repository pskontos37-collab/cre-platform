// abstract-ensemble — Stage 2 of the parallel+ensemble abstraction upgrade
// (docs/abstraction-parallel-ensemble-plan.md).
//
// The single-pass abstractor + single verifier still let a class of errors
// through: false-NEGATIVE "clean" verdicts (the Athlete's Foot exclusive that
// slipped because the audit only adversarially checked DEFECTS), and contested
// corrections nobody scored. This function cross-checks the HIGH-STAKES fields
// with TWO independent, differently-FRAMED model lenses and scores their
// AGREEMENT with the stored value:
//   - Lens "beneficiary" — exclusives beneficiary-test, use-restriction-vs-
//     exclusive, guaranty succession (silence != release). Assumes the abstract
//     may have filed permitted-use or another tenant's exclusive as this
//     tenant's own.
//   - Lens "reconciler" — latest-amendment-controls for expiration/rent, option
//     notice_by vs MRI RETAILRR, current-term rent. Assumes a superseded term
//     or a wrong option date.
// Diversity comes from framing + independent calls (a shared prompt shares blind
// spots). The two lenses run CONCURRENTLY, so the accuracy layer costs ~one extra
// call of latency, not two.
//
// Output = a per-field confidence map + a disagreement list, written to
// lease_abstracts.field_confidence (migration 20240110). This is a SEPARATE
// provenance layer from open_items (generator) and qa (verifier); it never
// clobbers either. Disagreement keys use 'field:' || lower(field) so one
// resolution clears the generator/verifier/ensemble item about the same field.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.
// Optional: OPENAI_API_KEY (fallback), QA_MODEL, QA_OPENAI_MODEL.
// Usage: POST JSON { property_id: uuid, tenant: string }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canReadProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

const MODEL = Deno.env.get('QA_MODEL') ?? 'claude-opus-4-8'
const QA_OPENAI_MODEL = Deno.env.get('QA_OPENAI_MODEL') ?? 'gpt-4.1'
const BRIEF_BUDGET = 150_000

// Layer reviewer overrides (dotted-path -> value) over the AI abstract so the
// lenses cross-check the HUMAN-CORRECTED values (a corrected field must read as
// corrected, not re-flag). Kept identical to applyOverrides in abstract-verify /
// AbstractsPage.tsx.
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

// Forced tool-use so a lens verdict comes back as parsed JSON (quoted lease
// language can never break parsing). Mirrors abstract-verify.anthropicJson.
async function anthropicJson(key: string, model: string, content: any[], maxTokens: number): Promise<any> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      tools: [{ name: 'submit_checks', description: 'Submit the cross-check verdicts.', input_schema: { type: 'object', additionalProperties: true } }],
      tool_choice: { type: 'tool', name: 'submit_checks' },
      messages: [{ role: 'user', content }],
    }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Anthropic API error: ' + JSON.stringify(d))
  if (d.stop_reason === 'max_tokens') throw new Error('Lens truncated at max_tokens — retry')
  const block = (d.content ?? []).find((c: { type: string }) => c.type === 'tool_use')
  if (!block) throw new Error('Model returned no tool_use block')
  return block.input
}

async function openaiJson(key: string, content: any[], maxTokens: number): Promise<any> {
  const oai: any[] = []
  for (const c of content) if (c.type === 'text') oai.push({ type: 'input_text', text: c.text })
  oai.push({ type: 'input_text', text: 'Return ONLY a single valid JSON object with a "checks" array as described — no markdown, no commentary.' })
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
  if (d.status === 'incomplete') throw new Error('Lens truncated at max_output_tokens — retry')
  let out = typeof d.output_text === 'string' ? d.output_text : ''
  if (!out) for (const item of (d.output ?? [])) for (const cc of (item.content ?? [])) if (cc.type === 'output_text') out += cc.text ?? ''
  return JSON.parse(out)
}

function isOverloaded(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e)
  return /overloaded_error|"Overloaded"|\b529\b|rate_limit|too many requests|credit balance|Plans & Billing|insufficient|billing/i.test(m)
}
async function lensJson(aKey: string, oKey: string, content: any[], maxTokens: number): Promise<any> {
  try { return await anthropicJson(aKey, MODEL, content, maxTokens) }
  catch (e) {
    if (oKey && isOverloaded(e)) return await openaiJson(oKey, content, maxTokens)
    throw e
  }
}

// ── The high-stakes fields the lenses cross-check. Kept small and economically
// significant — these are the recurring defect classes from the audit log. ──
const str = (v: any) => v == null ? 'null' : (typeof v === 'string' ? v : JSON.stringify(v))
function extractHighStakes(a: any): Array<{ field: string; value: string }> {
  const ex = a?.exclusives ?? {}
  const opts = (Array.isArray(a?.options) ? a.options : []).map((o: any) => ({ term: o?.term, status: o?.status, notice_by: o?.notice_by }))
  const brs = (Array.isArray(a?.base_rent_schedule) ? a.base_rent_schedule : []).map((r: any) => ({ start: r?.start, end: r?.end, psf: r?.psf, monthly: r?.monthly, annual: r?.annual }))
  return [
    { field: 'exclusives.exists', value: str(ex.exists) },
    { field: 'exclusives.exact_language', value: str(ex.exact_language) },
    { field: 'term.expiration', value: str(a?.term?.expiration) },
    { field: 'guarantor.name', value: str(a?.guarantor?.name) },
    { field: 'options', value: JSON.stringify(opts) },
    { field: 'base_rent_schedule', value: JSON.stringify(brs) },
  ]
}

// Normalize a value for deterministic equality: ISO date, number, or collapsed
// lowercase text. Lets the reconciler treat "2030-01-31" == " 2030-01-31 " and
// 472500 == 472500.0 as agreement even when a lens echoes a different format.
function norm(v: any): string {
  const s = (typeof v === 'string' ? v : JSON.stringify(v ?? '')).trim().toLowerCase()
  const num = s.replace(/[$,\s]/g, '')
  if (/^-?\d+(\.\d+)?$/.test(num)) return String(Number(num))
  return s.replace(/\s+/g, ' ')
}

const LENSES = [
  {
    name: 'beneficiary',
    framing: `You are the BENEFICIARY-TEST lens. Be skeptical that the abstract confused, in this tenant's favor, something that is not actually the tenant's own landlord-restricting covenant. For exclusives.exists / exact_language: exists=true is correct ONLY if a quoted covenant RESTRICTS THE LANDLORD or other occupants FOR THIS TENANT'S benefit. Permitted-use language, use-restrictions ON this tenant, another tenant's exclusive listed in an exhibit, a mere MRI flag/summary, a no-conflict warranty, or a radius clause do NOT make exists=true — verdict "disagree" with correct_value "false" if so. For guarantor.name: the current/surviving guarantor derived from the chain; an assignment silent on release does NOT release the assignor (status surviving), so a guarantor dropped on that basis is a "disagree".`,
  },
  {
    name: 'reconciler',
    framing: `You are the RECONCILER lens. Be skeptical that the abstract carries a SUPERSEDED term or a wrong date. THE LATEST AMENDMENT CONTROLS: term.expiration and base_rent_schedule must reflect the newest instrument that reset them, never an original-lease value a later amendment replaced. For options[].notice_by: it must equal the MRI notice_deadline when one exists for that option (MRI RETAILRR is the system of record for option notice dates); a materially different or missing notice_by is a "disagree" with the MRI date as correct_value. For base_rent_schedule: the CURRENT controlling schedule only — superseded or invented rows are a "disagree".`,
  },
]

const CHECK_SCHEMA = `{ "checks": [ {
  "field": str,                                  // echo the field name EXACTLY as given
  "verdict": "agree"|"disagree"|"cant_verify",   // agree = stored value is correct per the documents; disagree = documents/MRI say otherwise; cant_verify = not determinable from what you were given
  "correct_value": str|null,                     // REQUIRED when verdict="disagree": the value the documents support (stringify)
  "citation": str,                               // document title + section/article where the governing language lives ("" if cant_verify)
  "quote": str                                   // VERBATIM supporting text ("" if none)
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
    if (!propertyId || !tenant) throw new Error('property_id and tenant are required')
    if (!canReadProperty(caller, propertyId)) throw new AuthError('No access to this property', 403)

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')
    const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? ''

    // ── 1. The abstract (human-corrected values applied) ──
    const { data: row, error: rErr } = await sb.from('lease_abstracts')
      .select('id, abstract, overrides, source_doc_ids, model')
      .eq('property_id', propertyId).eq('tenant_name', tenant).maybeSingle()
    if (rErr) throw new Error('load abstract failed: ' + rErr.message)
    if (!row || !row.abstract) throw new Error(`No abstract exists for "${tenant}" — generate it first`)
    const auditAbstract = applyOverrides(row.abstract, row.overrides)
    const sourceIds: string[] = Array.isArray(row.source_doc_ids) ? row.source_doc_ids : []
    const highStakes = extractHighStakes(auditAbstract)

    // ── 2. Source-doc briefs (100%-of-text extractions — enough for field-scoped
    // cross-checks, and fast: no PDF attachment, keeps us under the edge wall) ──
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

    // ── 3. MRI system-of-record cross-check (ground truth for the reconciler) ──
    const { data: leaseRows } = await sb.from('leases')
      .select('id, commencement_date, expiration_date, leased_sf, has_percentage_rent, percentage_rent_rate, tenants!inner(name, trade_name)')
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

    // ── 4. Run the two lenses CONCURRENTLY over the same context ──
    const fieldsBlock = highStakes.map(h => `- ${h.field} = ${h.value}`).join('\n')
    const baseContext = `SOURCE FILE INVENTORY (every document exists and was available):
${inventory || '(no source documents recorded)'}
${leaseOut ? `\nMRI system-of-record values (a SEPARATE system, NOT a lease document — use for the reconciler lens): ${JSON.stringify(leaseOut)}` : ''}
${mriOptions.length ? `\nMRI option data (RETAILRR-verified; system of record for option notice deadlines & exercise state): ${JSON.stringify(mriOptions)}` : ''}

SOURCE DOCUMENT BRIEFS (each extracted from 100% of the document's text — full evidence of contents):
${briefParts.join('\n\n') || '(no briefs available)'}`

    const runLens = async (lens: { name: string; framing: string }) => {
      const prompt = `You independently cross-check specific fields of a commercial lease abstract for M&J Wilkow against the source documents and MRI. ${lens.framing}

For EACH field below, decide independently whether the STORED value is correct. Do not assume it is right; also do not flag a correct value — verify "clean" values too. Ground every verdict in the briefs/MRI; quote verbatim.

FIELDS TO CHECK (field = stored value):
${fieldsBlock}

${baseContext}

Call submit_checks with an object matching this schema exactly, one entry per field above:
${CHECK_SCHEMA}`
      try {
        const out = await lensJson(anthropicKey, openaiKey, [{ type: 'text', text: prompt }], 4000)
        const checks = Array.isArray(out?.checks) ? out.checks : []
        return { lens: lens.name, checks }
      } catch (e) {
        return { lens: lens.name, checks: [], error: e instanceof Error ? e.message : String(e) }
      }
    }
    const lensResults = await Promise.all(LENSES.map(runLens))
    const lensErrors = lensResults.filter(r => r.error).map(r => `${r.lens}: ${r.error}`)
    if (lensResults.every(r => r.error)) throw new Error('all lenses failed :: ' + lensErrors.join(' | '))

    // ── 5. Reconcile: per field, tally the lens votes vs the stored value ──
    const byField = new Map<string, any[]>()
    for (const lr of lensResults) {
      for (const c of lr.checks) {
        const f = String(c?.field ?? '').trim()
        if (!f) continue
        if (!byField.has(f)) byField.set(f, [])
        byField.get(f)!.push({ lens: lr.lens, verdict: c?.verdict ?? 'cant_verify', correct_value: c?.correct_value ?? null, citation: c?.citation ?? '', quote: c?.quote ?? '' })
      }
    }
    const fields: Record<string, any> = {}
    const disagreements: any[] = []
    for (const h of highStakes) {
      const votes = byField.get(h.field) ?? []
      const agree = votes.filter(v => v.verdict === 'agree').length
      const disagree = votes.filter(v => v.verdict === 'disagree').length
      let confidence: string
      if (votes.length === 0) confidence = 'low'
      else if (disagree > 0) confidence = 'low'
      else if (agree === votes.length) confidence = 'high'
      else if (agree >= 1) confidence = 'medium'
      else confidence = 'low'                                    // all cant_verify
      fields[h.field] = { abstract_value: h.value, confidence, agreement: `${agree}/${votes.length}`, lenses: votes }
      if (disagree > 0) {
        // Prefer a disagreeing vote whose proposed correct_value actually differs
        // from the stored value (deterministic guard against a lens that says
        // "disagree" but echoes the same value).
        const d = votes.find(v => v.verdict === 'disagree' && v.correct_value != null && norm(v.correct_value) !== norm(h.value))
          ?? votes.find(v => v.verdict === 'disagree')
        if (d) disagreements.push({
          field: h.field, abstract_value: h.value, correct_value: d.correct_value,
          citation: d.citation, quote: d.quote, votes: `${disagree} disagree / ${votes.length} checked`,
        })
      }
    }

    const fieldConfidence = {
      generated_at: new Date().toISOString(),
      model: MODEL,
      lenses: LENSES.map(l => l.name),
      lens_errors: lensErrors,
      fields,
      disagreements,
      // Summary counts for portfolio rollups / status chips.
      summary: {
        high: Object.values(fields).filter((f: any) => f.confidence === 'high').length,
        medium: Object.values(fields).filter((f: any) => f.confidence === 'medium').length,
        low: Object.values(fields).filter((f: any) => f.confidence === 'low').length,
        disagreements: disagreements.length,
      },
    }

    // ── 6. Save (own column — never touches abstract/open_items or qa) ──
    const { error: upErr } = await sb.from('lease_abstracts')
      .update({ field_confidence: fieldConfidence, field_confidence_model: MODEL, field_confidence_at: fieldConfidence.generated_at, updated_at: new Date().toISOString() })
      .eq('property_id', propertyId).eq('tenant_name', tenant)
    if (upErr) throw new Error('save failed: ' + upErr.message)

    return new Response(JSON.stringify({ success: true, tenant, property_id: propertyId, summary: fieldConfidence.summary, disagreements, lens_errors: lensErrors }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
