// agreement-verify — adversarial QA pass over an agreement-abstract result
// (REA/OEA/declaration or PMA). Mirrors abstract-verify v7: the verifier's
// evidence window matches the synthesizer's (briefs for every source doc +
// raw text within budget + file inventory + existence discipline), and it is
// prompted to REFUTE the stored abstract. Runs on the strongest model.
//
// Usage: POST { kind: 'rea'|'pma', id: uuid, max_pdfs?: number }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canReadProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

const MODEL = Deno.env.get('QA_MODEL') ?? 'claude-opus-4-8'
const CHAR_BUDGET = 300_000
const BRIEF_BUDGET = 140_000

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
  const looksRight = (o: any) => o && typeof o === 'object' && !Array.isArray(o) && ('field_checks' in o || 'summary' in o || 'confidence' in o)
  let out = block.input ?? {}
  if (!looksRight(out)) {
    const kids = Object.values(out).filter(looksRight)
    if (kids.length === 1) out = kids[0]
  }
  if (!looksRight(out)) throw new Error('Model returned a malformed verdict envelope — retry')
  return out
}

// OpenAI verdict via the Responses API (JSON mode) — fallback when Anthropic is
// overloaded. Same content translation + envelope-unwrap as anthropicJson.
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
  let raw = typeof d.output_text === 'string' ? d.output_text : ''
  if (!raw) for (const item of (d.output ?? [])) for (const cc of (item.content ?? [])) if (cc.type === 'output_text') raw += cc.text ?? ''
  const looksRight = (o: any) => o && typeof o === 'object' && !Array.isArray(o) && ('field_checks' in o || 'summary' in o || 'confidence' in o)
  let out = JSON.parse(raw)
  if (!looksRight(out)) { const kids = Object.values(out).filter(looksRight); if (kids.length === 1) out = kids[0] }
  if (!looksRight(out)) throw new Error('OpenAI returned a malformed verdict envelope — retry')
  return out
}
// Fall back to OpenAI whenever the Anthropic API is UNUSABLE — transient
// overload/rate-limit, or a hard credit/billing block.
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
 "summary": str,
 "field_checks": [{"field": str, "abstract_value": str, "verdict": "confirmed"|"discrepancy"|"unsupported"|"needs_source", "source_quote": str, "citation": str, "severity": "high"|"medium"|"low", "note": str}],
 "tracker_reconciliation": [{"field": str, "abstract_value": str, "tracker_value": str, "governs": "abstract"|"tracker"|"unclear", "note": str}],
 "amendment_currency": {"current": bool, "note": str},
 "recommended_fixes": [str]
}`

function deriveStatus(qa: any): string {
  const checks = Array.isArray(qa?.field_checks) ? qa.field_checks : []
  const bad = (v: string) => v === 'discrepancy' || v === 'unsupported'
  if (checks.some((c: any) => bad(c?.verdict) && c?.severity === 'high') || qa?.amendment_currency?.current === false) return 'issues'
  if (checks.some((c: any) => bad(c?.verdict) || c?.verdict === 'needs_source')) return 'review'
  return 'verified'
}

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const caller = await requireUser(req, sb)

    const body = await req.json().catch(() => ({}))
    const kind: string = body.kind ?? ''
    const id: string = body.id ?? ''
    if (!['rea', 'pma', 'jv', 'svc'].includes(kind) || !id) throw new Error("kind ('rea'|'pma'|'jv'|'svc') and id are required")

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')
    const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? ''   // fallback provider when Anthropic is overloaded

    const table = kind === 'rea' ? 'rea_agreements' : kind === 'jv' ? 'deals' : kind === 'svc' ? 'service_agreements' : 'management_agreements'
    const { data: row, error } = await sb.from(table).select('*').eq('id', id).maybeSingle()
    if (error || !row) throw new Error(`${table} row not found`)
    if (row.property_id && !canReadProperty(caller, row.property_id)) throw new AuthError('No access', 403)
    // For 'svc' the tracker row's extracted fields ARE the abstract under review.
    const subjectAbstract = kind === 'svc'
      ? {
          vendor: row.vendor, service_category: row.service_category, description: row.description,
          agreement_date: row.agreement_date, start_date: row.start_date, end_date: row.end_date,
          term_summary: row.term_summary, auto_renews: row.auto_renews, cancel_notice_days: row.cancel_notice_days,
          annual_value: row.annual_value, pricing_summary: row.pricing_summary, status: row.status,
        }
      : row.abstract
    if (!subjectAbstract) throw new Error('No abstract on this agreement — run agreement-abstract first')

    // Source docs (same resolution as agreement-abstract)
    let docIds: string[] = []
    if (kind === 'rea') docIds = ((row.source_docs ?? []) as any[]).map((d: any) => d.id).filter(Boolean)
    else if (kind === 'jv') docIds = Array.isArray(row.abstract_source_doc_ids) ? row.abstract_source_doc_ids : []
    else if (kind === 'svc') docIds = row.document_id ? [row.document_id] : []
    else {
      const seen = new Set<string>()
      let cur: any = row
      while (cur) {
        if (cur.document_id) docIds.push(cur.document_id)
        if (!cur.amends_id || seen.has(cur.amends_id)) break
        seen.add(cur.amends_id)
        const { data: parent } = await sb.from(table).select('id, document_id, amends_id').eq('id', cur.amends_id).maybeSingle()
        cur = parent
      }
    }
    if (!docIds.length) throw new Error('agreement has no linked source documents')

    const { data: docRows } = await sb.from('documents')
      .select('id, doc_type, title, file_name, storage_path, file_size_bytes')
      .in('id', docIds)
    const docs = (docRows ?? []) as any[]

    // Raw text within budget
    const { data: chunks } = await sb.from('document_chunks')
      .select('document_id, chunk_index, content')
      .in('document_id', docIds)
      .order('chunk_index')
    const byDoc = new Map<string, string[]>()
    for (const c of (chunks ?? []) as any[]) {
      if (!byDoc.has(c.document_id)) byDoc.set(c.document_id, [])
      byDoc.get(c.document_id)!.push(c.content ?? '')
    }
    let used = 0
    const parts: string[] = []
    const fullTextIds = new Set<string>()
    for (const d of docs) {
      const text = (byDoc.get(d.id) ?? []).join('\n')
      if (!text) continue
      const room = CHAR_BUDGET - used
      if (room < 2000) break
      const slice = text.slice(0, room)
      parts.push(`===== DOCUMENT: "${d.title ?? d.file_name}" =====\n${slice}`)
      used += slice.length
      if (slice.length >= text.length) fullTextIds.add(d.id)
    }

    // Briefs for docs beyond the raw-text budget + inventory (existence discipline)
    const { data: briefRows } = await sb.from('doc_briefs')
      .select('document_id, doc_class, chain_role, brief, status')
      .in('document_id', docIds)
    const briefBy = new Map<string, any>()
    for (const b of (briefRows ?? []) as any[]) if (b.status === 'complete' && b.brief) briefBy.set(b.document_id, b)
    let briefChars = 0
    const briefParts: string[] = []
    const briefIncluded = new Set<string>()
    for (const d of docs) {
      if (fullTextIds.has(d.id)) continue
      const b = briefBy.get(d.id)
      if (!b) continue
      const json = JSON.stringify(b.brief)
      if (briefChars + json.length > BRIEF_BUDGET) continue
      briefParts.push(`===== BRIEF (100%-of-text extraction): "${d.title ?? d.file_name}" =====\n${json}`)
      briefChars += json.length
      briefIncluded.add(d.id)
    }
    const inventory = docs.map(d => {
      const how = fullTextIds.has(d.id) ? 'FULL RAW TEXT below'
        : briefIncluded.has(d.id) ? 'structured brief below'
        : 'IN FILE — title only in this request'
      return `- "${d.title ?? d.file_name}" [${d.doc_type}] — ${how}`
    }).join('\n')

    // Attach primary PDFs (up to 3)
    const mp = Number(body.max_pdfs)
    const MAX_ATTACH_DOCS = Number.isFinite(mp) ? Math.max(0, Math.min(mp, 5)) : 3
    let attachBytes = 0
    const attachable: any[] = []
    for (const d of docs) {
      if (attachable.length >= MAX_ATTACH_DOCS) break
      if (typeof d.storage_path !== 'string' || !d.storage_path.startsWith('p/')) continue
      const sz = Number(d.file_size_bytes)
      if (!(sz > 0) || sz > 8_000_000 || attachBytes + sz > 20_000_000) continue
      attachable.push(d); attachBytes += sz
    }
    let attachments: any[] = []
    if (attachable.length) {
      const { data: signedUrls } = await sb.storage.from('documents')
        .createSignedUrls(attachable.map((d: any) => d.storage_path), 3600)
      attachments = (signedUrls ?? []).filter((s: any) => s.signedUrl)
        .map((s: any) => ({ type: 'document', source: { type: 'url', url: s.signedUrl } }))
    }

    // JV cross-check payload: the platform's modeled waterfall tiers.
    let jvTiers: any[] = []
    if (kind === 'jv') {
      const { data: tiers } = await sb.from('waterfall_tiers')
        .select('tier_order, tier_type, description, hurdle_irr, hurdle_em, lp_split_pct, gp_split_pct, pref_rate, is_cumulative, is_pik')
        .eq('deal_id', id).order('tier_order')
      jvTiers = tiers ?? []
    }
    const kindLabel = kind === 'rea' ? 'reciprocal easement/operating agreement (REA/OEA/declaration)'
      : kind === 'jv' ? 'joint-venture / LLC operating agreement'
      : kind === 'svc' ? 'vendor service contract (verifying the tracker\'s extracted fields)'
      : 'property management agreement (PMA)'
    const prompt = `You are an independent QA reviewer auditing a ${kindLabel} abstract for M&J Wilkow. ADVERSARIALLY VERIFY the abstract below against the source documents — assume it contains errors and try to prove each material value wrong.

