// doc-ask — cited Q&A + targeted document retrieval over the corpus (RAG).
//
// Pipeline (v6 — hybrid, property-scoped):
//   1. INTENT PARSE (haiku): tenant / property / document-kind out of the question.
//   2. RETRIEVAL — all legs are scoped to the resolved property set IN SQL so a
//      scoped question can't be starved by a bigger property's chunks:
//        a. SEMANTIC leg  — match_chunks_voyage (pgvector over voyage-3-large, property-filtered).
//        b. LEXICAL leg   — search_document_chunks_fts (Postgres FTS, property-filtered).
//        c. DOC-KIND leg  — pull docs by doc_type (jv/loan/management/title/estoppel…)
//                           for the scoped property — surfaces entity docs the vector
//                           leg alone under-ranks (e.g. JV Operating Agreements).
//        d. TENANT leg    — tenant-folder docs (…\TENANTS\<name>\…).
//        e. TITLE leg     — scored title search (search_documents_by_title).
//      Semantic + lexical are fused with Reciprocal Rank Fusion; doc-kind/tenant/
//      title docs are PINNED (guaranteed into the candidate set with their most
//      on-topic chunks).
//   3. RERANK (Voyage rerank-2.5 cross-encoder): order candidates by true relevance;
//      a small haiku pass then emits a LOCATOR per top hit for the PDF viewer.
//   4. SYNTHESIS (sonnet): answer strictly from excerpts with [n] citations.
// Returns { answer, sources, documents }.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY, ANTHROPIC_API_KEY.
// Usage: POST JSON { q: string, property_id?: uuid, k?: number }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canReadProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

const VOYAGE_MODEL = Deno.env.get('VOYAGE_MODEL')  ?? 'voyage-3-large'   // 1024-dim
const RERANK_MODEL = Deno.env.get('RERANK_MODEL')  ?? 'rerank-2.5'
const ANSWER_MODEL = Deno.env.get('ANSWER_MODEL')  ?? 'claude-sonnet-5'
const PARSE_MODEL  = Deno.env.get('PARSE_MODEL')   ?? 'claude-haiku-4-5-20251001'

// Voyage embeddings. input_type 'query' for searches, 'document' for stored chunks —
// Voyage encodes each side differently, which improves retrieval over a symmetric model.
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

// Voyage rerank-2.5 — a cross-encoder that scores each candidate against the query
// jointly (far more precise than bi-encoder cosine). Returns candidate indices in
// descending relevance with a 0-1 score.
async function rerank(query: string, docs: string[], key: string, topK: number): Promise<Array<{ index: number; score: number }>> {
  const r = await fetch('https://api.voyageai.com/v1/rerank', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, documents: docs, model: RERANK_MODEL, top_k: topK, truncation: true }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Voyage rerank error: ' + JSON.stringify(d))
  return ((d.data ?? []) as Array<{ index: number; relevance_score: number }>).map(x => ({ index: x.index, score: x.relevance_score }))
}

async function anthropic(key: string, model: string, prompt: string, maxTokens: number): Promise<string> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Anthropic API error: ' + JSON.stringify(d))
  return (d.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('')
}

interface Intent { tenant: string | null; property: string | null; kinds: string[]; wants_documents: boolean; tenancy: 'current' | 'past' | 'any' }

