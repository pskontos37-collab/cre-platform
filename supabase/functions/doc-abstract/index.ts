// doc-abstract — generates a narrative abstract for ONE document (a transaction
// closing document or a management/PMA agreement), stored in doc_abstracts.
//
// Pipeline:
//   1. Load the document row + authorize the caller for its property.
//   2. Return the cached abstract unless force=true.
//   3. Pull the document's full chunk text (capped) and attach the PDF when it
//      is mirrored and small enough for native reading.
//   4. One claude-sonnet-5 forced-tool-use call returns a narrative-abstract
//      JSON object (schema below), tuned by `kind`.
//   5. Upsert into doc_abstracts (document_id unique).
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.
// Usage: POST { document_id: uuid, kind?: 'transaction'|'management'|'document',
//               property_id?: uuid, context?: object, force?: boolean }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canReadProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

const MODEL = Deno.env.get('ABSTRACT_MODEL') ?? 'claude-sonnet-5'
const CHAR_BUDGET = 280_000

async function anthropicJson(key: string, model: string, content: any[], maxTokens: number): Promise<any> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      tools: [{
        name: 'submit_abstract',
        description: 'Submit the completed document abstract.',
        input_schema: { type: 'object', additionalProperties: true },
      }],
      tool_choice: { type: 'tool', name: 'submit_abstract' },
      messages: [{ role: 'user', content }],
    }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Anthropic API error: ' + JSON.stringify(d))
  if (d.stop_reason === 'max_tokens') throw new Error('Abstract truncated at max_tokens — retry')
  const block = (d.content ?? []).find((c: { type: string }) => c.type === 'tool_use')
  if (!block) throw new Error('Model returned no tool_use block')
  return block.input
}

// Kind-agnostic narrative abstract. Every concrete value must trace to the doc.
const SCHEMA = `{
 "doc_title": str, "doc_type": str,
 "parties": [{"role": str, "name": str}],
 "effective_date": "YYYY-MM-DD"|str|null,
 "summary": str,                                       // 3-6 sentence plain-English narrative of what this document is and does
 "key_terms": [{"label": str, "detail": str, "section": str|null}],
 "dates": [{"label": str, "date": str, "note": str|null}],
 "financial_terms": [{"label": str, "amount": num|null, "text": str|null, "note": str|null}],
 "obligations": [{"party": str, "obligation": str, "section": str|null}],
 "notes": str|null,
 "open_items": [str]                                   // each prefixed "MISSING FROM FILE:" / "NOT FULLY REVIEWED:" / "CONFIRM:" / "DISCREPANCY:"
}`