SOURCE FILE INVENTORY (a document listed here EXISTS and was available to the abstractor):
${inventory}

EXISTENCE DISCIPLINE: NEVER claim an instrument "is not among the provided documents" or set amendment_currency.current=false on the ground that a document is absent when it IS in the inventory. Briefs are 100%-of-text extractions — full evidence of existence and contents. Only a value confirmable by NEITHER raw text NOR a brief NOR an attached PDF may be needs_source.

Method:
- Check every material field: ${kind === 'rea'
  ? 'parties/parcels and roles, amendment chain and currency, operating covenants (obligor + duration), use restrictions (verbatim + who benefits), exclusives (holder must be explicit — never attribute one party\'s protection to another), cost-sharing formulas, approval rights, term/expiration, critical dates.'
  : kind === 'jv'
  ? 'every waterfall tier (payment order, split percentages, hurdles — quote the split language verbatim), preferred return rate/compounding/base, promote structure, capital-call mechanics and failure remedies, major-decision list, removal rights, transfer/ROFR/buy-sell provisions, amendment currency. The abstract must reflect THIS layer\'s entity only — flag any term that actually belongs to the other layer\'s agreement.'
  : kind === 'svc'
  ? 'vendor legal name, agreement/start/end dates, term and AUTO-RENEWAL language (evergreen clauses are the money finding — a contract marked expired that auto-renews is silently live), cancellation notice days, annual value / pricing, and whether the status field (active/expired) is consistent with the documented term + renewal mechanics as of today. Set amendment_currency.current=true unless a document amendment contradicts the row.'
  : 'fee percentages and bases (management/construction/leasing), reimbursables and exclusions, termination rights and notice periods, term dates, amendment currency, AND — verify carefully — the approvals block: the manager\'s spending authority (routine/emergency/single/aggregate limits and contract caps) and every owner_approval_required matter with its dollar/percentage threshold and scope (each must trace to a verbatim quote and section; flag any approval threshold or spending limit that is unsupported, mis-stated, or superseded by a later amendment), the major_decisions list, and budget/variance authority and reporting deadlines.'}