async function parseIntent(q: string, key: string): Promise<Intent> {
  const fallback: Intent = { tenant: null, property: null, kinds: [], wants_documents: false, tenancy: 'current' }
  try {
    const raw = await anthropic(key, PARSE_MODEL, `Parse this commercial-real-estate document question. Reply with ONLY minified JSON, no prose:
{"tenant": <tenant/company name mentioned or null>, "property": <property/shopping-center name mentioned or null>, "kinds": <array from ["lease","amendment","loan","jv","title","management","closing","estoppel","other"] describing the document kinds sought, or []>, "wants_documents": <true if the user wants the documents themselves pulled up/listed, false if they only want a factual answer>, "tenancy": <"past" if the question asks about expired/terminated/former/previous/inactive/vacated tenants or leases; "any" if it explicitly spans both current and past; otherwise "current">}
Notes: "JV", "joint venture", "promote", "waterfall", "operating agreement", "OA", "capital account", "distribution", "IRR hurdle", "carried interest" all imply kind "jv". "mortgage", "deed of trust", "loan", "note", "DSCR", "covenant" imply "loan". "PMA", "property management" imply "management".
Question: ${q}`, 300)
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return fallback
    const j = JSON.parse(m[0])
    return {
      tenant: typeof j.tenant === 'string' && j.tenant.trim() ? j.tenant.trim() : null,
      property: typeof j.property === 'string' && j.property.trim() ? j.property.trim() : null,
      kinds: Array.isArray(j.kinds) ? j.kinds.filter((x: unknown) => typeof x === 'string') : [],
      wants_documents: j.wants_documents === true,
      tenancy: j.tenancy === 'past' || j.tenancy === 'any' ? j.tenancy : 'current',
    }
  } catch (_e) {
    return fallback
  }
}

// Tenant-folder docs live at …\TENANTS\<name>\… (or …\TENANTS\_TERMINATED TENANTS\<name>\…).
const normName = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '')
function tenantFolderOf(fp: string | null): { name: string | null; terminated: boolean } {
  if (!fp) return { name: null, terminated: false }
  const m = fp.match(/\\TENANTS\\([^\\]+)(?:\\([^\\]+))?/i)
  if (!m) return { name: null, terminated: false }
  if (m[1].startsWith('_')) return { name: m[2] ?? null, terminated: true }   // _TERMINATED TENANTS\<name>
  return { name: m[1], terminated: false }
}

// PostgREST .or() is comma/paren-delimited — strip characters that would break it.
const ilikeSafe = (s: string) => s.replace(/[(),%_]/g, ' ').replace(/\s+/g, ' ').trim()

