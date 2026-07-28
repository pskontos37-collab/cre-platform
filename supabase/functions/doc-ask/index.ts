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
//        f. EXCLUSIVES leg — for "can I put a <use> here?" questions, route through
//                           the curated property_exclusives registry to the tenant
//                           that HOLDS the implicated exclusive and pin THAT tenant's
//                           own lease as the primary source. Exclusives are restated
//                           in other tenants' "Existing Exclusives" exhibits in an
//                           ABRIDGED form (carve-outs dropped) and those restatements
//                           out-retrieve the real covenant, so they are demoted and
//                           labelled secondary rather than allowed to be cited as
//                           controlling.
//        g. LEASE REGISTER — for TERM questions, inject the structured `leases` rows
//                           for the scoped property. Term dates are NOT a document
//                           question: `leases` is MRI-reconciled and updated as
//                           amendments execute, while estoppels / notice letters /
//                           monthly reports state the term as of their own date. With
//                           no tenant named the tenant leg cannot fire and retrieval
//                           returns ZERO lease documents, so term answers were being
//                           built from stale snapshots. REA-member rows are held out:
//                           0-sf easement placeholders on an artificial horizon date.
//                           For RENT questions the same register carries the contractual
//                           rent step in effect (from lease_rent_schedule, which
//                           reconciles to the MRI rent roll) plus the latest LOADED
//                           rent-roll period as provenance. Zero-rent is reported as one
//                           of two DIFFERENT things: executed-but-RCD-not-yet-in-effect,
//                           or a genuine missing row where the RCD has already passed.
//      Semantic + lexical are fused with Reciprocal Rank Fusion; doc-kind/tenant/
//      title docs are PINNED (guaranteed into the candidate set with their most
//      on-topic chunks). Exclusives-leg chunks are pinned AND re-seated ahead of the
//      reranked list, because the cross-encoder prefers the plain-language
//      restatement over the covenant that actually binds.
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

interface Intent {
  tenant: string | null; property: string | null; kinds: string[]; wants_documents: boolean
  tenancy: 'current' | 'past' | 'any'
  // A "can I put a <use> here?" / "what exclusives restrict <use>?" question. Drives
  // the exclusives-registry leg below.
  use_question: boolean
  proposed_use: string | null
  // A question about lease TERM — expiration, commencement, rollover, option timing.
  // Drives the lease-register leg: those dates live in `leases`, which is
  // MRI-reconciled and kept current, whereas an estoppel or a monthly report is a
  // point-in-time snapshot that a later amendment may have superseded.
  term_question: boolean
  // A question about RENT — base rent, psf, escalations, totals. Same reasoning as
  // term: the figures live in `lease_rent_schedule` (which reconciles to the MRI rent
  // roll), while documents carry budgets and years-old snapshots.
  rent_question: boolean
}

// Belt-and-braces for the use_question flag: if the parse fails or the model is
// conservative, these phrasings still open the exclusives leg.
const USE_Q_RE = /\b(exclusive|exclusivit|prohibited use|restricted use|use restriction|permitted use|radius restriction|violate|conflict)\w*\b|\bcan (?:i|we|you|the landlord|landlord)\b.*\b(put|lease|sign|bring|add|place|open|backfill|re-?let)\b|\b(allowed|permitted|able) to (?:put|lease|sign|bring|add|place|open)\b/i

// Same belt-and-braces for term questions.
const TERM_Q_RE = /\b(expir\w*|lease end|end of (?:the )?term|lease term|term end\w*|roll ?over|rollover|renew\w*|extension option|option to extend|commence\w*|walt|weighted average lease term|maturit\w*|vacat\w*|when does .{0,40}\blease\b|how (?:long|much time) .{0,30}\blease\b)\b/i

// ...and for rent questions. "psf"/"per square foot" counts on its own because that is
// almost always a rent question in this corpus.
const RENT_Q_RE = /\b(base rent|rent|rents|rental rate|escalation|escalat\w*|psf|per square foot|per sf|rent roll|abatement|free rent|gross rent|net effective)\b/i