const KIND_GUIDANCE: Record<string, string> = {
  transaction: 'This is a real-estate TRANSACTION closing document (e.g. purchase & sale agreement, settlement/closing statement, deed, loan agreement, promissory note, mortgage, payoff letter, title policy, escrow instructions, equity agreement). Capture: the parties and their roles (buyer/seller/lender/borrower/title co.), the economic terms (contract/gross price, loan amount, rate, maturity, prepayment, reserves, credits, prorations, net proceeds/cash to close), key dates (effective, closing, maturity), and any conditions, representations, or survival provisions that matter after closing.',
  management: 'This is a property MANAGEMENT AGREEMENT (PMA) or an amendment to one. Capture: manager / sub-manager / owner, the fee schedule (management %, construction/leasing fees and their basis), the manager\'s spending & decision authority and thresholds, owner/JV approval items, reporting & submittal obligations with frequencies/due dates, the budget process and permitted variance, leasing authority, funds handling, insurance requirements, standard of care / indemnity, and the term / renewal / termination provisions (notice days).',
  document: 'Summarize this commercial real-estate document faithfully: what it is, the parties, the operative terms, key dates, financial terms, and ongoing obligations.',
}

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const caller = await requireUser(req, sb)

    const body = await req.json().catch(() => ({}))
    const documentId: string = body.document_id ?? ''
    const kind: string = ['transaction', 'management', 'document'].includes(body.kind) ? body.kind : 'document'
    const context = body.context ?? null
    const force = !!body.force
    if (!documentId) throw new Error('document_id is required')

    // ── 1. Document row + authorize ──
    const { data: doc, error: dErr } = await sb.from('documents')
      .select('id, property_id, doc_type, title, file_name, file_path, storage_path, file_size_bytes, is_indexed')
      .eq('id', documentId)
      .single()
    if (dErr || !doc) throw new Error('document not found')
    if (!canReadProperty(caller, doc.property_id ?? null)) throw new AuthError('No access to this document', 403)

    // ── 2. Cache ──
    if (!force) {
      const { data: existing } = await sb.from('doc_abstracts')
        .select('abstract, generated_at')
        .eq('document_id', documentId)
        .maybeSingle()
      if (existing?.abstract) {
        return new Response(JSON.stringify({ success: true, cached: true, document_id: documentId, abstract: existing.abstract }),
          { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    }

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')

    // ── 3. Text + optional PDF ──
    const { data: chunks } = await sb.from('document_chunks')
      .select('chunk_index, content')
      .eq('document_id', documentId)
      .order('chunk_index')
    const text = ((chunks ?? []) as any[]).map(c => c.content ?? '').join('\n').slice(0, CHAR_BUDGET)

    let attachments: any[] = []
    const sp: string | null = doc.storage_path ?? null
    const sz = Number(doc.file_size_bytes)
    if (sp && sp.startsWith('p/') && sz > 0 && sz <= 8_000_000) {
      const { data: signed } = await sb.storage.from('documents').createSignedUrls([sp], 3600)
      const url = signed?.[0]?.signedUrl
      if (url) attachments = [{ type: 'document', source: { type: 'url', url } }]
    }

    if (!text && attachments.length === 0) {
      throw new Error('No indexed text or readable PDF for this document — cannot abstract')
    }

    // ── 4. Generate ──
    const ctxNote = context ? `\nLINKING CONTEXT (from the app; use to orient, do not treat as the document's own text):\n${JSON.stringify(context)}` : ''
    const attachNote = attachments.length
      ? `\nThe attached PDF is the PRIMARY SOURCE — ground exact terms and section cites in it; the text excerpt below supplements.`
      : ''
    const prompt = `You are a commercial real-estate document abstractor for M&J Wilkow. Produce a faithful abstract of the single document below.
${KIND_GUIDANCE[kind]}${ctxNote}${attachNote}

GROUNDING — NO FABRICATION (critical): every concrete value (date, dollar amount, rate, party/legal name, section cite) MUST be traceable to the attached PDF or the text below. Never invent or estimate. If a value is referenced but not stated, leave it null and add a prefixed "open_items" line. The "summary" is a plain-English narrative (3-6 sentences) of what the document is and does — no fabricated specifics.

Rules:
- Call the submit_abstract tool with an object matching this schema exactly (all keys present):
${SCHEMA}
- "section" fields cite the article/section where the term appears (e.g. "Art. 5", "Section 3.2"), or null.
- Anything the document does not address: use null / empty array, and note material gaps in "open_items" with the right prefix.
- Document metadata: title "${doc.title ?? doc.file_name ?? 'Untitled'}", type "${doc.doc_type ?? 'unknown'}".

DOCUMENT TEXT:
${text || '[no extracted text layer — read the attached PDF]'}`

    let abstract: any
    try {
      abstract = await anthropicJson(anthropicKey, MODEL, [...attachments, { type: 'text', text: prompt }], 8000)
    } catch (e) {
      const capErr = /page|too long|too large|exceed|prompt is too long/i.test(e instanceof Error ? e.message : String(e))
      if (attachments.length && capErr) {
        abstract = await anthropicJson(anthropicKey, MODEL, [{ type: 'text', text: prompt }], 8000)
        attachments = []
      } else {
        throw e
      }
    }

    // ── 5. Upsert ──
    const { error: upErr } = await sb.from('doc_abstracts').upsert({
      document_id: documentId,
      property_id: doc.property_id ?? null,
      kind,
      title: doc.title ?? doc.file_name ?? null,
      abstract,
      source_context: context,
      status: 'complete',
      model: MODEL,
      error: null,
      generated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'document_id' })
    if (upErr) throw new Error('save failed: ' + upErr.message)

    return new Response(JSON.stringify({ success: true, document_id: documentId, pdf_source: attachments.length, abstract }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