// Non-tenant document kinds → the doc_type values that carry them. The doc-kind leg
// uses this to pull, e.g., every jv_agreement for the scoped property.
const KIND_DOCTYPES: Record<string, string[]> = {
  jv: ['jv_agreement'],
  loan: ['loan_agreement'],
  title: ['title'],
  estoppel: ['estoppel'],
  closing: ['psa', 'title'],
  // "management" has no dedicated doc_type in the corpus — those PMAs fall through
  // to the semantic/lexical legs and the /management page's own table.
}

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    // Runs with the service role (RLS bypass); authorize the caller ourselves.
    const caller = await requireUser(req, sb)

    const body = await req.json().catch(() => ({}))
    const q: string = body.q ?? ''
    let propertyId: string | null = body.property_id ?? null
    const k: number = Math.min(Number(body.k ?? 8), 20)
    if (!q) throw new Error('q is required')

    const voyageKey = Deno.env.get('VOYAGE_API_KEY') ?? ''
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!voyageKey || !anthropicKey) throw new Error('Missing VOYAGE_API_KEY / ANTHROPIC_API_KEY secrets')

    // ── 1. Intent parse (runs in parallel with the query embedding) ──
    const [intent, vec] = await Promise.all([parseIntent(q, anthropicKey), embed(q, voyageKey, 'query')])

    // Resolve properties named in the question when no explicit filter was chosen.
    // A name like "Knightdale" legitimately matches SEVERAL records (East / West /
    // Consolidated) — scope to the whole set, never just the first match.
    let propertyIds: string[] = propertyId ? [propertyId] : []
    if (!propertyIds.length && intent.property) {
      const { data: props } = await sb.from('properties').select('id, name')
      const needle = intent.property.toLowerCase()
      propertyIds = ((props ?? []) as Array<{ id: string; name: string }>)
        .filter(p => p.name.toLowerCase().includes(needle) || needle.includes(p.name.toLowerCase().split(' ')[0]))
        .map(p => p.id)
    }
    propertyId = propertyIds.length === 1 ? propertyIds[0] : null
    const scope: string[] | null = propertyIds.length ? propertyIds : null
    const inScope = (pid: string | null) => !propertyIds.length || (pid != null && propertyIds.includes(pid))

    // ── Tenancy scope: leases not on the current rent roll are expired/terminated.
    let aq = sb.from('leases').select('tenants(name), property_id').eq('status', 'active')
    if (propertyIds.length) aq = aq.in('property_id', propertyIds)
    const { data: activeLeases } = await aq
    const activeSet = new Set(((activeLeases ?? []) as any[])
      .map(l => normName(l.tenants?.name ?? '')).filter(n => n.length >= 3))
    const intentTenantNorm = intent.tenant ? normName(intent.tenant) : null
    const isActiveName = (n: string) => {
      if (activeSet.has(n)) return true
      for (const a of activeSet) { if (a.length >= 4 && n.length >= 4 && (a.includes(n) || n.includes(a))) return true }
      return false
    }
    const docTenancy = (fp: string | null): 'active' | 'former' | 'n/a' => {
      const { name, terminated } = tenantFolderOf(fp)
      if (!name) return 'n/a'
      if (terminated) return 'former'
      return isActiveName(normName(name)) ? 'active' : 'former'
    }
    const tenancyAllows = (fp: string | null): boolean => {
      const t = docTenancy(fp)
      if (t === 'n/a') return true
      const { name } = tenantFolderOf(fp)
      if (intentTenantNorm && name && (normName(name).includes(intentTenantNorm) || intentTenantNorm.includes(normName(name)))) return true
      if (intent.tenancy === 'any') return true
      return intent.tenancy === 'past' ? t === 'former' : t === 'active'
    }

    type Chunk = { document_id: string; chunk_index: number; content: string; similarity: number | null }
    type DocMeta = { id: string; doc_type: string; title: string | null; file_name: string | null; file_path: string | null; property_id: string | null }

    // ── Concept terms for the lexical leg. Drop stopwords, question/command verbs,
    // and the property NAME words (the FTS leg is already property-scoped, so the
    // location adds only noise). Hyphens kept so "co-tenancy" stays intact.
    const STOP = new Set(['the','a','an','and','or','of','to','in','at','is','are','was','were','what','when','how','did','does','it','its','over','time','current','with','for','on','has','have','who','why','per','all','provide','show','give','pull','list','summarize','summary','summarise','explain','describe','tell','overview','detail','details','information','info','about','into','from','this','that','these','those','please','find','search','document','documents','get'])
    const propWords = new Set((intent.property ?? '').toLowerCase().split(/\s+/).filter(Boolean))
    const conceptTerms = [...new Set(
      q.toLowerCase().replace(/[^\w\s-]/g, ' ').split(/\s+/)
        .filter(w => w.length >= 2 && !STOP.has(w) && !propWords.has(w))
    )].slice(0, 12)
    const ftsQuery = conceptTerms.join(' or ')
    const conceptHits = (content: string): number => {
      const lc = (content ?? '').toLowerCase()
      let s = 0
      for (const t of conceptTerms) if (lc.includes(t)) s++
      return s
    }

    // Stemmed terms for the title RPC (kept from the prior version).
    const stem = (w: string) => {
      let s = w.replace(/ies$/, 'i').replace(/s$/, '')
      if (s.length > 4) s = s.replace(/y$/, '')
      return s.length >= 4 ? s : w
    }
    const titleTerms = [...new Set(q.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/)
      .filter(w => w.length >= 4 && !STOP.has(w)).map(stem))].slice(0, 8)

    // ── 2. Retrieval legs (in parallel) ──
    const fetchCount = 40
    const [vecRes, ftsRes, kindDocsRes, titleRes, tenantDocsRaw] = await Promise.all([
      // a. semantic (scoped, Voyage vectors)
      sb.rpc('match_chunks_voyage', { query_embedding: `[${vec.join(',')}]`, match_count: fetchCount, p_property_ids: scope }),
      // b. lexical (scoped)
      ftsQuery ? sb.rpc('search_document_chunks_fts', { p_query: ftsQuery, match_count: fetchCount, p_property_ids: scope })
               : Promise.resolve({ data: [] } as any),
      // c. doc-kind leg
      (async () => {
        const types = [...new Set(intent.kinds.flatMap(kk => KIND_DOCTYPES[kk] ?? []))]
        if (!types.length) return { data: [] } as any
        let dq = sb.from('documents').select('id, doc_type, title, file_name, file_path, property_id').in('doc_type', types).limit(40)
        if (propertyIds.length) dq = dq.in('property_id', propertyIds)
        return await dq
      })(),
      // e. title leg
      titleTerms.length ? sb.rpc('search_documents_by_title', { p_terms: titleTerms, p_property: propertyId, p_limit: 8 })
                        : Promise.resolve({ data: [] } as any),
      // d. tenant leg (query built inline below when a tenant is named)
      (async () => {
        if (!intent.tenant) return { data: [] } as any
        const t = ilikeSafe(intent.tenant)
        if (t.length < 3) return { data: [] } as any
        let tq = sb.from('documents')
          .select('id, doc_type, title, file_name, file_path, property_id')
          .or(`title.ilike.%${t}%,file_path.ilike.%${t}%`)
          .limit(80)
        if (propertyIds.length) tq = tq.in('property_id', propertyIds)
        return await tq
      })(),
    ])
    if (vecRes.error) throw new Error('match_chunks_voyage failed: ' + vecRes.error.message)

    const vecHits = (vecRes.data ?? []) as Array<{ document_id: string; chunk_index: number; content: string; similarity: number }>
    const ftsHits = (ftsRes.data ?? []) as Array<{ document_id: string; chunk_index: number; content: string; rank: number }>

    // ── Reciprocal Rank Fusion of the semantic + lexical chunk lists.
    // Keyed by (document_id, chunk_index) so distinct chunks of one doc compete
    // on their own merits; keeps the actual cosine similarity when available.
    const RRF_K = 60
    const chunkKey = (d: string, i: number) => `${d}#${i}`
    const fused = new Map<string, { chunk: Chunk; score: number }>()
    const addList = (list: Array<{ document_id: string; chunk_index: number; content: string; similarity?: number }>) => {
      list.forEach((it, rank) => {
        const key = chunkKey(it.document_id, it.chunk_index)
        const inc = 1 / (RRF_K + rank)
        const prev = fused.get(key)
        if (prev) { prev.score += inc; if (it.similarity != null && prev.chunk.similarity == null) prev.chunk.similarity = it.similarity }
        else fused.set(key, { chunk: { document_id: it.document_id, chunk_index: it.chunk_index, content: it.content, similarity: it.similarity ?? null }, score: inc })
      })
    }
    addList(vecHits)
    addList(ftsHits.map(h => ({ document_id: h.document_id, chunk_index: h.chunk_index, content: h.content })))
    const fusedChunks = [...fused.values()].sort((a, b) => b.score - a.score).map(x => x.chunk)

    // ── Pinned docs (doc-kind → tenant → title). These are guaranteed into the
    // candidate set with their most on-topic chunks, so entity documents the
    // vector leg under-ranks still reach synthesis.
    const kindDocs   = ((kindDocsRes.data ?? []) as DocMeta[]).filter(d => tenancyAllows(d.file_path))
    const titleIds   = ((titleRes.data ?? []) as Array<{ id: string }>).map(d => d.id)
    // Tenant leg: whole-word filter + relevance score (kept from prior version).
    let tenantDocs: DocMeta[] = []
    if (intent.tenant) {
      const t = ilikeSafe(intent.tenant)
      const wordRe = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}`, 'i')
      const wantLease = intent.kinds.includes('lease') || intent.kinds.includes('amendment')
      const score = (d: DocMeta) => {
        let s = 0
        const path = (d.file_path ?? '').toLowerCase(); const title = (d.title ?? '').toLowerCase()
        if (path.includes('\\tenants\\')) s += 4
        if (wantLease && d.doc_type === 'lease') s += 4
        if (/\b(agr|lease)\b|lease agreement/.test(title)) s += 2
        if (/\b(amd|amendment)\b/.test(title) || /amd|amendment/.test(path)) s += 2
        if (path.includes(t.toLowerCase())) s += 2
        // A CONTROL SHEET / cover page is just a stand-in for the real document.
        if (/cover page|cover sheet|control sheet|table of contents/.test(title) || /control sheet|cover sheet|cover page/.test(path)) s -= 6
        return s
      }
      tenantDocs = ((tenantDocsRaw.data ?? []) as DocMeta[])
        .filter(d => wordRe.test(d.title ?? '') || wordRe.test(d.file_path ?? ''))
        .filter(d => tenancyAllows(d.file_path))
        .map(d => ({ d, s: score(d) })).sort((a, b) => b.s - a.s).slice(0, 25).map(x => x.d)
    }
    if (caller.access !== 'all') {
      tenantDocs = tenantDocs.filter(d => canReadProperty(caller, d.property_id))
    }

    // Ordered, de-duplicated list of pinned document ids.
    const pinnedIds: string[] = []
    const pinnedSeen = new Set<string>()
    for (const id of [...tenantDocs.slice(0, 8).map(d => d.id), ...kindDocs.map(d => d.id), ...titleIds]) {
      if (!pinnedSeen.has(id)) { pinnedSeen.add(id); pinnedIds.push(id) }
    }

    // For pinned docs, pull their chunks and keep the up-to-3 most on-topic ones
    // (by concept-term coverage; chunk 0 as a floor) so the "Promote / Waterfall"
    // section — not just a title page — reaches the model.
    const pinnedChunks: Chunk[] = []
    if (pinnedIds.length) {
      const { data: pc } = await sb.from('document_chunks')
        .select('document_id, chunk_index, content')
        .in('document_id', pinnedIds)
      const byDoc = new Map<string, Array<{ chunk_index: number; content: string }>>()
      for (const c of (pc ?? []) as Array<{ document_id: string; chunk_index: number; content: string }>) {
        if (!byDoc.has(c.document_id)) byDoc.set(c.document_id, [])
        byDoc.get(c.document_id)!.push({ chunk_index: c.chunk_index, content: c.content })
      }
      for (const id of pinnedIds) {
        const chunks = byDoc.get(id) ?? []
        const ranked = chunks
          .map(c => ({ c, s: conceptHits(c.content) }))
          .sort((a, b) => b.s - a.s || a.c.chunk_index - b.c.chunk_index)
        const take = (ranked.length && ranked[0].s > 0) ? ranked.slice(0, 3) : ranked.slice(0, 1)
        for (const { c } of take) pinnedChunks.push({ document_id: id, chunk_index: c.chunk_index, content: c.content, similarity: 0.999 })
      }
    }

    // ── Merge pinned + fused into the candidate chunk set (cap per doc). ──
    const perDoc = new Map<string, number>()
    const seenChunk = new Set<string>()
    const candidates: Chunk[] = []
    const pushChunk = (c: Chunk, capPerDoc: number) => {
      const key = chunkKey(c.document_id, c.chunk_index)
      if (seenChunk.has(key)) return
      const n = perDoc.get(c.document_id) ?? 0
      if (n >= capPerDoc) return
      seenChunk.add(key); perDoc.set(c.document_id, n + 1); candidates.push(c)
    }
    for (const c of pinnedChunks) pushChunk(c, 3)
    for (const c of fusedChunks) pushChunk(c, 3)

    // ── 3. Rerank (Voyage rerank-2.5 cross-encoder) then emit LOCATORS (haiku). ──
    const locators = new Map<string, string>()
    const LOCSTOP = new Set([...STOP, 'clause', 'section', 'agreement', 'document'])
    const rawTokens = q.toLowerCase().replace(/[^\w\s-]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !LOCSTOP.has(w))
    const fallbackLocator = rawTokens.slice(0, 2).join(' ') || null
    let ranked = candidates.slice(0, 40)
    if (ranked.length >= 2) {
      // 3a. Cross-encoder rerank — orders candidates by true relevance to the question.
      try {
        const rr = await rerank(q, ranked.map(h => (h.content ?? '').slice(0, 4000)), voyageKey, Math.min(ranked.length, 20))
        if (rr.length) ranked = rr.map(x => ranked[x.index]).filter(Boolean)
      } catch (_e) { /* keep fused order */ }
      // 3b. Locators for the top hits — the phrase the in-app PDF viewer jumps to. Non-fatal.
      try {
        const top = ranked.slice(0, 10)
        const listing = top.map((h, i) => `${i}: ${(h.content ?? '').slice(0, 400).replace(/\s+/g, ' ')}`).join('\n')
        const raw = await anthropic(anthropicKey, PARSE_MODEL, `For each numbered excerpt, give "loc": a 1-3 word phrase that would appear VERBATIM in the underlying legal document at the section answering the question (prefer defined-term capitalization, e.g. "Co-Tenancy", "Percentage Rent", "Distribution", "Promote"; null if unclear). Reply ONLY with minified JSON: {"locs":[{"i":<index>,"loc":<string or null>}...]}.
