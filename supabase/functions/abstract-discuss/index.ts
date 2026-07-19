// abstract-discuss — scoped, conversational re-verification of ONE abstract field.
//
// The reviewer looks at a flagged field, types an explanation in plain English
// ("the expiration is 2036 per the Third Amendment §2, not 2031"), and this
// function re-reads the SAME source documents the abstract was built from and
// answers — grounded in the documents, NOT in the reviewer's assertion.
//
// Design intent (the guardrail): the model must EARN the correction against the
// source text. It is explicitly told the reviewer's note is a hypothesis to
// check, not an instruction to obey: if the documents support the reviewer it
// returns verdict='corrects' with the value + verbatim quote; if the documents
// contradict the reviewer it returns verdict='agrees' (or corrects to the DOC
// value) and shows the contradicting quote. This keeps the human as the
// authority while preventing a sycophantic "you're right" with no basis.
//
// Nothing here trains the model or persists on the server — the caller decides
// whether to apply the returned value as an override (AbstractsPage).
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.
// Optional: OPENAI_API_KEY (fallback when Anthropic is overloaded).
// Usage: POST JSON { property_id, tenant, field, current_value, note }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canWriteProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

// A reasoning task over legal text — use the strongest model. Shares QA_MODEL
// with abstract-verify so the discussion and the verifier agree on capability.
const MODEL = Deno.env.get('QA_MODEL') ?? 'claude-opus-4-8'
const CHAR_BUDGET = 320_000

// Layer the reviewer's overrides (dotted-path -> value) over the AI abstract so
// the discussion sees the human-corrected values. Mirrors applyOverrides in
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

// Read a dotted path (best-effort; supports options.0.notice_by style indices).
function getPath(obj: any, path: string): any {
  if (!obj || !path) return undefined
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

async function anthropicJson(key: string, model: string, content: any[], maxTokens: number): Promise<any> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      tools: [{
        name: 'submit_finding',
        description: 'Submit the grounded finding for the discussed field.',
        input_schema: { type: 'object', additionalProperties: true },
      }],
      tool_choice: { type: 'tool', name: 'submit_finding' },
      messages: [{ role: 'user', content }],
    }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Anthropic API error: ' + JSON.stringify(d))
  if (d.stop_reason === 'max_tokens') throw new Error('Finding truncated at max_tokens — retry')
  const block = (d.content ?? []).find((c: { type: string }) => c.type === 'tool_use')
  if (!block) throw new Error('Model returned no tool_use block')
  return block.input
}

// OpenAI Responses-API fallback (JSON mode) when Anthropic is overloaded.
const DISCUSS_OPENAI_MODEL = Deno.env.get('QA_OPENAI_MODEL') ?? 'gpt-4.1'
async function openaiJson(key: string, content: any[], maxTokens: number): Promise<any> {
  const oai: any[] = []
  for (const c of content) if (c.type === 'text') oai.push({ type: 'input_text', text: c.text })
  oai.push({ type: 'input_text', text: 'Return ONLY a single valid JSON object for the submit_finding schema described above — no markdown, no commentary.' })
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: DISCUSS_OPENAI_MODEL, max_output_tokens: maxTokens,
      text: { format: { type: 'json_object' } },
      input: [{ role: 'user', content: oai }],
    }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('OpenAI API error: ' + JSON.stringify(d))
  if (d.status === 'incomplete') throw new Error('Finding truncated at max_output_tokens — retry')
  let out = typeof d.output_text === 'string' ? d.output_text : ''
  if (!out) for (const item of (d.output ?? [])) for (const cc of (item.content ?? [])) if (cc.type === 'output_text') out += cc.text ?? ''
  return JSON.parse(out)
}

function isOverloaded(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e)
  return /overloaded_error|"Overloaded"|\b529\b|rate_limit|too many requests|credit balance|Plans & Billing|insufficient|billing/i.test(m)
}
async function findingJson(aKey: string, oKey: string, model: string, content: any[], maxTokens: number): Promise<any> {
  try { return await anthropicJson(aKey, model, content, maxTokens) }
  catch (e) {
    if (oKey && isOverloaded(e)) return await openaiJson(oKey, content, maxTokens)
    throw e
  }
}

