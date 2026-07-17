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
// Auto-apply lever (opt-in via body.auto_apply): the ONLY fields a unanimous,
// self-consistent, cited cross-check may correct automatically. Deliberately
// scalar + unambiguous — NEVER arrays (options/base_rent_schedule = whole-array
// replacement risk) or verbatim exclusive language (paraphrase risk) or the
// nuanced/contested exclusives flag. Widen via env without a redeploy.
const AUTO_APPLY_FIELDS = new Set(
  (Deno.env.get('AUTO_APPLY_FIELDS') ?? 'term.expiration,guarantor.name').split(',').map(s => s.trim()).filter(Boolean))

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
      .select('id, abstract, overrides, source_doc_ids, model, locked, human_verified')
      .eq('property_id', propertyId).eq('tenant_name', tenant).maybeSingle()
    if (rErr) throw new Error('load abstract failed: ' + rErr.message)
    if (!row || !row.abstract) throw new Error(`No abstract exists for "${tenant}" — generate it first`)
    const auditAbstract = applyOverrides(row.abstract, row.overrides)
    const sourceIds: string[] = Array.isArray(row.source_doc_ids) ? row.source_doc_ids : []
    const highStakes = extractHighStakes(auditAbstract)

    // ── 1a. STICKY HUMAN DECISIONS. A field a human has already ruled on must not
    // be re-raised as a fresh red flag by a re-run (the "I told you this days ago"
    // problem). A field is SETTLED if: the abstract is locked/human_verified; OR a
    // human override exists for it; OR a non-archived resolution (accepted/waived/
    // corrected) exists for it. When a settled field's lenses now disagree, we
    // record it as a quiet "reconfirm" — new evidence to re-examine — NEVER a red
    // disagreement. Genuinely new fields (no prior decision) still flag normally. ──
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

    // ── 3a. EXCLUSIVES-OWNERSHIP REGISTRY (migration 20240112). Deterministic
    // ground truth for who holds which exclusive at this property (incl. vacated
    // tenants). Used to REJECT the recurring misattribution class: a lens
    // asserting THIS tenant holds an exclusive that actually belongs to another
    // tenant (e.g. Buy Buy Baby's exclusive filed under J. Crew). ──
    const { data: registryRows } = await sb.from('property_exclusives')
      .select('owner_tenant, keywords').eq('property_id', propertyId)
    const foreignOwners: string[] = []
    const foreignKeywords: string[] = []
    for (const e of (registryRows ?? []) as any[]) {
      if (nm(e.owner_tenant) === tl) continue                     // this tenant's own registry entry
      const owner = nm(e.owner_tenant)
      if (owner.length >= 4) foreignOwners.push(owner)
      for (const kw of (Array.isArray(e.keywords) ? e.keywords : [])) {
        const k = String(kw).toLowerCase().trim()
        // Only MULTI-WORD phrases — single common words ("children", "infant")
        // substring-match legitimate different exclusives (Old Navy's apparel
        // "for women, men, and children") and cause false rejections.
        if (k.includes(' ') && k.length >= 6 && k !== tl) foreignKeywords.push(k)
      }
    }
    // Returns a reason string if the disagreement asserts an exclusive for THIS
    // tenant that the registry / structure says belongs to someone else.
    const guardExclusive = (field: string, stored: string, d: any): string | null => {
      if (!field.startsWith('exclusives')) return null
      const assertsExclusive =
        (field === 'exclusives.exists' && norm(d.correct_value) === 'true' && norm(stored) !== 'true') ||
        (field === 'exclusives.exact_language' && d.correct_value != null && String(d.correct_value).trim() !== '' &&
          (stored == null || norm(stored) === 'null' || norm(stored) === ''))
      if (!assertsExclusive) return null
      const hay = `${d.correct_value ?? ''} ${d.quote ?? ''} ${d.citation ?? ''}`.toLowerCase()
      if (/existing\s+exclusiv/.test(hay)) return 'cites an "Existing Exclusives" exhibit — another tenant\'s protection, not this tenant\'s'
      for (const o of foreignOwners) if (hay.includes(o)) return `attributes an exclusive registered to another tenant ("${o}")`
      for (const k of foreignKeywords) if (hay.includes(k)) return `matches a registry exclusive owned by another tenant ("${k}")`
      return null
    }

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
    const reconfirm: any[] = []                                  // settled fields the lenses now dispute (quiet, not red)
    const registryRejected: any[] = []                           // misattributed exclusives killed by the registry guard
    for (const h of highStakes) {
      const votes = byField.get(h.field) ?? []
      const agree = votes.filter(v => v.verdict === 'agree').length
      const disagree = votes.filter(v => v.verdict === 'disagree').length
      const settled = isSettled(h.field)
      let confidence: string
      if (settled) confidence = 'settled'                        // a human ruled on it — not a red field
      else if (votes.length === 0) confidence = 'low'
      else if (disagree > 0) confidence = 'low'
      else if (agree === votes.length) confidence = 'high'
      else if (agree >= 1) confidence = 'medium'
      else confidence = 'low'                                    // all cant_verify
      fields[h.field] = { abstract_value: h.value, confidence, agreement: `${agree}/${votes.length}`, lenses: votes, settled }
      if (disagree > 0) {
        // Prefer a disagreeing vote whose proposed correct_value actually differs
        // from the stored value (deterministic guard against a lens that says
        // "disagree" but echoes the same value).
        const d = votes.find(v => v.verdict === 'disagree' && v.correct_value != null && norm(v.correct_value) !== norm(h.value))
          ?? votes.find(v => v.verdict === 'disagree')
        if (!d) continue
        const item = {
          field: h.field, abstract_value: h.value, correct_value: d.correct_value,
          citation: d.citation, quote: d.quote, votes: `${disagree} disagree / ${votes.length} checked`,
        }
        // #3 REGISTRY GUARD: a lens asserting THIS tenant holds an exclusive that
        // the registry/structure says belongs to another tenant is a
        // misattribution (the J. Crew/Buy Buy Baby class) — reject it outright,
        // never a red flag. Deterministic, so it can't be re-rolled wrong.
        const rej = guardExclusive(h.field, h.value, d)
        if (rej) {
          fields[h.field].confidence = 'high'
          fields[h.field].guarded = rej
          registryRejected.push({ ...item, reason: rej })
          continue
        }
        // A field the human already ruled on is NEVER re-raised as a red
        // disagreement — it becomes a quiet reconfirm (new evidence to re-examine).
        if (settled) reconfirm.push(item)
        else disagreements.push(item)
      }
    }

    // ── 5a. AUTO-APPLY LEVER (opt-in). Write a correction ONLY when every guard
    // passes: opt-in flag set; abstract not locked; field is scalar-safe; the
    // disagreement is UNANIMOUS (every lens disagreed); the lenses agree with
    // EACH OTHER on the corrected value; it differs from stored; at least one
    // cites a source; and there is no existing HUMAN override for that field.
    // The correction is written to the overrides layer (base abstract untouched,
    // reversible) + logged as a resolution so it shows in the worklist with an
    // audit trail and is undoable. Anything short of unanimous stays
    // detection-only in the worklist for a human to adjudicate. ──
    const autoApplied: any[] = []
    if (body.auto_apply === true && !row.locked) {
      const existingOverrides = (row.overrides && typeof row.overrides === 'object') ? row.overrides as Record<string, any> : {}
      const newOverrides: Record<string, any> = {}
      for (const h of highStakes) {
        if (!AUTO_APPLY_FIELDS.has(h.field)) continue
        if (h.field in existingOverrides) continue                 // never overwrite a human correction
        if (isSettled(h.field)) continue                           // never auto-touch a human-settled field
        const votes = byField.get(h.field) ?? []
        if (votes.length < 2) continue                             // need every lens's vote
        const dis = votes.filter(v => v.verdict === 'disagree')
        if (dis.length !== votes.length) continue                  // UNANIMOUS disagree only
        const cvs = dis.map(v => v.correct_value).filter(v => v != null && String(v).trim() !== '')
        if (cvs.length !== votes.length) continue                  // every lens proposed a concrete fix
        const consensus = norm(cvs[0])
        if (!cvs.every(cv => norm(cv) === consensus)) continue     // lenses AGREE on the fix
        if (consensus === norm(h.value)) continue                  // and it differs from stored
        if (!dis.some(v => String(v.citation ?? '').trim() !== '')) continue   // cited
        // Light coercion: bare number/bool land as typed; everything else stays string.
        let val: any = cvs[0]
        if (val === 'true') val = true
        else if (val === 'false') val = false
        else { const nn = String(val).replace(/[$,\s]/g, ''); if (/^-?\d+(\.\d+)?$/.test(nn)) val = Number(nn) }
        newOverrides[h.field] = val
        autoApplied.push({ field: h.field, from: h.value, to: cvs[0], citation: dis.find(v => v.citation)?.citation ?? '' })
      }
      if (Object.keys(newOverrides).length) {
        const merged = { ...existingOverrides, ...newOverrides }
        const { error: ovErr } = await sb.from('lease_abstracts')
          .update({ overrides: merged, updated_at: new Date().toISOString() })
          .eq('property_id', propertyId).eq('tenant_name', tenant)
        if (ovErr) throw new Error('auto-apply override save failed: ' + ovErr.message)
        for (const a of autoApplied) {
          await sb.from('abstract_item_resolutions').upsert({
            abstract_id: row.id, item_key: `field:${a.field.toLowerCase()}`, kind: 'qa_check', status: 'corrected',
            note: `Auto-applied by cross-check (unanimous): ${String(a.from)} → ${String(a.to)}${a.citation ? ` · ${a.citation}` : ''}`,
            resolved_by: null, resolved_at: new Date().toISOString(), updated_at: new Date().toISOString(), archived: false,
          }, { onConflict: 'abstract_id,item_key' })
        }
      }
    }

    const fieldConfidence = {
      generated_at: new Date().toISOString(),
      model: MODEL,
      lenses: LENSES.map(l => l.name),
      lens_errors: lensErrors,
      fields,
      disagreements,
      reconfirm,
      registry_rejected: registryRejected,
      auto_applied: autoApplied,
      // Summary counts for portfolio rollups / status chips.
      summary: {
        high: Object.values(fields).filter((f: any) => f.confidence === 'high').length,
        medium: Object.values(fields).filter((f: any) => f.confidence === 'medium').length,
        low: Object.values(fields).filter((f: any) => f.confidence === 'low').length,
        settled: Object.values(fields).filter((f: any) => f.confidence === 'settled').length,
        disagreements: disagreements.length,
        reconfirm: reconfirm.length,
        registry_rejected: registryRejected.length,
        auto_applied: autoApplied.length,
      },
    }

    // ── 6. Save (own column — never touches abstract/open_items or qa) ──
    const { error: upErr } = await sb.from('lease_abstracts')
      .update({ field_confidence: fieldConfidence, field_confidence_model: MODEL, field_confidence_at: fieldConfidence.generated_at, updated_at: new Date().toISOString() })
      .eq('property_id', propertyId).eq('tenant_name', tenant)
    if (upErr) throw new Error('save failed: ' + upErr.message)

    return new Response(JSON.stringify({ success: true, tenant, property_id: propertyId, summary: fieldConfidence.summary, disagreements, reconfirm, registry_rejected: registryRejected, auto_applied: autoApplied, lens_errors: lensErrors }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
