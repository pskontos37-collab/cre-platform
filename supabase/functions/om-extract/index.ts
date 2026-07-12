// om-extract — reads a broker Offering Memorandum and returns a structured
// first-look for the deal pipeline: property facts + a key-points brief + an
// "open questions / needs verification" list. Same shape as lease-abstract:
// one forced-tool Claude call so quoted figures can never break JSON parsing.
//
// Three input modes (checked in this order):
//   { storagePath }  → a PDF uploaded to the `documents` bucket; Claude reads it
//                      natively (handles digital + scanned within page limits).
//   { documentId }   → an existing corpus document; pulls its chunk text.
//   { text }         → extract directly from pasted OM text.
//
// The result is REVIEWED by a human before a deal is created — nothing here
// writes a deal row. It only extracts.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, corsHeaders, requireUser } from '../_shared/auth.ts'

const MODEL = Deno.env.get('OM_EXTRACT_MODEL') ?? 'claude-sonnet-5'
const CHAR_BUDGET = 300_000

// `content` may be a plain string or a message-content array (document + text).
async function anthropicJson(key: string, model: string, content: any, maxTokens: number): Promise<any> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      tools: [{
        name: 'submit_om',
        description: 'Submit the structured extraction of the offering memorandum.',
        input_schema: { type: 'object', additionalProperties: true },
      }],
      tool_choice: { type: 'tool', name: 'submit_om' },
      messages: [{ role: 'user', content }],
    }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Anthropic API error: ' + JSON.stringify(d))
  const block = (d.content ?? []).find((c: { type: string }) => c.type === 'tool_use')
  if (!block) throw new Error('Model returned no tool_use block')
  return block.input
}

const SCHEMA = `{
 "name": str,
 "city": str|null, "state": str|null,
 "submarket": "CBD"|"Suburban"|"Urban"|null,
 "asset_type": "retail"|"office"|"mixed"|"industrial"|null,
 "risk_profile": "core"|"core_plus"|"value_add"|"opportunistic"|null,
 "sub_type": str|null,
 "gla_sf": num|null,
 "year_built": num|null,
 "occupancy": num|null,
 "asking_price": num|null,
 "asking_guidance_text": str|null,
 "in_place_cap": num|null,
 "noi": num|null,
 "major_tenants": [{"name": str, "sf": num|null, "expiration": str|null}],
 "key_points": [str],
 "open_questions": [str]
}`

const INSTRUCTIONS = `You are an acquisitions analyst at M&J Wilkow, a GP that buys retail & office assets and raises institutional LP capital. Extract a first-look for the deal pipeline from the Offering Memorandum.

Guidance:
- GROUNDING — extract only what the OM states. If a value is not present, use null; do NOT invent numbers. When pricing is a range, a PSF figure, or "call for offers", put it in asking_guidance_text and leave asking_price null.
- asset_type / risk_profile: classify from the facts. Value-add = meaningful vacancy, rollover, or a repositioning story; Core = stabilized, long WALT, credit tenancy; Core-Plus in between; Opportunistic = distress / heavy lease-up / development.
- key_points: 4-6 crisp, decision-useful highlights (anchor & credit tenancy, WALT/rollover, basis vs. replacement, submarket, debt assumability).
- open_questions: what a disciplined buyer must verify before bidding — pro-forma vs. in-place NOI add-backs, holdover/renewal risk, tax reassessment on sale, capex, and any figure the OM presents optimistically. Include "Update taxes" if a reassessment is likely.
- Call the submit_om tool with an object matching this schema exactly (all keys present):
${SCHEMA}`

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const caller = await requireUser(req, sb)
    if (!caller.isPrivileged) throw new AuthError('Deal data is restricted', 403)

    const body = await req.json().catch(() => ({}))
    const storagePath: string | undefined = body.storagePath
    const documentId: string | undefined = body.documentId
    let text: string = (body.text ?? '').toString()
    let sourceTitle = body.deal_name ?? 'the offering memorandum'

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')

    let extraction: any

    if (storagePath) {
      // ── PDF mode: Claude reads the uploaded OM natively via a signed URL ──
      sourceTitle = body.deal_name || storagePath.split('/').pop() || sourceTitle
      const { data: signed, error: sErr } = await sb.storage.from('documents').createSignedUrl(storagePath, 3600)
      if (sErr || !signed?.signedUrl) throw new Error('Could not read the uploaded OM from storage')
      const content = [
        { type: 'document', source: { type: 'url', url: signed.signedUrl } },
        { type: 'text', text: `${INSTRUCTIONS}\n\nThe attached PDF is the offering memorandum ("${sourceTitle}"). Extract from it.` },
      ]
      try {
        extraction = await anthropicJson(anthropicKey, MODEL, content, 4000)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/page|too large|too long|exceed|prompt is too long/i.test(msg)) {
          throw new Error('This OM is too large or scanned for native reading. Paste the key pages instead, or run OCR first.')
        }
        throw e
      }
    } else {
      // ── text / corpus-document mode ──
      if (!text && documentId) {
        const { data: doc } = await sb.from('documents').select('title, file_name').eq('id', documentId).single()
        sourceTitle = doc?.title ?? doc?.file_name ?? sourceTitle
        const { data: chunks } = await sb.from('document_chunks')
          .select('content, chunk_index').eq('document_id', documentId).order('chunk_index')
        text = ((chunks ?? []) as any[]).map(c => c.content ?? '').join('\n')
      }
      text = text.slice(0, CHAR_BUDGET)
      if (text.trim().length < 40) throw new Error('No OM text to read — pass storagePath, text, or a documentId with indexed content')
      extraction = await anthropicJson(anthropicKey, MODEL, `${INSTRUCTIONS}\n\nOFFERING MEMORANDUM — "${sourceTitle}":\n${text}`, 4000)
    }

    return new Response(JSON.stringify({ success: true, source: sourceTitle, extraction }), {
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