const FINDING_SCHEMA = `{
 "verdict": "agrees" | "corrects" | "insufficient",
    // "agrees"       = the stored value is what the documents support (the reviewer's point does not change it)
    // "corrects"     = the documents support a DIFFERENT value (whether or not it matches the reviewer's proposal) -> put it in corrected_value
    // "insufficient" = the attached documents do not settle the question
 "corrected_value": str | null,   // the value the field SHOULD hold, VERBATIM/normalized from the documents. null unless verdict="corrects"
 "agrees_with_reviewer": bool,     // does the DOCUMENTARY finding match what the reviewer asserted in their note?
 "citation": str,                  // document title + article/section where the controlling language lives ("" if none)
 "source_quote": str,              // VERBATIM sentence(s) from the documents that control this field ("" if none exists)
 "explanation": str,               // 1-3 sentences, plain English: what the documents actually say about the reviewer's point, and why the verdict follows
 "confidence": "high" | "medium" | "low"
}`

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const caller = await requireUser(req, sb)

    const body = await req.json().catch(() => ({}))
    const propertyId: string = body.property_id ?? ''
    const tenant: string = (body.tenant ?? '').trim()
    const field: string = (body.field ?? '').trim()
    const reviewerNote: string = (body.note ?? '').trim()
    const currentValueIn: string = body.current_value == null ? '' : String(body.current_value)
    if (!propertyId || !tenant || !field) throw new Error('property_id, tenant and field are required')
    if (!reviewerNote) throw new Error('a note explaining the discrepancy is required')
    if (!canWriteProperty(caller, propertyId)) throw new AuthError('No write access to this property', 403)   // spend gate (review #13): AI 'Discuss' spends model credits — operate access, not view

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')
    const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? ''

    // ── 1. The abstract + its recorded source documents ──
    const { data: row, error: rErr } = await sb.from('lease_abstracts')
      .select('id, abstract, overrides, source_doc_ids')
      .eq('property_id', propertyId)
      .eq('tenant_name', tenant)
      .maybeSingle()
    if (rErr) throw new Error('load abstract failed: ' + rErr.message)
    if (!row || !row.abstract) throw new Error(`No abstract exists for "${tenant}" — generate it first`)
    const effective = applyOverrides(row.abstract, row.overrides)
    // Trust the field's current stored value over what the caller passed, but
    // keep the caller's string if the path can't be resolved (array items etc.).
    const resolved = getPath(effective, field)
    const currentValue = resolved === undefined ? currentValueIn : (resolved == null ? '' : (typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved)))
    const sourceIds: string[] = Array.isArray(row.source_doc_ids) ? row.source_doc_ids : []
    if (!sourceIds.length) throw new Error('Abstract has no recorded source documents — regenerate it before discussing')

    // ── 2. The SAME source documents, in the abstractor's ordering ──
    const { data: sdocs, error: dErr } = await sb.from('documents')
      .select('id, doc_type, title, file_name, file_path')
      .in('id', sourceIds)
    if (dErr) throw new Error('document load failed: ' + dErr.message)
    const orderIdx = new Map(sourceIds.map((id, i) => [id, i]))
    const docs = ((sdocs ?? []) as any[]).sort((a, b) => (orderIdx.get(a.id) ?? 999) - (orderIdx.get(b.id) ?? 999))
    if (!docs.length) throw new Error('Source documents no longer available')

    // ── 3. Full verbatim chunk text, capped to the budget ──
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
    for (const d of docs) {
      const text = (byDoc.get(d.id) ?? []).join('\n')
      if (!text) continue
      const room = CHAR_BUDGET - used
      if (room < 2000) break
      const slice = text.slice(0, room)
      parts.push(`===== DOCUMENT: "${d.title ?? d.file_name}" (type: ${d.doc_type}) =====\n${slice}`)
      used += slice.length
    }
    if (!parts.length) throw new Error('No indexed text available for the source documents')

    // ── 4. Ask the model to adjudicate the reviewer's point against the docs ──
    const prompt = `You are a commercial-real-estate lease analyst re-checking ONE field of a lease abstract at the request of a human reviewer.

TENANT: ${tenant}
FIELD (dotted path): ${field}
VALUE CURRENTLY STORED IN THE ABSTRACT: ${currentValue || '(empty)'}

THE REVIEWER'S EXPLANATION / PROPOSED CORRECTION:
"""
${reviewerNote}
"""

CRITICAL INSTRUCTIONS — read carefully:
- The reviewer's note is a HYPOTHESIS TO CHECK, not an instruction to obey. Do NOT simply agree with it.
- Determine what the DOCUMENTS below actually say about this field. Quote the controlling language VERBATIM.
- If the documents support the reviewer's point, verdict="corrects" and put the correct value in corrected_value.
- If the documents CONTRADICT the reviewer, say so plainly: set agrees_with_reviewer=false and either verdict="agrees" (the stored value is right) or verdict="corrects" to the value the documents DO support. Show the contradicting quote.
- Where an amendment chain exists, the LATEST amendment governs. Prefer the operative (executed) instrument over drafts.
- If the attached documents do not resolve the question, verdict="insufficient" — do not guess.

Return your finding via the submit_finding tool using EXACTLY this schema:
${FINDING_SCHEMA}

DOCUMENTS (verbatim source text follows):
${parts.join('\n\n')}`

    const finding = await findingJson(anthropicKey, openaiKey, MODEL, [{ type: 'text', text: prompt }], 2000)

    return new Response(JSON.stringify({ success: true, field, current_value: currentValue, finding }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 400
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
    })
  }
})
