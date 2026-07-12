// doc-search — precise recall over extracted documents.
//
// Legs (v6):
//   1. PROPERTY SCOPE: a property named in the query ("...for Magnolia Park")
//      scopes results to that property's documents (graceful relax if empty).
//   2. KEYWORD/TITLE LEG: stemmed query terms → search_documents_by_title RPC.
//   3. VECTOR LEG: pgvector cosine over voyage-3-large chunk embeddings, property-scoped
//      in SQL via match_chunks_voyage (scope applied before ranking, not after).
//   4. RERANK: keyword + vector candidates are merged then ordered by a Voyage
//      rerank-2.5 cross-encoder — title matches no longer hard-pin above the real doc.
//      Cover-page / control-sheet stand-ins are demoted as a final safety net.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY.
//
// Usage: GET ?q=<natural language query>&k=<top N, default 8>

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canReadProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

const VOYAGE_MODEL = Deno.env.get('VOYAGE_MODEL') ?? 'voyage-3-large'   // 1024-dim
const RERANK_MODEL = Deno.env.get('RERANK_MODEL') ?? 'rerank-2.5'

async function embed(text: string, key: string, inputType: 'query' | 'document' = 'query'): Promise<number[]> {
  const r = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text.slice(0, 32000), model: VOYAGE_MODEL, input_type: inputType, output_dimension: 1024 }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Voyage API error: ' + JSON.stringify(d))
  return d.data[0].embedding
}

// Voyage rerank-2.5 cross-encoder — scores each candidate against the query jointly
// (understands that a "cover page" is less relevant than the document it fronts).
async function rerank(query: string, documents: string[], key: string, topK: number): Promise<Array<{ index: number; score: number }>> {
  const r = await fetch('https://api.voyageai.com/v1/rerank', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, documents, model: RERANK_MODEL, top_k: topK, truncation: true }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Voyage rerank error: ' + JSON.stringify(d))
  return ((d.data ?? []) as Array<{ index: number; relevance_score: number }>).map(x => ({ index: x.index, score: x.relevance_score }))
}