QUESTION: ${q}
EXCERPTS:
${listing}`, 500)
        const m = raw.match(/\{[\s\S]*\}/)
        if (m) for (const x of ((JSON.parse(m[0]).locs ?? []) as Array<{ i: number; loc?: string | null }>)) {
          const hit = top[x.i]
          if (hit && x.loc && typeof x.loc === 'string' && x.loc.trim()) locators.set(hit.document_id, x.loc.trim())
        }
      } catch (_e) { /* no smart locators — fallbackLocator still applies */ }
    }

    // ── Metadata + signed URLs ──
    const docIds = [...new Set([...ranked.map(r => r.document_id), ...tenantDocs.map(d => d.id), ...kindDocs.map(d => d.id)])]
    const { data: docs } = await sb.from('documents')
      .select('id, doc_type, title, file_name, file_path, storage_path, property_id, properties(name)')
      .in('id', docIds)
    const byId = new Map((docs ?? []).map((d: { id: string }) => [d.id, d]))

    const storagePaths = [...new Set((docs ?? []).map((d: any) => d.storage_path).filter((p: string | null) => p && p.startsWith('p/')))] as string[]
    const signedByPath = new Map<string, string>()
    if (storagePaths.length) {
      const { data: signed } = await sb.storage.from('documents').createSignedUrls(storagePaths, 3600)
      for (const s of signed ?? []) if (s.signedUrl && s.path) signedByPath.set(s.path, s.signedUrl)
    }

    // ── Filters: entitlement (hard) → property scope (relax) → tenancy (relax). ──
    let hits = ranked
    if (caller.access !== 'all') {
      hits = hits.filter(h => canReadProperty(caller, (byId.get(h.document_id) as any)?.property_id ?? null))
    }
    if (propertyIds.length) {
      const scoped = hits.filter(h => inScope((byId.get(h.document_id) as any)?.property_id ?? null))
      hits = scoped.length ? scoped : hits
    }
    {
      const tenancyScoped = hits.filter(h => tenancyAllows((byId.get(h.document_id) as any)?.file_path ?? null))
      hits = tenancyScoped.length ? tenancyScoped : hits
    }
    // Keep up to ~14 excerpt chunks (still capped ≤3 per doc from earlier).
    hits = hits.slice(0, Math.max(k, 14))

    const linkFor = (fp: string | null, storagePath: string | null): { link: string | null; path: string | null } => {
      const signed = storagePath && signedByPath.has(storagePath) ? signedByPath.get(storagePath)! : null
      if (!fp) return { link: signed, path: null }
      if (fp.startsWith('drive:')) return { link: signed ?? `https://drive.google.com/file/d/${fp.slice(6)}/view`, path: null }
      if (fp.startsWith('file:')) return { link: signed, path: fp.slice(5).replace(/#pages.*$/, '') }
      return { link: signed, path: fp }
    }

    // The document list the UI renders: a targeted set (tenant → doc-kind) when the
    // user wanted documents pulled up; otherwise the distinct cited documents.
    const citedDocsOrder: DocMeta[] = []
    const citedSeen = new Set<string>()
    for (const h of hits) {
      if (citedSeen.has(h.document_id)) continue
      const d = byId.get(h.document_id) as unknown as DocMeta | undefined
      if (d) { citedSeen.add(h.document_id); citedDocsOrder.push(d) }
    }
    const listSource: DocMeta[] = tenantDocs.length ? tenantDocs : kindDocs.length ? kindDocs : citedDocsOrder
    const documents = listSource.slice(0, 25).map(d => {
      const full = byId.get(d.id) as any
      const meta = full ?? d
      const { link, path } = linkFor(meta.file_path, full?.storage_path ?? null)
      return {
        id: d.id,
        title: meta.title ?? meta.file_name ?? d.id,
        doc_type: meta.doc_type,
        property: full?.properties?.name ?? null,
        link, path,
        locator: locators.get(d.id) ?? fallbackLocator,
        tenancy: docTenancy(meta.file_path),
      }
    })

    if (!hits.length) {
      return new Response(JSON.stringify({
        success: true, query: q, intent,
        answer: 'No relevant documents were found for that question' + (propertyId ? ' at this property.' : '.'),
        sources: [], documents,
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // Sources = one entry per cited document (first/best chunk wins).
    const srcSeen = new Set<string>()
    const sources = hits.filter(h => { if (srcSeen.has(h.document_id)) return false; srcSeen.add(h.document_id); return true })
      .map((h, i) => {
        const d = byId.get(h.document_id) as any
        const isPinned = h.similarity === 0.999
        const { link, path } = linkFor(d?.file_path ?? null, d?.storage_path ?? null)
        return {
          n: i + 1,
          match: isPinned ? 'targeted' : 'semantic',
          similarity: isPinned || h.similarity == null ? null : Number(h.similarity.toFixed(4)),
          document_id: h.document_id,
          title: d?.title ?? d?.file_name ?? h.document_id,
          doc_type: d?.doc_type ?? 'other',
          property: d?.properties?.name ?? null,
          link, path,
          locator: locators.get(h.document_id) ?? fallbackLocator,
        }
      })
    const srcNum = new Map(sources.map(s => [s.document_id, s.n]))

    // Excerpts: number by the SOURCE the chunk belongs to (multiple chunks of one
    // doc share its [n]) so citations line up with the sources list.
    const excerpts = hits.map(h => {
      const d = byId.get(h.document_id) as any
      const n = srcNum.get(h.document_id) ?? '?'
      const t = docTenancy(d?.file_path ?? null)
      const head = `[${n}] "${d?.title ?? 'Untitled'}"${d?.properties?.name ? ` (${d.properties.name})` : ''}${t === 'former' ? ' [FORMER TENANT — not on current rent roll]' : ''}`
      return `${head}\n${(h.content ?? '').slice(0, 6000)}`
    }).join('\n\n---\n\n')

    const tenancyNote = intent.tenancy === 'past'
      ? '\n- The user asked about PAST/terminated tenancies; excerpts are scoped accordingly.'
      : '\n- Scope is CURRENT tenants (per the latest rent roll). If an excerpt is tagged [FORMER TENANT], state plainly that the tenant is no longer current before describing its terms; never present former-tenant terms as active obligations.'

    const docListNote = documents.length
      ? `\n\nA "Matched documents" list of ${documents.length} document(s) is shown to the user alongside your answer — if the user asked to pull up documents, briefly confirm what was found (count, kinds, date order) and refer them to that list; do not enumerate every file yourself.`
      : ''

    const prompt = `You are the document-intelligence assistant for M&J Wilkow's commercial real estate asset-management platform. Answer the user's question using ONLY the document excerpts below. Rules:
- Cite excerpts inline as [1], [2], … after each claim they support.
- Quote exact figures ($, %, dates, section numbers) when present.
- Multiple excerpts may share a citation number when they come from the same document — that is expected.
- If the excerpts do not contain the answer, say so plainly — do not guess.
- Note when later amendments supersede earlier terms (use effective dates).
- Be concise: a short direct answer first, then supporting detail.${tenancyNote}${docListNote}

QUESTION: ${q}

EXCERPTS:
${excerpts}`

    const answer = await anthropic(anthropicKey, ANSWER_MODEL, prompt, 1500)

    return new Response(JSON.stringify({ success: true, query: q, intent, answer, sources, documents }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
