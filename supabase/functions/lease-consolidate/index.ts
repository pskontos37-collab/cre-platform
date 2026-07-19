// lease-consolidate — given a property + tenant, gather ALL documents for that tenant's lease,
// order them chronologically, and have Claude apply AMENDMENT PRECEDENCE (later amendments /
// riders / side letters supersede the base lease for any term they change) to produce the
// CURRENT EFFECTIVE lease terms, with each term citing the controlling document.
//
//   POST ?propertyId=<uuid>&tenant=<name>[&model=...]
//
// Note: current ECONOMIC terms (rent/expiration) are most authoritatively in the rent roll;
// this consolidation is for the full clause set (options, co-tenancy, exclusives, use, etc.)
// across the base lease + its amendments.
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canWriteProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

const DEFAULT_MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-opus-4-8'

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    // Runs with the service role + spends AI budget; authorize the caller.
    const caller = await requireUser(req, sb)

    const url = new URL(req.url)
    const propertyId = url.searchParams.get('propertyId')
    const tenant     = url.searchParams.get('tenant')
    const model      = url.searchParams.get('model') ?? DEFAULT_MODEL
    if (!propertyId || !tenant) throw new Error('?propertyId= and ?tenant= are required')
    if (!canWriteProperty(caller, propertyId)) throw new AuthError('No write access to this property', 403)   // spend gate (review #13): consolidation spends model credits — operate access, not view

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY secret not set')

    // Gather candidate docs for this property whose tenant/title/path mention the tenant.
    const like = `%${tenant}%`
    const { data, error } = await sb.from('documents')
      .select('id, doc_type, title, file_path, notes')
      .eq('property_id', propertyId)
      .or(`title.ilike.${like},notes.ilike.${like},file_path.ilike.${like}`)
      .limit(120)
    if (error) throw new Error('documents query failed: ' + error.message)

    const docs = (data ?? []).map((d: Record<string, unknown>) => {
      let abs: Record<string, unknown> = {}
      try { abs = JSON.parse(String(d.notes ?? '{}')) } catch { /* notes not JSON */ }
      return {
        id: d.id, doc_type: d.doc_type, title: d.title, file: d.file_path,
        effective_date: (abs.effective_date as string) ?? null,
        sub_type: (abs.sub_type as string) ?? null,
        abstraction: abs,
      }
    })
    // Keep lease-family + related docs; drop obvious non-lease noise but keep correspondence
    // (letters can effect changes). Sort oldest-first; undated last.
    docs.sort((a, b) => String(a.effective_date ?? '9999-12-31').localeCompare(String(b.effective_date ?? '9999-12-31')))

    if (docs.length === 0) {
      return new Response(JSON.stringify({ tenant, property_id: propertyId, document_count: 0,
        consolidated: 'No documents found for this tenant under this property.' }, null, 2),
        { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    const docList = docs.map((d, i) =>
      `[#${i + 1}] type=${d.doc_type} sub=${d.sub_type ?? ''} effective=${d.effective_date ?? 'n/a'} file=${d.file}\n` +
      JSON.stringify(d.abstraction)).join('\n\n')

    const prompt =
`You are consolidating ALL documents for ONE tenant's lease at a retail property, listed OLDEST FIRST.
Apply AMENDMENT PRECEDENCE: a later amendment, rider, side letter, or assignment SUPERSEDES the base
lease and any earlier amendment for every term it changes; terms not changed carry forward unchanged.
Letters/notices may exercise options or effect changes — weigh them by date and content.

Produce the CURRENT EFFECTIVE lease terms. For EACH term, cite the controlling document as [#n] (file).
Cover, where determinable: tenant & guarantor; premises / suite; square footage; commencement date;
CURRENT expiration date; base rent & escalation schedule; renewal/extension options (and notice
windows); co-tenancy; exclusive use; permitted use; assignment/subletting; recapture/termination/kick-out.
If documents conflict or a term cannot be resolved from these abstractions, say so explicitly rather
than guessing. Note that the rent roll (not provided here) is the authority for today's actual rent.

Return: (1) a short "Current effective terms" section with citations, then (2) an "Amendment chain"
list (each document, its date, and what it changed).

Documents (oldest first):

${docList}`

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 3500, messages: [{ role: 'user', content: prompt }] }),
    })
    const j = await r.json()
    if (!r.ok) throw new Error('Claude error: ' + JSON.stringify(j).slice(0, 300))
    const text = (j.content ?? []).find((c: Record<string, unknown>) => c.type === 'text')?.text ?? ''

    return new Response(JSON.stringify({
      tenant, property_id: propertyId, model, document_count: docs.length,
      chain: docs.map((d, i) => ({ n: i + 1, doc_type: d.doc_type, effective_date: d.effective_date, title: String(d.title ?? '').slice(0, 120), file: d.file })),
      consolidated: text,
      usage: j.usage,
    }, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  } catch (err: unknown) {
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