const STOP = new Set(['the','a','an','and','or','of','to','in','at','is','are','was','were','what','when','how','did','does','it','its','over','time','current','with','for','on','has','have','who','why','per','all','provide','show','give','pull','list','find','search','documents','document'])
const stem = (w: string) => {
  let s = w.replace(/ies$/, 'i').replace(/s$/, '')
  if (s.length > 4) s = s.replace(/y$/, '')
  return s.length >= 4 ? s : w
}

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    // Runs with the service role (RLS bypass); authorize the caller ourselves.
    const caller = await requireUser(req, sb)

    const url = new URL(req.url)
    const q   = url.searchParams.get('q')
    const k   = Math.min(parseInt(url.searchParams.get('k') ?? '8'), 50)
    if (!q) throw new Error('?q= is required')

    const embKey = Deno.env.get('VOYAGE_API_KEY') ?? ''
    if (!embKey) throw new Error('No embedding key (VOYAGE_API_KEY) set')

    // ── 1. Property scope: does the query name a property? ──
    const { data: props } = await sb.from('properties').select('id, name')
    const ql = q.toLowerCase()
    const propertyIds = ((props ?? []) as Array<{ id: string; name: string }>)
      .filter(p => {
        const name = p.name.toLowerCase()
        if (ql.includes(name)) return true
        // Meaningful name words ("magnolia", "gateway", "knightdale") count too.
        return name.split(/[^a-z]+/).some(w => w.length >= 5 && ql.includes(w))
      })
      .map(p => p.id)
    const inScope = (pid: string | null) => !propertyIds.length || (pid != null && propertyIds.includes(pid))

    // ── 2. Keyword/title leg (runs in parallel with the embedding) ──
    const terms = [...new Set(ql.replace(/[^\w\s]/g, ' ').split(/\s+/)
      .filter(w => w.length >= 4 && !STOP.has(w)).map(stem))].slice(0, 8)
    const singleProp = propertyIds.length === 1 ? propertyIds[0] : null

    const [vec, kdocsRes] = await Promise.all([
      embed(q, embKey, 'query'),
      terms.length
        ? sb.rpc('search_documents_by_title', { p_terms: terms, p_property: singleProp, p_limit: Math.max(k, 15) })
        : Promise.resolve({ data: [] } as any),
    ])
    const keywordIds: string[] = ((kdocsRes.data ?? []) as Array<{ id: string }>).map(d => d.id)

    // ── 3. Vector leg — property-scoped in SQL (Voyage vectors). When a property is
    // named the scope filter is applied before ranking, so results can't be starved
    // by a bigger property's chunks; unscoped falls back to the global HNSW path.
    // Over-fetch a broad candidate pool; the rerank picks the real winners from it,
    // so recall (is the right doc present at all?) matters more than the raw order here.
    const fetchCount = propertyIds.length ? Math.max(k * 6, 48) : Math.max(k * 3, 24)
    const { data, error } = await sb.rpc('match_chunks_voyage', {
      query_embedding: `[${vec.join(',')}]`, match_count: fetchCount,
      p_property_ids: propertyIds.length ? propertyIds : null,
    })
    if (error) throw new Error('match_chunks_voyage failed: ' + error.message)

    // CANDIDATES: keyword/title hits + semantic hits, deduped by document. These are
    // only candidates now — final order comes from the cross-encoder rerank below, so
    // a noisy title match ("Knightdale Marketplace" in some report) can't pin junk
    // above the actual document the user asked for.
    type Hit = { document_id: string; content: string | null; similarity: number | null; targeted: boolean }
    const merged: Hit[] = []
    const seen = new Set<string>()
    for (const id of keywordIds) {
      if (seen.has(id)) continue
      seen.add(id)
      merged.push({ document_id: id, content: null, similarity: null, targeted: true })
    }
    for (const r of (data ?? []) as Array<{ document_id: string; content: string; similarity: number }>) {
      if (seen.has(r.document_id)) continue
      seen.add(r.document_id)
      merged.push({ document_id: r.document_id, content: r.content, similarity: r.similarity, targeted: false })
    }

    // Metadata, then the hard entitlement + (relaxing) property-scope gates.
    const docIds = merged.map(h => h.document_id)
    const { data: docs } = await sb.from('documents')
      .select('id,doc_type,title,file_path,storage_path,property_id,properties(name)')
      .in('id', docIds)
    const metaById = new Map((docs ?? []).map((d: any) => [d.id, d]))

    let hits = merged.filter(h => metaById.has(h.document_id))
    if (caller.access !== 'all') {
      hits = hits.filter(h => canReadProperty(caller, metaById.get(h.document_id)!.property_id))
    }
    if (propertyIds.length) {
      const scoped = hits.filter(h => inScope(metaById.get(h.document_id)!.property_id))
      hits = scoped.length ? scoped : hits    // relax rather than zero out
    }

    // Give every candidate real text (title-leg hits arrive contentless) so the
    // reranker scores on document content, then rerank the pool.
    hits = hits.slice(0, 64)
    const needContent = hits.filter(h => !h.content).map(h => h.document_id)
    if (needContent.length) {
      const { data: chunk0 } = await sb.from('document_chunks')
        .select('document_id, content')
        .in('document_id', needContent)
        .eq('chunk_index', 0)
      const c0 = new Map((chunk0 ?? []).map((c: any) => [c.document_id, c.content]))
      for (const h of hits) if (!h.content) h.content = c0.get(h.document_id) ?? ''
    }

    // ── Rerank (Voyage rerank-2.5) + a soft doc-kind boost: when the query names a
    // document kind ("lease", "estoppel", "loan"…), nudge that doc_type up so the
    // instrument itself outranks documents that merely mention it. ──
    const wantsKind: Record<string, boolean> = {
      lease:          /\blease(s|hold)?\b/.test(ql),
      estoppel:       /\bestoppel/.test(ql),
      loan_agreement: /\bloan\b|\bmortgage\b|deed of trust|promissory|\bnote\b/.test(ql),
      jv_agreement:   /\bjv\b|joint venture|operating agreement|\bpromote\b|waterfall/.test(ql),
      title:          /\btitle\b/.test(ql),
      psa:            /purchase and sale|\bpsa\b|sale agreement/.test(ql),
    }
    try {
      const rr = await rerank(q, hits.map(h => (h.content ?? metaById.get(h.document_id)?.title ?? '').slice(0, 4000)), embKey, hits.length)
      if (rr.length) {
        hits = rr
          .map(x => {
            const h = hits[x.index]
            const dt = (metaById.get(h?.document_id) as any)?.doc_type ?? 'other'
            return { h, s: x.score + (wantsKind[dt] ? 0.15 : 0) }
          })
          .filter(x => x.h)
          .sort((a, b) => b.s - a.s)
          .map(x => x.h)
      }
    } catch (_e) { /* keep merged order on rerank failure */ }

    // Safety net: demote low-value stand-ins (a lease's CONTROL SHEET / cover page, a
    // table of contents) below substantive docs. Stable within each tier.
    const isLowValue = (id: string): boolean => {
      const d = metaById.get(id) as any
      const t = (d?.title ?? '').toLowerCase()
      const base = ((d?.file_path ?? '').toLowerCase().split(/[\\/]/).pop()) ?? ''
      return /\bcover page\b|\bcover sheet\b|control sheet|table of contents/.test(t)
        || /control sheet|cover sheet|cover page/.test(base)
    }
    hits = hits
      .map((h, i) => ({ h, i, low: isLowValue(h.document_id) ? 1 : 0 }))
      .sort((a, b) => a.low - b.low || a.i - b.i)
      .map(x => x.h)
    hits = hits.slice(0, k)

    // Signed view URLs for Storage-mirrored docs (1-hour expiry)
    const paths = [...new Set(hits
      .map(h => metaById.get(h.document_id)!.storage_path)
      .filter((p: string | null) => p && p.startsWith('p/')))] as string[]
    const signed = new Map<string, string>()
    if (paths.length) {
      const { data: s } = await sb.storage.from('documents').createSignedUrls(paths, 3600)
      for (const x of s ?? []) if (x.signedUrl && x.path) signed.set(x.path, x.signedUrl)
    }

    const results = hits.map(h => {
      const d = metaById.get(h.document_id)!
      return {
        similarity: h.similarity != null ? Number(h.similarity.toFixed(4)) : null,
        match:      h.targeted ? 'targeted' : 'semantic',
        document: {
          id: d.id, doc_type: d.doc_type, title: d.title, file_path: d.file_path,
          storage_path: d.storage_path, property: d.properties?.name ?? null,
          view_url: d.storage_path && signed.has(d.storage_path) ? signed.get(d.storage_path) : null,
        },
        snippet: (h.content ?? '').slice(0, 280),
      }
    })

    return new Response(JSON.stringify({ success: true, query: q, count: results.length, results }, null, 2),
      { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