async function parseIntent(q: string, key: string): Promise<Intent> {
  const fallback: Intent = {
    tenant: null, property: null, kinds: [], wants_documents: false, tenancy: 'current',
    use_question: USE_Q_RE.test(q), proposed_use: null,
    term_question: TERM_Q_RE.test(q), rent_question: RENT_Q_RE.test(q),
  }
  try {
    const raw = await anthropic(key, PARSE_MODEL, `Parse this commercial-real-estate document question. Reply with ONLY minified JSON, no prose:
{"tenant": <tenant/company name mentioned or null>, "property": <property/shopping-center name mentioned or null>, "kinds": <array from ["lease","amendment","loan","jv","title","management","closing","estoppel","other"] describing the document kinds sought, or []>, "wants_documents": <true if the user wants the documents themselves pulled up/listed, false if they only want a factual answer>, "tenancy": <"past" if the question asks about expired/terminated/former/previous/inactive/vacated tenants or leases; "any" if it explicitly spans both current and past; otherwise "current">, "use_question": <true if the question asks whether some USE or TENANT TYPE may be placed/leased at the property, or asks what exclusive-use / prohibited-use restrictions apply>, "proposed_use": <the use or business type at issue, as a short noun phrase (e.g. "hamburger restaurant", "nail salon", "off-price apparel"), or null>, "term_question": <true if the question concerns lease TERM — when a lease expires or commences, what is rolling over, remaining term, renewal/extension option timing, or WALT>, "rent_question": <true if the question concerns RENT — base rent, rent per square foot, escalations, rent totals, or rent roll figures>}
Notes: "JV", "joint venture", "promote", "waterfall", "operating agreement", "OA", "capital account", "distribution", "IRR hurdle", "carried interest" all imply kind "jv". "mortgage", "deed of trust", "loan", "note", "DSCR", "covenant" imply "loan". "PMA", "property management" imply "management".
A question like "can I put in a hamburger restaurant at X" is use_question=true, proposed_use="hamburger restaurant", tenant=null (Five Guys is NOT mentioned — do not infer the incumbent).
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
      use_question: j.use_question === true || USE_Q_RE.test(q),
      proposed_use: typeof j.proposed_use === 'string' && j.proposed_use.trim() ? j.proposed_use.trim() : null,
      term_question: j.term_question === true || TERM_Q_RE.test(q),
      rent_question: j.rent_question === true || RENT_Q_RE.test(q),
    }
  } catch (_e) {
    return fallback
  }
}

// ── Exclusives registry support ──────────────────────────────────────────────
// property_exclusives is the curated ground truth for WHO holds which exclusive.
// Its `description` is capped at ~500 chars by the seeder, so it is a ROUTER, not
// a source: it tells us which tenant's lease to pin, and that lease supplies the
// controlling text (including carve-outs the 500-char summary drops).
interface ExclusiveRow {
  id: string; property_id: string; owner_tenant: string; category: string | null
  description: string | null; source_citation: string | null; keywords: string[] | null
}

// Corporate suffixes / connectors that must not constrain a tenant-folder match.
// "Five Guys Burgers and Fries" has to reach the folder "Five Guys Burgers & Fries
// (Quintet Acquisitions)"; "PETSMART LLC#3279" has to reach "PetSmart LLC".
const NAME_NOISE = new Set(['and', 'the', 'llc', 'inc', 'corp', 'lp', 'llp', 'ltd', 'co', 'company', 'stores', 'store'])
function coreTokens(owner: string): string[] {
  return owner.toLowerCase()
    .replace(/#\s*\d+/g, ' ')            // store numbers: "Michaels #6725", "LLC#3279"
    .replace(/\bd\/?b\/?a\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')        // & ' , . ( ) all become separators
    .split(/\s+/)
    .filter(t => t.length >= 2 && !NAME_NOISE.has(t))
    .slice(0, 4)
}

// Lease boilerplate that appears in EVERY exclusive clause — scoring chunks on these
// would rank any random lease page. What discriminates is the protected-use nouns
// ("hamburgers", "fries"), so strip the shell and keep the substance.
const EXCL_BOILERPLATE = new Set([
  'landlord', 'landlords', 'tenant', 'tenants', 'lease', 'leases', 'leased', 'premises',
  'shopping', 'center', 'exclusive', 'exclusives', 'agrees', 'agree', 'shall', 'will', 'not',
  'hereafter', 'enter', 'into', 'new', 'whose', 'principal', 'permitted', 'use', 'defined',
  'hereinafter', 'default', 'provisions', 'term', 'during', 'business', 'open', 'operating',
  'restriction', 'apply', 'aforementioned', 'existing', 'successors', 'assigns', 'replacements',
  'renewed', 'extended', 'modified', 'amended', 'sale', 'retail', 'other', 'any', 'such', 'that',
  'this', 'with', 'from', 'section', 'article', 'exhibit', 'rider', 'provided', 'purposes',
  'means', 'deemed', 'only', 'long', 'using', 'otherwise', 'beyond', 'applicable', 'cure',
  'period', 'herein', 'hereby', 'respect', 'connection', 'including', 'limited', 'without',
  'within', 'upon', 'each', 'more', 'less', 'than', 'been', 'have', 'their', 'which', 'where',
  'when', 'while', 'also', 'must', 'notice', 'written', 'right', 'rights', 'party', 'parties',
  'space', 'store', 'stores', 'area', 'operate', 'conduct', 'primary', 'auto', 'seeded',
])
// The discriminating nouns only ("hamburgers", "fries") — the clause shell appears in
// every exclusive at every property and would match any random lease page. These terms
// both rank chunks and, crucially, keep the chunk fetch from pulling whole 300-chunk leases.
function exclusiveTerms(row: ExclusiveRow): string[] {
  const cat = row.category && row.category !== 'auto-seeded' ? row.category : ''
  const src = `${cat} ${row.description ?? ''}`.toLowerCase()
  return [...new Set(
    src.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
      .filter(w => w.length >= 4 && !EXCL_BOILERPLATE.has(w))
  )].slice(0, 12)
}

// Which registry entries does the proposed use actually implicate? Term overlap is
// hopeless here ("burger joint" vs "hamburgers and French fries"), so ask the small
// model over the property-scoped list — at most 26 rows for the largest property.
async function matchExclusives(q: string, use: string | null, rows: ExclusiveRow[], key: string): Promise<Set<string>> {
  if (!rows.length) return new Set()
  const listing = rows.map((r, i) =>
    `${i}: OWNER=${r.owner_tenant} | CATEGORY=${r.category ?? '-'} | ${(r.description ?? '').slice(0, 280).replace(/\s+/g, ' ')}`
  ).join('\n')
  try {
    const raw = await anthropic(key, PARSE_MODEL, `You are screening a proposed retail use against a shopping center's recorded exclusive-use restrictions. Return the restrictions that must be reviewed.

These clauses bind on the NEW tenant's "principal permitted use" / "primary use", so:
- INCLUDE a restriction when the proposed use's own core offering IS the protected category or a recognised sub-type of it, or when the protected category is drawn broadly enough to cover it (e.g. "any restaurant", "any quick-service restaurant").
- EXCLUDE a restriction when the overlap would only be incidental, and EXCLUDE sibling sub-types of the same broad industry — a hamburger restaurant does NOT implicate a submarine-sandwich exclusive, a pizza exclusive, or a steakhouse exclusive, because none of those is its principal use.
- If you genuinely cannot tell whether the categories overlap, include it.

Reply ONLY with minified JSON: {"hits":[<indices>]}. Empty array if none apply.

PROPOSED USE: ${use ?? '(not stated explicitly)'}
FULL QUESTION: ${q}

RESTRICTIONS:
${listing}`, 400)
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return new Set()
    const idx = (JSON.parse(m[0]).hits ?? []) as unknown[]
    const out = new Set<string>()
    for (const i of idx) if (typeof i === 'number' && rows[i]) out.add(rows[i].id)
    return out
  } catch (_e) {
    return new Set()
  }
}

// Tenant-folder docs live at …\TENANTS\<name>\… (or …\TENANTS\_TERMINATED TENANTS\<name>\…).
// "and" is dropped because folder names and rent-roll names disagree on it: the folder
// "Five Guys Burgers & Fries (Quintet Acquisitions)" and the rent-roll "Five Guys Burgers
// and Fries" otherwise normalise to different strings, and the tenancy classifier below
// would file a live tenant as FORMER.
const normName = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/\band\b/g, '').replace(/[^a-z0-9]/g, '')
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
    // Exclusives registry is admin/AM-gated by RLS, but this function runs as the
    // service role — so scope it to the properties the CALLER may actually read.
    const exclScope = (scope ?? []).filter(pid => caller.access === 'all' || canReadProperty(caller, pid))

    const fetchCount = 40
    const [vecRes, ftsRes, kindDocsRes, titleRes, tenantDocsRaw, exclRes, leaseRegRes, rrPeriodRes] = await Promise.all([
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
      // f. exclusives-registry leg — only for property-scoped use questions. A
      //    portfolio-wide "what exclusives exist" is not what this leg is for.
      (intent.use_question && exclScope.length)
        ? sb.from('property_exclusives')
            .select('id, property_id, owner_tenant, category, description, source_citation, keywords')
            .in('property_id', exclScope).eq('active', true).limit(60)
        : Promise.resolve({ data: [] } as any),
      // g. LEASE-REGISTER leg — term dates come from `leases`, not from documents.
      //    An estoppel or a monthly report states the term as of ITS date; a later
      //    amendment supersedes it, and the register already carries that. Retrieval
      //    with no tenant named returns zero lease documents, so without this the
      //    model answers term questions off stale snapshots.
      ((intent.term_question || intent.rent_question) && exclScope.length)
        ? sb.from('leases')
            .select('id, property_id, expiration_date, commencement_date, rent_commencement_date, leased_sf, status, is_rea_member, tenants(name), units(unit_number), lease_options(is_exercised, option_type, notice_deadline, term_if_exercised_months), lease_rent_schedule(effective_date, annual_rent, rent_per_sf)')
            .in('property_id', exclScope).eq('status', 'active').limit(200)
        : Promise.resolve({ data: [] } as any),
      // h. Latest MRI rent-roll period per scoped property — provenance only, so the
      //    answer can say how current the independent cross-check is. The KM East
      //    snapshot sat at 2025-09 while 2026 rent rolls waited unloaded on the file
      //    server, and nothing in the answer surfaced that gap.
      (intent.rent_question && exclScope.length)
        ? sb.from('rent_roll_snapshots')
            .select('property_id, period_year, period_month, properties(name)')
            .in('property_id', exclScope)
            .order('period_year', { ascending: false }).order('period_month', { ascending: false }).limit(20)
        : Promise.resolve({ data: [] } as any),
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

    // ── f. EXCLUSIVES-REGISTRY LEG ────────────────────────────────────────────
    // Exclusives get restated in OTHER tenants' leases as "Existing Exclusives"
    // exhibits, and those restatements are abridged — the HomeGoods schedule states
    // the Five Guys hamburger exclusive but keeps only the 10,000 sf carve-out,
    // dropping the outparcel and existing-tenant carve-outs that decide real deals.
    // They also read as better answers to a plain-language use question ("...is
    // prohibited") than the owner's own covenant language ("Landlord will not
    // hereafter enter into a new lease..."), so they win retrieval outright.
    // This leg fixes the attribution: route through the curated registry to the
    // tenant that HOLDS the exclusive, pin THAT tenant's lease as the primary
    // source, and mark every restatement as secondary.
    const exclRows = ((exclRes.data ?? []) as ExclusiveRow[])
    const implicatedIds = intent.use_question
      ? await matchExclusives(q, intent.proposed_use, exclRows, anthropicKey)
      : new Set<string>()
    const implicated = exclRows.filter(r => implicatedIds.has(r.id)).slice(0, 4)

    // Owner tenant -> that tenant's own lease documents. Token-joined ilike so
    // "Five Guys Burgers and Fries" reaches the folder "…\Five Guys Burgers & Fries
    // (Quintet Acquisitions)\…" and "Salt Grass" reaches "Saltgrass".
    const primaryDocIds = new Set<string>()
    const primaryOwnerByDoc = new Map<string, string>()
    const exclChunks: Chunk[] = []
    const ownerCores: Array<{ owner: string; toks: string[] }> = []

    if (implicated.length) {
      const leaseScore = (d: DocMeta): number => {
        const path = (d.file_path ?? '').toLowerCase()
        let s = 0
        if (d.doc_type === 'lease') s += 5
        if (path.includes('\\tenants\\')) s += 3
        if (/\blse-/.test(path)) s += 5                                  // house naming for an original lease
        if (/\bamd-|amendment/.test(path)) s += 3                        // amendments can modify the exclusive
        if (/ocr\.pdf$/.test(path)) s += 1                               // richer text layer of a duplicate pair
        if (/control sheet|cover sheet|cover page|table of contents/.test(path)) s -= 8
        if (/est cert|estoppel|\bguar-|fedex|\bltr-|\bntc ltr|\blic agr/.test(path)) s -= 4
        return s
      }
      // Most leases here were ingested twice — "LSE-Five Guys (6-30-06).pdf" and
      // "…(6-30-06)OCR.pdf" are one instrument. Pinning both would spend half the
      // excerpt budget quoting the same clause to itself.
      const instrumentKey = (fp: string | null) =>
        (fp ?? '').toLowerCase().replace(/.*[\\/]/, '').replace(/ocr/g, '').replace(/[^a-z0-9]/g, '')

      const ownerDocs = await Promise.all(implicated.map(async (row) => {
        const toks = coreTokens(row.owner_tenant)
        ownerCores.push({ owner: row.owner_tenant, toks })
        if (toks.join('').length < 4) return { row, docs: [] as DocMeta[] }
        const pat = '%' + toks.join('%') + '%'
        let dq = sb.from('documents')
          .select('id, doc_type, title, file_name, file_path, property_id')
          .or(`file_path.ilike.${pat},title.ilike.${pat}`)
          .limit(60)
        if (exclScope.length) dq = dq.in('property_id', exclScope)
        const { data } = await dq
        const docs = ((data ?? []) as DocMeta[])
          .map(d => ({ d, s: leaseScore(d) })).filter(x => x.s > 0)
          .sort((a, b) => b.s - a.s).slice(0, 3).map(x => x.d)
        return { row, docs }
      }))

      // Per owner, fetch only the chunks that could carry the clause (term match, plus
      // chunk 0 as the OCR fallback) — a lease runs 300+ chunks and pulling them whole
      // would blow the response budget for no gain.
      await Promise.all(ownerDocs.map(async ({ row, docs }) => {
        if (!docs.length) return
        const terms = exclusiveTerms(row)
        if (!terms.length) return
        const orFilter = [...terms.slice(0, 4).map(t => `content.ilike.%${t}%`), 'chunk_index.eq.0'].join(',')
        const { data: oc } = await sb.from('document_chunks')
          .select('document_id, chunk_index, content')
          .in('document_id', docs.map(d => d.id))
          .or(orFilter)
          .limit(120)
        const byDoc = new Map<string, Array<{ chunk_index: number; content: string }>>()
        for (const c of (oc ?? []) as Array<{ document_id: string; chunk_index: number; content: string }>) {
          if (!byDoc.has(c.document_id)) byDoc.set(c.document_id, [])
          byDoc.get(c.document_id)!.push({ chunk_index: c.chunk_index, content: c.content })
        }
        const seenInstrument = new Set<string>()
        for (const d of docs) {
          const ik = instrumentKey(d.file_path)
          if (ik && seenInstrument.has(ik)) continue
          const chunks = byDoc.get(d.id) ?? []
          if (!chunks.length) continue
          seenInstrument.add(ik)
          const scored = chunks.map(c => {
            const lc = (c.content ?? '').toLowerCase()
            let s = 0
            for (const t of terms) if (lc.includes(t)) s += 2
            s += conceptHits(c.content)
            // Term hits alone tie the operative covenant with the Article 1 "Permitted
            // Use" box and the AI summary — all three name the protected goods. Only
            // the covenant carries the carve-outs, which is the whole point of citing
            // the primary lease, so score the drafting itself. Patterns are chosen to
            // survive OCR damage ("Landlord wil not hereafter enter...").
            if (/hereafter enter into|shall not (?:lease|sell|permit|enter)|covenants and agrees/i.test(lc)) s += 3
            if (/shall not apply to|does not apply to|shall not include|except for/i.test(lc)) s += 3
            if (/exclusiv/i.test(lc)) s += 2
            return { c, s }
          }).sort((a, b) => b.s - a.s || a.c.chunk_index - b.c.chunk_index)
          // Text layers are incomplete on roughly a third of the scanned leases;
          // when the clause itself did not OCR, chunk 0 (the AI summary) still
          // states the exclusive, so fall back to it rather than dropping the doc.
          const take = scored[0].s > 0 ? scored.slice(0, 2)
                     : chunks.filter(c => c.chunk_index === 0).map(c => ({ c, s: 0 })).slice(0, 1)
          if (!take.length) continue
          primaryDocIds.add(d.id)
          primaryOwnerByDoc.set(d.id, row.owner_tenant)
          for (const { c } of take) {
            exclChunks.push({ document_id: d.id, chunk_index: c.chunk_index, content: c.content, similarity: 0.998 })
          }
        }
      }))
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
    // Exclusives first: these are the owning tenants' own leases, and they must not
    // be crowded out by the near-duplicate site plans that dominate this corpus.
    for (const c of exclChunks.slice(0, 8)) pushChunk(c, 3)
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
      // The cross-encoder judges "…is prohibited" (a restatement) a better answer to
      // a use question than "Landlord will not hereafter enter into a new lease…"
      // (the actual covenant), and its top_k would drop the covenant entirely. So
      // the owning tenant's own lease chunks are re-seated at the front rather than
      // left to compete on phrasing.
      if (primaryDocIds.size) {
        const primaries = candidates.filter(c => primaryDocIds.has(c.document_id))
        const rest = ranked.filter(c => !primaryDocIds.has(c.document_id))
        ranked = [...primaries, ...rest]
      }
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
      // Registry-selected leases are exempt. The holder is fixed by curated data, and
      // folder-name-vs-rent-roll matching will never be perfect — a false 'former'
      // reading here would silently drop the one clause the question turns on.
      const tenancyScoped = hits.filter(h =>
        primaryDocIds.has(h.document_id) || tenancyAllows((byId.get(h.document_id) as any)?.file_path ?? null))
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
        const isExcl = h.similarity === 0.998
        const isPinned = isExcl || h.similarity === 0.999
        const { link, path } = linkFor(d?.file_path ?? null, d?.storage_path ?? null)
        return {
          n: i + 1,
          match: isExcl ? 'exclusive-registry' : isPinned ? 'targeted' : 'semantic',
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
    // A chunk from someone ELSE's lease that recites an implicated owner's exclusive
    // is secondary evidence. Match on the owner's leading name tokens only — these
    // schedules carry OCR damage ("french flies") that defeats whole-phrase matching.
    const restatementOf = (c: Chunk): string | null => {
      if (primaryDocIds.has(c.document_id)) return null
      const lc = (c.content ?? '').toLowerCase()
      if (!lc.includes('exclusiv')) return null
      for (const { owner, toks } of ownerCores) {
        if (toks.length && toks.slice(0, 2).every(t => lc.includes(t))) return owner
      }
      return null
    }

    const excerpts = hits.map(h => {
      const d = byId.get(h.document_id) as any
      const n = srcNum.get(h.document_id) ?? '?'
      const t = docTenancy(d?.file_path ?? null)
      const owner = primaryOwnerByDoc.get(h.document_id)
      const restated = owner ? null : restatementOf(h)
      const tag = owner
        ? ` [PRIMARY SOURCE — ${owner}'s own lease; controlling text for its exclusive]`
        : restated
          ? ` [RESTATEMENT of ${restated}'s exclusive, inside another tenant's lease — SECONDARY and frequently abridged]`
          : ''
      const head = `[${n}] "${d?.title ?? 'Untitled'}"${d?.properties?.name ? ` (${d.properties.name})` : ''}${t === 'former' ? ' [FORMER TENANT — not on current rent roll]' : ''}${tag}`
      return `${head}\n${(h.content ?? '').slice(0, 6000)}`
    }).join('\n\n---\n\n')

    // Curated ownership ground truth. Included so the model cannot misattribute an
    // exclusive even when the only retrieved text is someone else's schedule — but
    // the description is a 500-char truncation, so it must never be quoted as the clause.
    const exclusivesNote = implicated.length
      ? `\n\nEXCLUSIVES REGISTRY — curated ground truth for WHO HOLDS each exclusive at this property. Authoritative on ownership and on which lease is controlling. The text here is a TRUNCATED summary, not the clause: quote the lease excerpts, never this block.\n` +
        implicated.map(r => {
          const cat = r.category && r.category !== 'auto-seeded' ? ` (${r.category})` : ''
          return `- HOLDER: ${r.owner_tenant}${cat} — ${(r.description ?? '').slice(0, 300).replace(/\s+/g, ' ')}… [documented at: ${r.source_citation ?? 'n/a'}]`
        }).join('\n')
      : ''

    const exclusivesRules = implicated.length
      ? `
- EXCLUSIVES — attribute every exclusive to the tenant that HOLDS it per the registry, and cite that holder's OWN lease as the source.
- An "Existing Exclusives" / "Prohibited Uses" schedule inside a DIFFERENT tenant's lease is a secondary restatement (tagged RESTATEMENT above). Never present it as the controlling text. If it is your only excerpt for a clause, say so explicitly and warn that its carve-outs may be incomplete.
- Whenever you state that a use is restricted, enumerate the carve-outs and exceptions from the controlling clause — existing tenants and their successors, renewals of existing leases, floor-area thresholds, outparcels. These frequently decide whether a deal can proceed, and abridged restatements routinely omit them.
- The registry block lists only the restrictions screened as potentially relevant to this use. Do not assert that no other exclusive applies.`
      : ''

    // ── LEASE REGISTER — structured term data, authoritative over documents ──────
    // `leases` is MRI-reconciled and updated as amendments are executed. An estoppel,
    // notice letter or monthly report states the term AS OF ITS OWN DATE. With no
    // tenant named, retrieval returns ZERO lease documents, so term answers were being
    // assembled from those snapshots: Ross read 1/31/2027 "with two remaining options"
    // when the option was exercised and the term runs to 1/31/2032; Krispy Kreme read
    // 2026-04-30 against a true 2036-04-30. Both were already correct in this table.
    type LeaseRow = {
      expiration_date: string | null; commencement_date: string | null
      rent_commencement_date: string | null
      leased_sf: number | null; is_rea_member: boolean | null
      tenants: { name: string } | null
      units: { unit_number: string } | null
      lease_options: Array<{ is_exercised: boolean | null; option_type: string | null; notice_deadline: string | null }> | null
      lease_rent_schedule: Array<{ effective_date: string | null; annual_rent: number | null; rent_per_sf: number | null }> | null
    }
    const allLeases = ((leaseRegRes.data ?? []) as unknown as LeaseRow[])
    const regTenantNorm = intent.tenant ? normName(intent.tenant) : null
    const matchesAsked = (n: string) => {
      if (!regTenantNorm) return true
      const a = normName(n)
      return !!a && (a.includes(regTenantNorm) || regTenantNorm.includes(a))
    }
    // REA members are 0-sf reciprocal-easement placeholders on an artificial horizon
    // date (2065 at KM East, 2073 at KM West). Listing them as expirations is wrong.
    const reaLeases  = allLeases.filter(l => l.is_rea_member === true)
    const realLeases = allLeases.filter(l => l.is_rea_member !== true && matchesAsked(l.tenants?.name ?? ''))
      .sort((a, b) => (a.expiration_date ?? '9999-99-99').localeCompare(b.expiration_date ?? '9999-99-99'))

    const today = new Date().toISOString().slice(0, 10)

    // Current contractual rent = the latest schedule step already in effect. Most leases
    // here carry only ONE step (29 of 32 at KM East, avg 1.6 rows), so an effective date
    // of 2006 usually means flat rent rather than a stale row — Arby's, GNC and Island
    // Nails all reconcile to the MRI rent roll to the penny. The effective date is
    // always stated so a genuinely stale row is visible rather than implied.
    const usd = (n: number) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })
    const rentOf = (l: LeaseRow): string => {
      const steps = (l.lease_rent_schedule ?? []).filter(s => s.effective_date)
      const inEffect = steps.filter(s => (s.effective_date as string) <= today)
        .sort((a, b) => (b.effective_date as string).localeCompare(a.effective_date as string))[0]
      if (inEffect && inEffect.annual_rent != null) {
        const psf = inEffect.rent_per_sf ?? (l.leased_sf ? Number(inEffect.annual_rent) / Number(l.leased_sf) : null)
        const next = steps.filter(s => (s.effective_date as string) > today)
          .sort((a, b) => (a.effective_date as string).localeCompare(b.effective_date as string))[0]
        return `rent ${usd(inEffect.annual_rent)}/yr`
          + (psf ? ` ($${Number(psf).toFixed(2)}/sf)` : '')
          + ` as of ${inEffect.effective_date}`
          + (next ? `; next step ${usd(next.annual_rent ?? 0)} on ${next.effective_date}` : '')
      }
      // No step in effect. Distinguish a lease that is EXECUTED but not yet paying from
      // one that IS paying but whose rent has not been loaded here — the two look
      // identical in the table and mean opposite things.
      const rcd = l.rent_commencement_date
      if (!rcd) return 'rent NOT YET COMMENCED — lease/amendment EXECUTED, rent commencement date still TBD'
      if (rcd > today) return `rent NOT YET COMMENCED — lease EXECUTED, RCD ${rcd} (future)`
      // NOT "no rent exists". Cold Stone at KM East reads $4,433.33/mo ($38.00/sf) on the
      // July 2026 MRI rent roll while the platform's newest LOADED snapshot is 2025-09,
      // which predates its 4/1/2026 rent start. The rent is real; this copy is behind.
      return `RENT RUNNING BUT NOT LOADED HERE — RCD ${rcd} has PASSED, so this tenant IS paying. The figure is absent from the platform's schedule, most likely because the loaded rent roll predates the rent start. Do NOT report $0 or "no rent" — say the amount is not loaded and point at the current MRI rent roll`
    }

    const fmtLease = (l: LeaseRow): string => {
      const opts = l.lease_options ?? []
      const remaining = opts.filter(o => o.is_exercised !== true).length
      const nextNotice = opts.filter(o => o.is_exercised !== true && o.notice_deadline)
        .map(o => o.notice_deadline as string).sort()[0] ?? null
      return '- ' + [
        l.tenants?.name ?? 'Unknown tenant',
        l.units?.unit_number ? `Unit ${l.units.unit_number}` : null,
        l.leased_sf ? `${Number(l.leased_sf).toLocaleString('en-US')} sf` : null,
        l.commencement_date ? `commenced ${l.commencement_date}` : null,
        `EXPIRES ${l.expiration_date ?? 'not set'}`,
        opts.length
          ? `${remaining} of ${opts.length} option(s) unexercised${nextNotice ? `, next notice due ${nextNotice}` : ''}`
          : 'no options of record',
        intent.rent_question ? rentOf(l) : null,
      ].filter(Boolean).join(' | ')
    }

    const REG_CAP = 80
    const shown = realLeases.slice(0, REG_CAP)
    const leaseRegisterNote = shown.length
      ? `\n\nLEASE REGISTER — structured lease data, reconciled against MRI and maintained as amendments are executed. AUTHORITATIVE for term dates; prefer it over any date read out of a document. Today's date is ${today}. ${shown.length} active lease(s)${realLeases.length > REG_CAP ? ` shown of ${realLeases.length} (truncated — say so if the user needs the full list)` : ''}, earliest expiration first:\n` +
        shown.map(fmtLease).join('\n') +
        (reaLeases.length
          ? `\nEXCLUDED — ${reaLeases.length} REA-member row(s) (${reaLeases.map(r => r.tenants?.name ?? '?').join(', ')}): 0-sf reciprocal-easement placeholders carrying an artificial horizon date, NOT real lease expirations. Do not list them as upcoming expirations.`
          : '')
        // Rent figures above are CONTRACTUAL. State how current the independent MRI
        // cross-check is, because a loaded snapshot can lag the executed schedule by
        // months and the answer should not imply otherwise.
        + (intent.rent_question ? (() => {
            const snaps = ((rrPeriodRes.data ?? []) as Array<{ property_id: string; period_year: number; period_month: number; properties?: { name: string } | null }>)
            const latest = new Map<string, { label: string; ym: number }>()
            for (const s of snaps) {
              const ym = s.period_year * 100 + s.period_month
              const prev = latest.get(s.property_id)
              if (!prev || ym > prev.ym) {
                latest.set(s.property_id, { label: `${s.properties?.name ?? s.property_id} = ${s.period_year}-${String(s.period_month).padStart(2, '0')}`, ym })
              }
            }
            const lines = [...latest.values()].map(v => v.label)
            return lines.length
              ? `\nRENT PROVENANCE — rent above is CONTRACTUAL, from the lease rent schedule. The most recent MRI rent-roll snapshot LOADED into the platform is: ${lines.join('; ')}. If that period is well behind today, say so when quoting rent, because the independent cross-check is that old — do not describe the snapshot as current.`
              : '\nRENT PROVENANCE — rent above is CONTRACTUAL, from the lease rent schedule. NO MRI rent-roll snapshot is loaded for this property, so there is no independent cross-check; say so when quoting rent.'
          })() : '')
      : ''

    const termRules = shown.length
      ? `
- TERM DATES — use the LEASE REGISTER below for expirations, commencements and option counts. It is the system of record. Estoppel certificates, notice letters, rent rolls and monthly operational reports state the term AS OF THEIR OWN DATE and are routinely superseded by a later amendment; never prefer such a document over the register, and do not repeat an expiration from one without checking it against the register.
- The register is maintained but not infallible. If an excerpt shows an EXECUTED instrument dated later than the register appears to reflect, do not silently pick one — give the register value, then flag the conflict and name the document so it can be reconciled.
- When asked what expires soonest, measure against today's date given in the register block, and do not present an already-passed expiration as upcoming.
- Answer the question actually asked: only enumerate the whole register when the user asked for a full list. For a narrower question give the relevant rows. If you do list everything and cannot finish, say which rows you omitted rather than stopping mid-table.`
      : ''

    const rentRules = (shown.length && intent.rent_question)
      ? `
- RENT — use the LEASE REGISTER for base rent and rent per square foot. Documents in this corpus carry BUDGET rent (a plan, not actuals) and rent rolls that are years old; a budget total is not the answer to "what is the rent". If you cite a document figure at all, label it as budget or as an as-of-date snapshot and give the register figure as the answer.
- Each rent figure carries an "as of" effective date. Quote it. Most leases here hold a single flat step, so an old effective date usually means rent has not escalated — do not describe it as stale unless something contradicts it.
- Distinguish the two zero-rent cases exactly as the register labels them, and never report either as $0, vacant, or "no rent". "NOT YET COMMENCED" means the lease or amendment IS EXECUTED and rent simply has not started (RCD future or still TBD). "RENT RUNNING BUT NOT LOADED HERE" means the tenant IS paying and only this platform's copy is missing the figure — say the amount is not loaded and refer the user to the current MRI rent roll; do not describe it as an absent or unknown rent.
- Do not total or average rent across leases without saying how many of them you actually had figures for, and name the ones you excluded.`
      : ''

    const tenancyNote = intent.tenancy === 'past'
      ? '\n- The user asked about PAST/terminated tenancies; excerpts are scoped accordingly.'
      : '\n- Scope is CURRENT tenants (per the latest rent roll). If an excerpt is tagged [FORMER TENANT], state plainly that the tenant is no longer current before describing its terms; never present former-tenant terms as active obligations.'

    const docListNote = documents.length
      ? `\n\nA "Matched documents" list of ${documents.length} document(s) is shown to the user alongside your answer — if the user asked to pull up documents, briefly confirm what was found (count, kinds, date order) and refer them to that list; do not enumerate every file yourself.`
      : ''

    const prompt = `You are the document-intelligence assistant for M&J Wilkow's commercial real estate asset-management platform. Answer the user's question using ONLY the material below — the document excerpts plus any structured register blocks. Rules:
- Cite excerpts inline as [1], [2], … after each claim they support.
- Quote exact figures ($, %, dates, section numbers) when present.
- Multiple excerpts may share a citation number when they come from the same document — that is expected.
- If the excerpts do not contain the answer, say so plainly — do not guess.
- Note when later amendments supersede earlier terms (use effective dates).
- Be concise: a short direct answer first, then supporting detail.${tenancyNote}${termRules}${rentRules}${exclusivesRules}${docListNote}

QUESTION: ${q}${leaseRegisterNote}${exclusivesNote}

EXCERPTS:
${excerpts}`

    // "List every expiration at this property" legitimately enumerates the whole
    // register, and 32 rows of table overran the 1500-token cap mid-row (the answer
    // stopped at "Kay Jewelers | C2 | 2031-12-", losing everything past 2031). Scale
    // the budget with the register, since that is the only block that can be long.
    const answerMax = shown.length > 12 ? 3000 : 1500
    let answer = await anthropic(anthropicKey, ANSWER_MODEL, prompt, answerMax)

    // "What is the current base rent for each tenant at KM East?" returned success:true
    // with a ZERO-LENGTH answer, reproducibly (2/2), while still returning 11 sources —
    // so the UI showed sources under a blank answer. Retry once with more headroom, and
    // if it is still empty say so rather than handing back silence that reads as "no
    // answer exists". Root cause not yet identified; this stops it being invisible.
    if (!answer.trim()) {
      answer = await anthropic(anthropicKey, ANSWER_MODEL, prompt, Math.max(answerMax, 3000))
      if (!answer.trim()) {
        console.error('doc-ask: empty answer', JSON.stringify({ q, promptChars: prompt.length, excerpts: hits.length, register: shown.length }))
        answer = 'The answer could not be generated for this question (the model returned an empty response twice). '
          + `The ${hits.length} source excerpt(s) below were retrieved and are listed alongside this message — try narrowing the question, or asking about fewer tenants at a time.`
      }
    }

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
