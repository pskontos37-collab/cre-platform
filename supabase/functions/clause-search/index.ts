// clause-search — semantic clause search over the verbatim-text corpus, for the
// /clauses page. "leases where the tenant can go dark without landlord consent"
// finds the actual clause passages, not keyword matches.
//
// POST JSON { query: string, property_ids?: uuid[], count?: number }
// → Voyage-embeds the query (input_type 'query'), calls match_chunks_voyage
//   (HNSW, scoped to the caller's readable properties), joins document metadata,
//   and returns passages with page numbers so the UI can deep-link the PDF.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, corsHeaders, requireUser } from '../_shared/auth.ts'

const VOYAGE_MODEL = Deno.env.get('VOYAGE_MODEL') ?? 'voyage-3-large'

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const caller = await requireUser(req, sb)

    const body = await req.json().catch(() => ({}))
    const query: string = (body.query ?? '').trim()
    if (query.length < 4) throw new Error('query must be at least 4 characters')
    const count = Math.max(1, Math.min(Number(body.count) || 25, 60))

    // Scope: requested properties intersected with what the caller may read.
    let propertyIds: string[] | null = Array.isArray(body.property_ids) && body.property_ids.length ? body.property_ids : null
    if (caller.access !== 'all') {
      const allowed = caller.access as Set<string>
      propertyIds = (propertyIds ?? [...allowed]).filter(id => allowed.has(id))
      if (!propertyIds.length) throw new AuthError('No readable properties in scope', 403)
    }

    // Embed the query.
    const vKey = Deno.env.get('VOYAGE_API_KEY') ?? ''
    if (!vKey) throw new Error('VOYAGE_API_KEY secret not set')
    const vr = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${vKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: query, model: VOYAGE_MODEL, input_type: 'query', output_dimension: 1024 }),
    })
    const vd = await vr.json()
    if (!vr.ok) throw new Error('Voyage error: ' + JSON.stringify(vd))
    const emb = `[${vd.data[0].embedding.join(',')}]`

    // Vector match (over-fetch, then keep verbatim-text chunks / dedupe per doc).
    const { data: hits, error: mErr } = await sb.rpc('match_chunks_voyage', {
      query_embedding: emb, match_count: count * 3, p_property_ids: propertyIds,
    })
    if (mErr) throw new Error('match failed: ' + mErr.message)

    const ids = [...new Set((hits ?? []).map((h: { document_id: string }) => h.document_id))]
    const { data: docs } = await sb.from('documents')
      .select('id, title, file_name, doc_type, storage_path, property_id, properties(name)')
      .in('id', ids)
    const docMap = new Map((docs ?? []).map((d: any) => [d.id, d]))

    // page_number lives on the chunk row; the RPC doesn't return it — fetch for the kept set.
    const seen = new Set<string>()
    const kept: any[] = []
    for (const h of (hits ?? []) as any[]) {
      const d = docMap.get(h.document_id)
      if (!d) continue
      const key = `${h.document_id}:${Math.floor(h.chunk_index / 3)}`   // collapse near-duplicate windows
      if (seen.has(key)) continue
      seen.add(key)
      kept.push(h)
      if (kept.length >= count) break
    }
    const pageRows = kept.length ? (await sb.from('document_chunks')
      .select('document_id, chunk_index, page_number')
      .in('document_id', [...new Set(kept.map(k => k.document_id))])
      .in('chunk_index', [...new Set(kept.map(k => k.chunk_index))])).data ?? [] : []
    const pageMap = new Map(pageRows.map((r: any) => [`${r.document_id}:${r.chunk_index}`, r.page_number]))

    const results = kept.map(h => {
      const d: any = docMap.get(h.document_id)
      return {
        passage: String(h.content ?? '').slice(0, 900),
        similarity: h.similarity,
        document_id: h.document_id,
        doc_title: d.title ?? d.file_name,
        doc_type: d.doc_type,
        storage_path: d.storage_path,
        property_name: d.properties?.name ?? null,
        page_number: pageMap.get(`${h.document_id}:${h.chunk_index}`) ?? null,
      }
    })

    return new Response(JSON.stringify({ query, results }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 400
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