- THE LATEST AMENDMENT CONTROLS — judge currency against the amendment chain in the sources.
- source_quote MUST be verbatim; if you cannot find supporting text, verdict is unsupported or needs_source.
- Disagreements with the structured tracker values below go in tracker_reconciliation (governs: 'abstract' when the documents clearly control), NOT field_checks.
- Do not pad with trivially-confirmed fields; prioritize money, dates, obligations, and the amendment chain.

Call submit_qa with an object matching this schema exactly:
${QA_SCHEMA}

TRACKER VALUES (structured cross-check): ${JSON.stringify(kind === 'rea'
  ? { name: row.name, agreement_date: row.agreement_date, operator: row.operator, members: row.members }
  : kind === 'jv'
  ? { deal_name: row.name, layer: row.layer, modeled_waterfall_tiers: jvTiers }
  : { manager_name: row.manager_name, mgmt_fee_pct: row.mgmt_fee_pct, construction_fee_pct: row.construction_fee_pct, leasing_fee_pct: row.leasing_fee_pct, term_start: row.term_start, term_end: row.term_end, termination_notice_days: row.termination_notice_days, budget_variance_pct: row.budget_variance_pct, monthly_report_due_day: row.monthly_report_due_day })}

THE ABSTRACT UNDER REVIEW:
${JSON.stringify(subjectAbstract)}

SOURCE DOCUMENTS (raw text):
${parts.join('\n\n')}
${briefParts.length ? `\nSOURCE DOCUMENTS (structured briefs):\n${briefParts.join('\n\n')}` : ''}`

    // Service contracts are short mechanical field checks — the faster model
    // suffices (74-row cohorts on Opus would spend review-grade money on
    // vendor-name lookups). Instrument abstracts stay on the strongest model.
    const callModel = kind === 'svc' ? (Deno.env.get('ABSTRACT_MODEL') ?? 'claude-sonnet-5') : MODEL
    const isCapError = (e: unknown) =>
      /page|too long|too large|exceed|prompt is too long/i.test(e instanceof Error ? e.message : String(e))
    let qa: any
    try {
      qa = await verifyJson(anthropicKey, openaiKey, callModel,[...attachments, { type: 'text', text: prompt }], 12000)
    } catch (e) {
      if (!attachments.length || !isCapError(e)) throw e
      qa = await verifyJson(anthropicKey, openaiKey, callModel,[{ type: 'text', text: prompt }], 12000)
      attachments = []
    }

    const qaStatus = deriveStatus(qa)
    const { error: upErr } = await sb.from(table).update({
      qa, qa_status: qaStatus, qa_model: callModel, qa_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', id)
    if (upErr) throw new Error('save failed: ' + upErr.message)

    return new Response(JSON.stringify({ success: true, kind, id, qa_status: qaStatus, qa }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
