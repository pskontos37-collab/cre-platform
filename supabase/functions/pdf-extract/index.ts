// pdf-extract — fetch a PDF from Supabase Storage and extract a structured
// abstraction with the Claude API (native PDF input). Runs server-side, so it sidesteps
// the local toolchain gap (no poppler/python/node). Designed for the CRE legal-document
// corpus: leases, amendments, estoppels, REAs/OEAs, guaranties, notices.
//
// The Google Drive ingestion path was retired 2026-07-01 (corpus now loads from the
// VPN file shares via scripts/ingest_local_docs.ps1); the Drive branch and its
// GOOGLE_SERVICE_ACCOUNT dependency were removed here.
//
// Required Supabase secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.
//
// Usage (authenticated caller only):
//   POST ?storagePath=<bucket/path.pdf>            -> { extraction: {...} }   (read-only)
//   POST ?storagePath=<bucket/path.pdf>&store=1    -> also upserts a `documents` row + chunks

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { PDFDocument } from 'https://esm.sh/pdf-lib@1.17.1'
import { extractText, getDocumentProxy } from 'https://esm.sh/unpdf@0.12.1'
import { AuthError, canWriteProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

// MuPDF is imported LAZILY. A top-level `npm:mupdf` import evaluates the WASM
// module at boot, which fails on the current Supabase edge runtime (BOOT_ERROR).
// Only the large-file ingest split path needs it, so we defer the import to first
// use — verbatim-text reindex uses unpdf (pure esm.sh, edge-native) instead.
// deno-lint-ignore no-explicit-any
let _mupdf: any = null
async function loadMupdf(): Promise<any> {
  if (!_mupdf) _mupdf = await import('npm:mupdf@1.27.0')
  return _mupdf
}

// Model precedence: ?model= (per request) > PDF_EXTRACT_MODEL (this function's secret)
//   > ANTHROPIC_MODEL (project-wide default) > hardcoded default.
// Distinct PDF_EXTRACT_MODEL lets each Claude-using function pick its own model, since
// Supabase secrets are project-wide (shared by all functions).
const DEFAULT_MODEL = Deno.env.get('PDF_EXTRACT_MODEL') ?? Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-opus-4-8'
const STORAGE_MAX_PDF_BYTES = Number(Deno.env.get('PDF_STORAGE_MAX_BYTES') ?? 60 * 1024 * 1024)  // storage route splits by page, tolerates larger

// Oversized-PDF handling. The Claude API rejects a single document block over either limit:
//   - 100 PDF pages, or
//   - 200k input tokens (dense scans hit this under 100 pages).
// Above PAGE_LIMIT we split proactively; under it we try whole and split on a token-limit error.
// SEG_PAGES kept conservative so a dense segment (~2k tok/page) stays well under 200k tokens.
const PAGE_LIMIT = Number(Deno.env.get('PDF_PAGE_LIMIT') ?? 95)
const SEG_PAGES  = Number(Deno.env.get('PDF_SEGMENT_PAGES') ?? 40)
// Large files are often image-heavy scans; use smaller segments so each segment's
// rendered token cost and request size stay comfortably under the API limits.
const LARGE_SEG_PAGES = Number(Deno.env.get('PDF_LARGE_SEGMENT_PAGES') ?? 20)
// pdf-lib explodes a large PDF into a heavy JS object model and OOMs the edge worker
// (uncatchable — it kills the process). Above this byte size, use MuPDF (C/WASM, low memory).
const LARGE_BYTES = Number(Deno.env.get('PDF_LARGE_BYTES') ?? 12 * 1024 * 1024)

// Embeddings (recall layer). voyage-3-large = 1024 dims, written to
// document_chunks.embedding_voyage (matches doc-ask / doc-search query side).
const VOYAGE_MODEL = Deno.env.get('VOYAGE_MODEL') ?? 'voyage-3-large'

async function embed(text: string, key: string): Promise<number[]> {
  const r = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text.slice(0, 32000), model: VOYAGE_MODEL, input_type: 'document', output_dimension: 1024 }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Voyage API error: ' + JSON.stringify(d))
  return d.data[0].embedding
}

// Batched embeddings for the verbatim-text reindex path — a long lease produces
// dozens of chunks, and one Voyage call per chunk would blow the edge worker's
// ~150s wall-clock. Voyage accepts up to 128 inputs/request; we map results back
// by their returned index so chunk order is never assumed.
async function embedBatch(texts: string[], key: string): Promise<number[][]> {
  const out: number[][] = new Array(texts.length)
  const B = 96
  for (let i = 0; i < texts.length; i += B) {
    const batch = texts.slice(i, i + B).map(t => t.slice(0, 32000))
    const r = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: batch, model: VOYAGE_MODEL, input_type: 'document', output_dimension: 1024 }),
    })
    const d = await r.json()
    if (!r.ok) throw new Error('Voyage API error: ' + JSON.stringify(d))
    for (const item of (d.data ?? []) as Array<{ index: number; embedding: number[] }>) {
      out[i + item.index] = item.embedding
    }
  }
  return out
}

// ── Verbatim-text chunking (RAG recall layer) ──
// Window the concatenated page text into overlapping ~TEXT_CHUNK_CHARS passages,
// preferring a clean break (paragraph > line > sentence) in the tail of each
// window so a clause is rarely severed mid-sentence. Each chunk is attributed to
// the page its start falls on, for the PDF-viewer jump.
const TEXT_CHUNK_CHARS   = Number(Deno.env.get('TEXT_CHUNK_CHARS')   ?? 1400)
const TEXT_CHUNK_OVERLAP = Number(Deno.env.get('TEXT_CHUNK_OVERLAP') ?? 200)
// OCR gate. A dense legal page runs 1,500-3,500 chars; a scanned page with only
// a thin embedded text layer (stamps, headers, a few OCR-at-scan-time glyphs)
// yields tens to a few hundred. The old 80 floor let genuinely-scanned
// instruments slip through: e.g. an 8-page Fourth Amendment gave 1,789 chars
// (~224/page) — above 80, so OCR was skipped, the brief was built from near-empty
// text, and the abstractor never folded the amendment in. 300 comfortably
// separates real text from a thin scan layer while staying well under a dense
// page; still env-overridable.
const MIN_CHARS_PER_PAGE = Number(Deno.env.get('MIN_CHARS_PER_PAGE') ?? 300)   // substantive-page avg below → scanned/needs OCR
const OCR_EMPTY_PAGE_CHARS    = Number(Deno.env.get('OCR_EMPTY_PAGE_CHARS')    ?? 100)  // a page under this is "near-empty" (excluded from the substantive average)
// unpdf loads the whole PDF into worker memory; very large docs OOM the isolate
// (WORKER_RESOURCE_LIMIT, uncatchable). Preempt by page count and flag for a
// dedicated large-doc pass.
const MAX_REINDEX_PAGES  = Number(Deno.env.get('MAX_REINDEX_PAGES')  ?? 300)
// OCR pass (?ocrText=1) — scanned/image-only docs unpdf can't read. Claude
// transcribes verbatim via native PDF vision. Haiku is plenty for transcription
// (retrieval quality, not reasoning) and keeps the ~3,100-doc pass cheap.
const OCR_MODEL     = Deno.env.get('OCR_MODEL')     ?? 'claude-haiku-4-5-20251001'
const OCR_MAX_PAGES = Number(Deno.env.get('OCR_MAX_PAGES') ?? 100)   // Claude PDF page cap; larger → deferred
const OCR_MAX_TOKENS = Number(Deno.env.get('OCR_MAX_TOKENS') ?? 8000)
// OpenAI OCR (?ocrProvider=openai) — a second provider so OCR stays available
// when the Anthropic API is overloaded. Uses OpenAI's Responses API with the PDF
// as a native file input (input_file), so OpenAI rasterizes server-side. This
// avoids rendering pages to bitmaps inside the memory-constrained edge worker,
// which OOMed (WORKER_RESOURCE_LIMIT) on larger scans.
const OCR_PROVIDER_DEFAULT = (Deno.env.get('OCR_PROVIDER') ?? 'claude').toLowerCase()
const OCR_OPENAI_MODEL = Deno.env.get('OCR_OPENAI_MODEL') ?? 'gpt-4o'

// Postgres text columns cannot store NUL; pdfjs emits NUL/C0 controls for some
// glyphs. Strip them (keep tab/newline/CR) so inserts don't fail wholesale.
const stripCtl = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

function chunkPages(pages: { page: number; text: string }[]): { content: string; page: number }[] {
  const marks: { at: number; page: number }[] = []
  let buf = ''
  for (const p of pages) {
    const t = stripCtl(p.text ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!t) continue
    marks.push({ at: buf.length, page: p.page })
    buf += (buf ? '\n\n' : '') + t
  }
  const pageAt = (idx: number) => {
    let pg = marks.length ? marks[0].page : 1
    for (const m of marks) { if (m.at <= idx) pg = m.page; else break }
    return pg
  }
  const out: { content: string; page: number }[] = []
  if (!buf) return out
  const softStart = Math.floor(TEXT_CHUNK_CHARS * 0.7)
  let start = 0
  while (start < buf.length) {
    let end = Math.min(start + TEXT_CHUNK_CHARS, buf.length)
    if (end < buf.length) {
      const win = buf.slice(start + softStart, end)
      const rel = Math.max(win.lastIndexOf('\n\n'), win.lastIndexOf('\n'), win.lastIndexOf('. '))
      if (rel > 0) end = start + softStart + rel + 1
    }
    const content = buf.slice(start, end).trim()
    if (content.length >= 40) out.push({ content, page: pageAt(start) })
    if (end >= buf.length) break
    start = Math.max(0, end - TEXT_CHUNK_OVERLAP)
  }
  return out
}

// Map the abstraction's fine doc_type to the DB `doc_type` enum
// (lease|operating_statement|rent_roll|budget|loan_agreement|jv_agreement|psa|title|
//  estoppel|inspection|tax|other). The precise type is preserved in documents.notes.
const DOC_TYPE_ENUM = new Set([
  'lease', 'operating_statement', 'rent_roll', 'budget', 'loan_agreement', 'jv_agreement',
  'psa', 'title', 'estoppel', 'inspection', 'tax', 'other',
])
function toDocTypeEnum(t: unknown): string {
  const s = String(t ?? 'other')
  if (DOC_TYPE_ENUM.has(s)) return s
  if (s === 'amendment') return 'lease'        // lease-family
  return 'other'                                // easement/guaranty/correspondence/memorandum
}

// Build a single rich searchable blob from the abstraction (doc-level chunk for v1).
function searchableText(x: Record<string, unknown>): string {
  const arr = (v: unknown) => Array.isArray(v) ? v : []
  return [
    x.summary, x.doc_type, x.sub_type, x.property, x.tenant,
    arr(x.counterparties).join(', '),
    x.base_rent_summary, x.percentage_rent, x.recovery_method, x.co_tenancy, x.exclusive_use,
    arr(x.options).join('; '),
    arr(x.key_dates).map((d) => `${(d as { label?: string }).label}: ${(d as { date?: string }).date}`).join('; '),
  ].filter(Boolean).join('\n')
}

// base64-encode in chunks (avoids call-stack overflow on large buffers)
function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

// ── Abstraction schema (structured output) ──
// Optional fields are nullable but listed in `required` (structured-output rule).
const nullableStr = { type: ['string', 'null'] }
const ABSTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_type:        { type: 'string', enum: ['lease', 'amendment', 'estoppel', 'easement_operating_agreement', 'guaranty', 'correspondence', 'memorandum', 'other'] },
    sub_type:        nullableStr,
    confidence:      { type: 'string', enum: ['high', 'medium', 'low'] },
    property:        nullableStr,                                  // shopping center / property named in the doc
    tenant:          nullableStr,
    counterparties:  { type: 'array', items: { type: 'string' } }, // all named parties
    effective_date:  nullableStr,                                  // ISO yyyy-mm-dd if determinable
    expiration_date: nullableStr,
    premises_suite:  nullableStr,
    sqft:            { type: ['number', 'null'] },
    base_rent_summary:  nullableStr,
    percentage_rent:    nullableStr,
    recovery_method:    nullableStr,                               // NNN / CAM / base-year / etc.
    options:         { type: 'array', items: { type: 'string' } }, // renewal/extension/termination etc.
    co_tenancy:      nullableStr,
    exclusive_use:   nullableStr,
    recording_info:  nullableStr,                                  // book/page/date if recorded
    amends:          nullableStr,                                  // if it amends a prior agreement: what it changes; null if base/none
    amendment_seq:   nullableStr,                                  // 'First Amendment' / 'Rider' / 'Side Letter' / 'Assignment' / null
    key_dates:       { type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: { label: { type: 'string' }, date: { type: 'string' } }, required: ['label', 'date'],
    } },
    summary:         { type: 'string' },                           // 2-4 sentence plain-language summary
  },
  required: [
    'doc_type', 'sub_type', 'confidence', 'property', 'tenant', 'counterparties',
    'effective_date', 'expiration_date', 'premises_suite', 'sqft', 'base_rent_summary',
    'percentage_rent', 'recovery_method', 'options', 'co_tenancy', 'exclusive_use',
    'recording_info', 'amends', 'amendment_seq', 'key_dates', 'summary',
  ],
}

const PROMPT = `You are abstracting a commercial real estate legal document for an asset-management
platform. Read the attached PDF and extract the fields defined by the output schema.

Rules:
- Classify doc_type from the CONTENT, not any filename. A letter that references an REA is
  "correspondence", not "easement_operating_agreement".
- Use null for any field the document does not establish. Do not guess.
- amends: if this document amends/supersedes/modifies a prior lease or agreement, briefly state WHAT it
  changes (sections/terms); null if it is an original/base agreement or amends nothing.
- amendment_seq: the sequence label if applicable ('First Amendment','Second Amendment','Rider','Side
  Letter','Assignment','Assignment & Assumption'); null otherwise.
- Dates as yyyy-mm-dd when a full date is present; otherwise null.
- counterparties: every named legal entity that is a party.
- summary: 2-4 sentences a property manager could read at a glance.`

// One Claude extraction call for a (possibly partial) PDF. Throws on API error so the
// caller can detect "prompt is too long" and fall back to splitting.
async function callClaude(b64: string, model: string, apiKey: string): Promise<{ extraction: Record<string, unknown>; usage: unknown }> {
  const aRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      output_config: { format: { type: 'json_schema', schema: ABSTRACTION_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
          { type: 'text', text: PROMPT },
        ],
      }],
    }),
  })
  const aData = await aRes.json()
  if (!aRes.ok) throw new Error('Anthropic API error: ' + JSON.stringify(aData))
  if (aData.stop_reason === 'refusal') throw new Error('REFUSAL')
  const textBlock = (aData.content ?? []).find((b: { type: string }) => b.type === 'text')
  return { extraction: JSON.parse(textBlock?.text ?? '{}'), usage: aData.usage }
}

// Merge per-segment extractions into one document-level abstraction.
// Scalars: first non-null wins. Arrays: union (deduped). doc_type/sub_type: from the
// highest-confidence segment. summary: per-segment summaries tagged with their page range.
function mergeExtractions(
  exs: Record<string, unknown>[],
  segMeta: { start: number; end: number }[],
): Record<string, unknown> {
  if (exs.length === 1) return exs[0]
  const rank = (c: unknown) => ({ high: 3, medium: 2, low: 1 } as Record<string, number>)[String(c)] ?? 0
  const primary = exs.reduce((best, e) => (rank(e.confidence) > rank(best.confidence) ? e : best), exs[0])
  const uniq = (a: unknown[]) => Array.from(new Set(a.map((v) => JSON.stringify(v)))).map((s) => JSON.parse(s))
  const firstNonNull = (f: string) => exs.map((e) => e[f]).find((v) => v !== null && v !== undefined) ?? null

  const merged: Record<string, unknown> = { ...primary }
  for (const f of [
    'sub_type', 'property', 'tenant', 'effective_date', 'expiration_date', 'premises_suite',
    'sqft', 'base_rent_summary', 'percentage_rent', 'recovery_method', 'co_tenancy',
    'exclusive_use', 'recording_info',
  ]) merged[f] = firstNonNull(f)
  merged.counterparties = uniq(exs.flatMap((e) => (Array.isArray(e.counterparties) ? e.counterparties : [])))
  merged.options        = uniq(exs.flatMap((e) => (Array.isArray(e.options) ? e.options : [])))
  merged.key_dates      = uniq(exs.flatMap((e) => (Array.isArray(e.key_dates) ? e.key_dates : [])))
  merged.summary = exs
    .map((e, i) => (e.summary ? `[pp.${segMeta[i].start}-${segMeta[i].end}] ${e.summary}` : ''))
    .filter(Boolean).join(' ')
  return merged
}

// OpenAI OCR via the Responses API with a native PDF file input — OpenAI
// rasterizes server-side, so nothing is rendered in the edge worker (no MuPDF,
// no OOM). Emits the same "=== PAGE n ===" markers the Claude path does, so the
// downstream page-split / chunk / insert code is identical. Works while
// api.anthropic.com is returning overloaded_error (different provider).
async function ocrViaOpenAI(bytes: Uint8Array, apiKey: string, ocrPrompt: string): Promise<{ full: string; truncated: boolean }> {
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OCR_OPENAI_MODEL,
      max_output_tokens: OCR_MAX_TOKENS,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: ocrPrompt },
          { type: 'input_file', filename: 'document.pdf', file_data: `data:application/pdf;base64,${toBase64(bytes)}` },
        ],
      }],
    }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('OpenAI OCR error: ' + JSON.stringify(d))
  // Walk output[].content[]: gather output_text and flag a structured refusal.
  let full = ''
  let refused = false
  for (const item of (d.output ?? []) as Array<{ content?: Array<{ type?: string; text?: string }> }>) {
    for (const c of (item.content ?? [])) {
      if (c.type === 'output_text' && typeof c.text === 'string') full += c.text
      else if (c.type === 'refusal') refused = true
    }
  }
  if (!full && typeof d.output_text === 'string') full = d.output_text
  // Vision models sometimes decline to transcribe a page (safety). Never store
  // "I'm sorry, I can't..." as corpus text — treat it as empty so nothing writes.
  if (refused || (/^\s*(i'?m sorry|i can'?t|i cannot|i'?m unable|i'?m not able)\b/i.test(full) && full.length < 300)) {
    return { full: '', truncated: false }
  }
  const truncated = d.status === 'incomplete' || d.incomplete_details?.reason === 'max_output_tokens'
  return { full, truncated }
}

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    // Runs with the service role (RLS bypass) + can write documents; authorize the caller.
    const caller = await requireUser(req, sb)

    const url     = new URL(req.url)
    const storageKey = url.searchParams.get('storagePath')          // "bucket/path/to.pdf" (local-file ingestion)
    const propertyId = url.searchParams.get('propertyId')           // tag the documents row
    const filePathOverride = url.searchParams.get('filePath')       // documents.file_path (e.g. "file:\\server\...")
    const store   = url.searchParams.get('store') === '1'
    const model   = url.searchParams.get('model') ?? DEFAULT_MODEL   // per-request override
    const reindexText = url.searchParams.get('reindexText') === '1'  // verbatim-text recall layer, no Claude call
    const reindexDocId = url.searchParams.get('documentId')          // existing documents row to attach text chunks to
    // skipEmbed: store text chunks WITHOUT the Voyage vector. HNSW maintenance on
    // the (now large) embedding_voyage index made embedded inserts take >100s/doc,
    // blowing the edge wall. The abstractor reads chunk CONTENT by document_id and
    // needs no vector; FTS/keyword search also works without it. Semantic recall
    // for these chunks is backfilled separately (scripts/backfill_text_embeddings).
    const skipEmbed = url.searchParams.get('skipEmbed') === '1'
    // Large-doc recovery params (all optional; absent => existing single-request behavior).
    // The store path processes an ENTIRE doc's segments in ONE request, so a 200+pp doc
    // blows Supabase's 150s idle timeout. These let a client (split_ingest.ps1) drive one
    // request per small page-batch, each finishing under the timeout, appending into ONE row.
    const pageStart   = Number(url.searchParams.get('pageStart') ?? 0)   // 1-based inclusive; 0 = from first page
    const pageEnd     = Number(url.searchParams.get('pageEnd')   ?? 0)   // inclusive; 0 = to last page
    const appendDocId = url.searchParams.get('appendDocId')              // append chunks + merge notes into this existing doc (no new row)
    const segPagesParam = Number(url.searchParams.get('segPages') ?? 0)  // override pages-per-segment (smaller => less time/memory/tokens per Claude call)
    const forceMu     = url.searchParams.get('engine') === 'mu'          // force the low-memory MuPDF engine (pdf-lib OOMs on image-heavy 8-12MB scans)
    if (!storageKey) throw new Error('?storagePath= is required (Google Drive ingestion was retired 2026-07-01)')

    // AUTHORIZATION. Service-token callers (ingest/batch scripts) have access:'all'
    // and pass every branch below; this gate constrains USER-JWT callers.
    //   reindex/OCR — mutate an EXISTING document's chunks (delete + replace). The
    //                 caller-supplied ?propertyId= is NOT trusted: resolve the
    //                 document's REAL property from the DB and authorize THAT, then
    //                 tag the new chunks with it. Closes the object-ownership hole
    //                 where a user could target another property's document.
    //   store       — new-ingestion write; authorize the target property.
    //   default     — extract-and-return an arbitrary storage object by raw path,
    //                 which bypasses property scoping. Ingestion/admin only.
    const isOcr = url.searchParams.get('ocrText') === '1'
    let ownerPropertyId: string | null = propertyId
    if (reindexText || isOcr) {
      if (!reindexDocId) throw new Error('?documentId= is required for reindex/OCR')
      const { data: ownerDoc, error: ownerErr } =
        await sb.from('documents').select('property_id, storage_path').eq('id', reindexDocId).maybeSingle()
      if (ownerErr) throw new Error('document lookup failed: ' + ownerErr.message)
      if (!ownerDoc) throw new AuthError('Document not found', 404)
      if (!canWriteProperty(caller, (ownerDoc.property_id as string | null) ?? null)) throw new AuthError('No write access to this document', 403)   // WRITE gate (audit S2): reindex/OCR deletes + rewrites chunks
      // PROVENANCE (review #5): the bytes to (re)index must be the document's OWN
      // stored object, never a caller-supplied path pointing at some other object.
      // Every legit caller (frontend + reindex_text.ps1/ocr_text.ps1) passes
      // storagePath = "documents/<storage_path>"; require the match so a scoped
      // writer can't index a foreign object's text into a document they own.
      const ownStorageKey = ownerDoc.storage_path ? `documents/${ownerDoc.storage_path}` : null
      if (!ownStorageKey) throw new Error('Document has no stored file to reindex/OCR')
      if (storageKey !== ownStorageKey) throw new AuthError('storagePath does not match the document', 403)
      ownerPropertyId = (ownerDoc.property_id as string | null)
    } else if (appendDocId) {
      // append mode — writes chunks + rewrites notes on an EXISTING doc; authorize THAT doc's real property (not caller-supplied propertyId).
      const { data: apDoc, error: apErr } = await sb.from('documents').select('property_id').eq('id', appendDocId).maybeSingle()
      if (apErr) throw new Error('append doc lookup failed: ' + apErr.message)
      if (!apDoc) throw new AuthError('appendDocId not found', 404)
      if (!canWriteProperty(caller, (apDoc.property_id as string | null) ?? null)) throw new AuthError('No write access to the append target', 403)
    } else if (store) {
      if (!canWriteProperty(caller, propertyId ?? null)) throw new AuthError('No write access to this property', 403)   // WRITE gate (audit S2): store mode inserts documents+chunks
    } else if (!caller.isPrivileged) {
      throw new AuthError('Not permitted to extract arbitrary storage objects by path', 403)
    }

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY secret not set')

    // 1. Download the PDF from Supabase Storage.
    const sourceId = `storage:${storageKey}`
    let bytes: Uint8Array
    {
      const slash = storageKey.indexOf('/')
      const bucket = storageKey.slice(0, slash), objPath = storageKey.slice(slash + 1)
      const { data, error } = await sb.storage.from(bucket).download(objPath)
      if (error || !data) throw new Error('Storage download failed: ' + (error?.message ?? 'no data'))
      bytes = new Uint8Array(await data.arrayBuffer())
    }
    // Storage route splits by page so it tolerates larger files (MuPDF, low-memory).
    const cap = STORAGE_MAX_PDF_BYTES
    if (bytes.length > cap) {
      return new Response(JSON.stringify({
        error: `PDF is ${(bytes.length / 1048576).toFixed(1)}MB — exceeds the ${cap / 1048576}MB cap.`,
      }), { status: 413, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // 1b. VERBATIM-TEXT REINDEX (?reindexText=1) — recall layer, no Claude call.
    //     Extract page text with MuPDF (in-worker, $0 tokens), window it into
    //     overlapping passages, embed with Voyage, and (re)write them as
    //     kind='text' chunks on an EXISTING documents row. The legacy kind='summary'
    //     chunk is left untouched, so retrieval gets both the doc-level paraphrase
    //     and the real language. Idempotent: prior kind='text' rows are replaced.
    if (reindexText) {
      if (!reindexDocId) throw new Error('?documentId= is required for reindexText')
      const embKey = Deno.env.get('VOYAGE_API_KEY') ?? ''
      if (!embKey) throw new Error('VOYAGE_API_KEY secret not set')

      // unpdf (pure JS pdfjs build) extracts per-page text with no WASM/npm
      // boot cost. mergePages:false gives one string per page for page attribution.
      let nPages = 0
      const pages: { page: number; text: string }[] = []
      try {
        const pdf = await getDocumentProxy(new Uint8Array(bytes))
        nPages = pdf.numPages
        // Only truly enormous docs (idle-timeout risk at ~150s) are deferred now
        // that extraction streams page-by-page.
        if (nPages > MAX_REINDEX_PAGES) {
          return new Response(JSON.stringify({
            success: true, reindex_text: true, document_id: reindexDocId, page_count: nPages,
            too_large: true, text_chunks: 0,
          }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
        // STREAM page-by-page. extractText() builds/holds the whole document's text
        // at once and OOMs the isolate (WORKER_RESOURCE_LIMIT) on large/dense PDFs.
        // getPage()+getTextContent()+cleanup() keeps only one page's glyphs live.
        for (let i = 1; i <= nPages; i++) {
          const page = await pdf.getPage(i)
          const tc = await page.getTextContent()
          const txt = (tc.items as Array<{ str?: string; hasEOL?: boolean }>)
            .map(it => (it.str ?? '') + (it.hasEOL ? '\n' : '')).join('')
          pages.push({ page: i, text: txt })
          ;(page as { cleanup?: () => void }).cleanup?.()
        }
      } catch (e) {
        throw new Error('PDF text extraction failed (corrupt or not a PDF): ' + (e instanceof Error ? e.message : String(e)))
      }
      const totalChars = pages.reduce((s, p) => s + p.text.length, 0)

      const avgPerPage = nPages ? totalChars / nPages : 0
      // Scanned / image-only PDF: route to an OCR pass. Decide on the SUBSTANTIVE
      // pages only — those with real text (>= OCR_EMPTY_PAGE_CHARS). If those are
      // themselves thin (< MIN_CHARS_PER_PAGE), the document is a genuine scan
      // (incl. a thin embedded-text layer like the 8-page Fourth Amendment at
      // ~224 chars/pg). A pure scan has NO substantive page → averages 0 → OCR.
      // Excluding near-empty pages from the average is the fix for review #7: a
      // text-native lease with blank/image EXHIBITS or signature pages (dense
      // body + empty tails) no longer gets misrouted to vision OCR, which would
      // discard its perfect embedded text. (Trade-off: a mixed scan whose few
      // text pages are dense is under-covered rather than destroying good text.)
      const nearEmptyPages = pages.filter(p => p.text.length < OCR_EMPTY_PAGE_CHARS).length
      const substantive = pages.filter(p => p.text.length >= OCR_EMPTY_PAGE_CHARS)
      const avgSubstantive = substantive.length
        ? substantive.reduce((s, p) => s + p.text.length, 0) / substantive.length : 0
      const needsOcr = avgSubstantive < MIN_CHARS_PER_PAGE
      if (needsOcr) {
        return new Response(JSON.stringify({
          success: true, reindex_text: true, document_id: reindexDocId, page_count: nPages,
          avg_chars_per_page: Math.round(avgPerPage), avg_substantive_chars: Math.round(avgSubstantive),
          near_empty_pages: nearEmptyPages, needs_ocr: true, text_chunks: 0,
        }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      const chunks = chunkPages(pages)
      if (!chunks.length) {
        return new Response(JSON.stringify({
          success: true, reindex_text: true, document_id: reindexDocId, page_count: nPages,
          avg_chars_per_page: Math.round(avgPerPage), needs_ocr: false, text_chunks: 0,
        }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      const vecs = skipEmbed ? [] : await embedBatch(chunks.map(c => c.content), embKey)
      // Replace any prior verbatim chunks for this doc (idempotent re-run).
      const { error: delErr } = await sb.from('document_chunks').delete().eq('document_id', reindexDocId).eq('kind', 'text')
      if (delErr) throw new Error('clear old text chunks failed: ' + delErr.message)
      // chunk_index offset keeps text chunks clear of the low-index summary chunks.
      const rows = chunks.map((c, i) => ({
        document_id: reindexDocId,
        property_id: ownerPropertyId ?? null,   // DB-resolved owner property, not caller-supplied
        chunk_index: 1000 + i,
        content: c.content,
        embedding_voyage: skipEmbed ? null : `[${vecs[i].join(',')}]`,
        page_number: c.page,
        kind: 'text',
      }))
      // Insert via an RPC that raises statement_timeout locally (migration
      // 20240054). Inserting 1024-dim vectors triggers HNSW + tsvector maintenance
      // per row; once the index passed ~50k rows even a 12-row client insert
      // exceeded the 8s default timeout. The RPC does the whole doc in one
      // statement with SET LOCAL statement_timeout='120s'. Fallback to small
      // client batches if the RPC is not present yet (pre-migration).
      const { error: rpcErr } = await sb.rpc('insert_text_chunks', { p_rows: rows })
      if (rpcErr) {
        if (!/insert_text_chunks|function .* does not exist|PGRST202/i.test(rpcErr.message)) {
          throw new Error('text chunk insert failed: ' + rpcErr.message)
        }
        for (let i = 0; i < rows.length; i += 8) {
          const { error: insErr } = await sb.from('document_chunks').insert(rows.slice(i, i + 8))
          if (insErr) throw new Error('text chunk insert failed: ' + insErr.message)
        }
      }
      await sb.from('documents').update({ is_indexed: true }).eq('id', reindexDocId)

      return new Response(JSON.stringify({
        success: true, reindex_text: true, document_id: reindexDocId, page_count: nPages,
        avg_chars_per_page: Math.round(avgPerPage), needs_ocr: false, text_chunks: rows.length,
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // 1c. OCR TEXT (?ocrText=1) — scanned/image-only docs unpdf returns ~nothing for.
    //     Claude transcribes the PDF verbatim (native vision), emitting "=== PAGE n ==="
    //     markers we split on for page attribution, then the same chunker + insert path
    //     stores kind='text' chunks. Idempotent (replaces prior kind='text').
    if (url.searchParams.get('ocrText') === '1') {
      if (!reindexDocId) throw new Error('?documentId= is required for ocrText')
      const embKey = Deno.env.get('VOYAGE_API_KEY') ?? ''
      if (!skipEmbed && !embKey) throw new Error('VOYAGE_API_KEY secret not set')

      // Page count via MuPDF (low-memory; scanned docs are image-heavy and OOM pdfjs).
      const mu = await loadMupdf()
      let pageCount = 0
      try { const d = mu.Document.openDocument(bytes, 'application/pdf'); pageCount = d.countPages(); (d as { destroy?: () => void }).destroy?.() }
      catch (e) { throw new Error('PDF parse failed (corrupt or not a PDF): ' + (e instanceof Error ? e.message : String(e))) }
      // Ranged OCR (?pageStart/?pageEnd): transcribe ONLY those pages and SPLICE them
      // into the text layer — delete scoped to the range, page numbers remapped to the
      // original document. This is how covenant pages get OCR'd on docs over
      // OCR_MAX_PAGES, and how a truncation gap is repaired WITHOUT nuking a good
      // pdfjs layer (full-doc ocrText replaces the whole layer; 2026-07-22 incident).
      const ocrRanged = pageStart > 0 || pageEnd > 0
      const rngStart  = ocrRanged ? Math.max(1, Math.min(pageStart > 0 ? pageStart : 1, pageCount)) : 1
      const rngEnd    = ocrRanged ? Math.max(rngStart, Math.min(pageEnd > 0 ? pageEnd : pageCount, pageCount)) : pageCount
      if (ocrRanged && rngEnd - rngStart + 1 > OCR_MAX_PAGES) {
        throw new Error(`ranged OCR span ${rngStart}-${rngEnd} exceeds OCR_MAX_PAGES=${OCR_MAX_PAGES}`)
      }
      if (!ocrRanged && pageCount > OCR_MAX_PAGES) {
        return new Response(JSON.stringify({
          success: true, ocr: true, document_id: reindexDocId, page_count: pageCount, too_large: true, text_chunks: 0,
          hint: 'use ?pageStart=&pageEnd= to OCR a page range',
        }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      // Build the byte payload: the whole PDF, or a MuPDF-grafted segment for a range
      // (scanned PDFs are image-heavy; pdf-lib load can OOM the edge worker).
      let ocrBytes = bytes
      if (ocrRanged) {
        const src = mu.Document.openDocument(bytes, 'application/pdf')
        const srcPdf = src.asPDF()
        const dst = new mu.PDFDocument()
        for (let i = rngStart - 1; i < rngEnd; i++) dst.graftPage(-1, srcPdf, i)
        const buf = dst.saveToBuffer('garbage')
        ocrBytes = new Uint8Array(buf.asUint8Array())
        ;(buf as { destroy?: () => void }).destroy?.()
        ;(dst as { destroy?: () => void }).destroy?.()
        ;(src as { destroy?: () => void }).destroy?.()
      }

      const ocrPrompt = `Transcribe ALL text in this document VERBATIM, in natural reading order. This is an OCR task for a legal-document search index. Rules:
- Output ONLY the transcribed text — no commentary, summary, or headings you add yourself.
- Begin each page with a line "=== PAGE n ===" (n = the page number) so the text can be located.
- Preserve dollar amounts, dates, section numbers, defined terms, and party names exactly as written.
- If a page is blank or unreadable, still emit its "=== PAGE n ===" line followed by "[no legible text]".${
        ocrRanged ? `\n- This file is an EXCERPT: its first page is page ${rngStart} of the original document. Number pages ${rngStart} through ${rngEnd} accordingly.` : ''}`
      // Provider: ?ocrProvider=openai routes to GPT-4o vision (works during an
      // Anthropic overload); default is Claude native-PDF vision (existing path).
      const ocrProvider = (url.searchParams.get('ocrProvider') ?? OCR_PROVIDER_DEFAULT).toLowerCase()
      let full = ''
      let truncated = false
      let usedModel = OCR_MODEL
      if (ocrProvider === 'openai') {
        const oaiKey = Deno.env.get('OPENAI_API_KEY') ?? ''
        if (!oaiKey) throw new Error('OPENAI_API_KEY secret not set')
        usedModel = OCR_OPENAI_MODEL
        const res = await ocrViaOpenAI(ocrBytes, oaiKey, ocrPrompt)
        full = res.full; truncated = res.truncated
      } else {
        const aRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: OCR_MODEL, max_tokens: OCR_MAX_TOKENS,
            messages: [{ role: 'user', content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(ocrBytes) } },
              { type: 'text', text: ocrPrompt },
            ] }],
          }),
        })
        const aData = await aRes.json()
        if (!aRes.ok) throw new Error('OCR API error: ' + JSON.stringify(aData))
        truncated = aData.stop_reason === 'max_tokens'
        full = (aData.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('')
      }

      // Split on the page markers for attribution; fall back to one page-1 block.
      const pages: { page: number; text: string }[] = []
      const re = /===\s*PAGE\s+(\d+)\s*===/gi
      const marks: { page: number; at: number; end: number }[] = []
      let m: RegExpExecArray | null
      while ((m = re.exec(full))) marks.push({ page: Number(m[1]), at: m.index, end: re.lastIndex })
      // Ranged mode: the model sees the SEGMENT. It is told to number from rngStart,
      // but tolerate both conventions — original-document numbers (in range) pass
      // through; segment-relative 1..k numbers are offset; anything else falls back
      // to position. Full-doc mode (rngStart=1) reduces to the original behavior.
      const segLen = rngEnd - rngStart + 1
      const mapPage = (raw: number, i: number): number => {
        if (raw >= rngStart && raw <= rngEnd) return raw
        if (raw >= 1 && raw <= segLen) return raw + (rngStart - 1)
        return Math.min(rngStart + i, rngEnd)
      }
      if (!marks.length) {
        pages.push({ page: rngStart, text: full })
      } else {
        for (let i = 0; i < marks.length; i++) {
          const body = full.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].at : full.length)
          pages.push({ page: mapPage(marks[i].page || 0, i), text: body })
        }
      }
      const totalChars = pages.reduce((s, p) => s + p.text.length, 0)
      if (totalChars < 40) {
        return new Response(JSON.stringify({
          success: true, ocr: true, document_id: reindexDocId, page_count: pageCount, text_chunks: 0, empty: true,
        }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      const chunks = chunkPages(pages)
      const vecs = skipEmbed ? [] : await embedBatch(chunks.map(c => c.content), embKey)
      // Ranged: splice — clear ONLY this range's prior text chunks and slot the new ones
      // after the current max index (keeps the rest of the layer intact). Full: replace all.
      let del = sb.from('document_chunks').delete().eq('document_id', reindexDocId).eq('kind', 'text')
      if (ocrRanged) del = del.gte('page_number', rngStart).lte('page_number', rngEnd)
      const { error: delErr } = await del
      if (delErr) throw new Error('clear old text chunks failed: ' + delErr.message)
      let idxBase = 1000
      if (ocrRanged) {
        const { data: mx } = await sb.from('document_chunks').select('chunk_index')
          .eq('document_id', reindexDocId).eq('kind', 'text')
          .order('chunk_index', { ascending: false }).limit(1).maybeSingle()
        idxBase = Math.max(1000, ((mx?.chunk_index as number | undefined) ?? 999) + 1)
      }
      const rows = chunks.map((c, i) => ({
        document_id: reindexDocId, property_id: ownerPropertyId ?? null, chunk_index: idxBase + i,
        content: c.content, embedding_voyage: skipEmbed ? null : `[${vecs[i].join(',')}]`, page_number: c.page, kind: 'text',
      }))
      const { error: rpcErr } = await sb.rpc('insert_text_chunks', { p_rows: rows })
      if (rpcErr) {
        if (!/insert_text_chunks|does not exist|PGRST202/i.test(rpcErr.message)) throw new Error('text chunk insert failed: ' + rpcErr.message)
        for (let i = 0; i < rows.length; i += 8) {
          const { error: insErr } = await sb.from('document_chunks').insert(rows.slice(i, i + 8))
          if (insErr) throw new Error('text chunk insert failed: ' + insErr.message)
        }
      }
      await sb.from('documents').update({ is_indexed: true }).eq('id', reindexDocId)
      return new Response(JSON.stringify({
        success: true, ocr: true, document_id: reindexDocId, page_count: pageCount,
        text_chunks: rows.length, model: usedModel, provider: ocrProvider, truncated,
        ...(ocrRanged ? { page_start: rngStart, page_end: rngEnd } : {}),
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // 2. Parse the PDF (page count) then extract. Oversized docs are split into
    //    page-range segments so each request stays under the 100-page / 200k-token limits.
    //    Engine chosen by size: pdf-lib for normal docs, MuPDF (low-memory) for large ones.
    const useMu = forceMu || bytes.length > LARGE_BYTES
    // Large-doc engine loaded on demand only (top-level npm:mupdf breaks edge boot).
    const mupdf = useMu ? await loadMupdf() : null
    let pageCount = 0
    let plSrc: PDFDocument | null = null     // pdf-lib source (small docs)
    let muSrc: { graftPage: (to: number, src: unknown, page: number) => void } | null = null
    let muPdf: unknown = null                 // MuPDF source PDFDocument (large docs)
    try {
      if (useMu) {
        const doc = mupdf.Document.openDocument(bytes, 'application/pdf')
        muPdf = doc.asPDF()
        pageCount = doc.countPages()
      } else {
        plSrc = await PDFDocument.load(bytes, { ignoreEncryption: true })
        pageCount = plSrc.getPageCount()
      }
    } catch (e) {
      throw new Error('PDF parse failed (corrupt or not a PDF): ' + (e instanceof Error ? e.message : String(e)))
    }

    // Build a single-segment PDF [start,end) as raw bytes, using whichever engine is active.
    // MuPDF WASM memory grows monotonically, so free each segment's objects and copy the
    // bytes into JS-owned memory before destroying the WASM buffer.
    const segmentBytes = async (start: number, end: number): Promise<Uint8Array> => {
      if (useMu) {
        const dst = new mupdf.PDFDocument()
        for (let i = start; i < end; i++) dst.graftPage(-1, muPdf, i)
        const buf = dst.saveToBuffer('garbage')
        const out = new Uint8Array(buf.asUint8Array())
        ;(buf as { destroy?: () => void }).destroy?.()
        ;(dst as { destroy?: () => void }).destroy?.()
        return out
      }
      const sub = await PDFDocument.create()
      const copied = await sub.copyPages(plSrc!, Array.from({ length: end - start }, (_, k) => start + k))
      copied.forEach((p) => sub.addPage(p))
      return await sub.save()
    }

    const extractions: Record<string, unknown>[] = []
    const segMeta: { start: number; end: number }[] = []
    const usages: unknown[] = []

    const segStep = segPagesParam > 0 ? segPagesParam : (useMu ? LARGE_SEG_PAGES : SEG_PAGES)

    const extractWhole = async () => {
      const { extraction, usage } = await callClaude(toBase64(bytes), model, apiKey)
      extractions.push(extraction); segMeta.push({ start: 1, end: pageCount }); usages.push(usage)
    }
    // Extract one page range [s,e). On a token-limit error, recursively halve the range —
    // a single dense/OCR segment can exceed 200k tokens even well under the page limit.
    const extractRange = async (s: number, e: number): Promise<void> => {
      const subBytes = await segmentBytes(s, e)
      try {
        const { extraction, usage } = await callClaude(toBase64(subBytes), model, apiKey)
        extractions.push(extraction); segMeta.push({ start: s + 1, end: e }); usages.push(usage)
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        if (m.includes('prompt is too long') && (e - s) > 1) {
          const mid = Math.floor((s + e) / 2)
          await extractRange(s, mid)
          await extractRange(mid, e)
        } else throw err
      }
    }
    // Segment [from,to) into segStep-page ranges (each may sub-split on the token limit).
    const extractPageRange = async (from: number, to: number) => {
      extractions.length = 0; segMeta.length = 0; usages.length = 0
      for (let start = from; start < to; start += segStep) {
        await extractRange(start, Math.min(start + segStep, to))
      }
    }

    // Range mode (?pageStart/?pageEnd or ?appendDocId): process ONLY the requested pages,
    // always segmented. Lets a client drive one request per page-batch so no single request
    // runs long enough to hit the 150s idle timeout, and peak memory stays bounded.
    const rangeStart = pageStart > 0 ? Math.min(pageStart - 1, pageCount) : 0
    const rangeEnd   = pageEnd   > 0 ? Math.min(pageEnd, pageCount)       : pageCount
    const isRange = pageStart > 0 || pageEnd > 0 || !!appendDocId

    let wasSplit = false
    try {
      if (isRange) { wasSplit = true; await extractPageRange(rangeStart, rangeEnd) }
      // Large (MuPDF) docs always split — avoids sending a ~30MB blob whole.
      else if (useMu || pageCount > PAGE_LIMIT) { wasSplit = true; await extractPageRange(0, pageCount) }
      else await extractWhole()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === 'REFUSAL') {
        return new Response(JSON.stringify({ error: 'Model refused to process this document' }),
          { status: 422, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      // Under the page limit but over the token limit -> fall back to splitting.
      if (!wasSplit && msg.includes('prompt is too long')) { wasSplit = true; await extractPageRange(0, pageCount) }
      else throw e
    }

    ;(muPdf as { destroy?: () => void } | null)?.destroy?.()
    const extraction = mergeExtractions(extractions, segMeta)

    // 3. Optionally persist one documents row + one embedding chunk PER segment
    //    (passage-level chunks; for a non-split doc this is a single chunk as before).
    let documentId: string | null = appendDocId ?? null
    let embeddedChunks = 0
    if (store || appendDocId) {
      let chunkOffset = 0
      let existingNotes: Record<string, unknown> = {}
      if (appendDocId) {
        // APPEND: no new row. Continue chunk_index after the existing chunks, and merge
        // this batch's segments into the stored abstraction (below) so notes cover the
        // whole document rather than only the first batch.
        const { data: apDoc, error: apErr } = await sb.from('documents').select('notes').eq('id', appendDocId).maybeSingle()
        if (apErr) throw new Error('append doc lookup failed: ' + apErr.message)
        if (!apDoc) throw new Error('appendDocId not found: ' + appendDocId)
        try { existingNotes = JSON.parse(String(apDoc.notes ?? '{}')) } catch { existingNotes = {} }
        const { count, error: cntErr } = await sb.from('document_chunks')
          .select('id', { count: 'exact', head: true }).eq('document_id', appendDocId)
        if (cntErr) throw new Error('chunk count failed: ' + cntErr.message)
        chunkOffset = count ?? 0
        documentId = appendDocId
      } else {
        const { data, error } = await sb.from('documents').insert({
          property_id: propertyId ?? null,
          file_path:   filePathOverride ?? sourceId,   // 'file:\\server\...' for local, else 'storage:'/'drive:'
          doc_type:    toDocTypeEnum(extraction.doc_type),
          title:       String(extraction.summary ?? '').slice(0, 200),
          notes:       JSON.stringify(wasSplit ? { ...extraction, _segments: extractions, _segMeta: segMeta } : extraction),
          is_indexed:  false,
        }).select('id').single()
        if (error) throw new Error('documents insert failed: ' + error.message)
        documentId = data?.id ?? null
      }

      const embKey = Deno.env.get('VOYAGE_API_KEY') ?? ''
      if (documentId && embKey) {
        for (let i = 0; i < extractions.length; i++) {
          const content = searchableText(extractions[i])
          const vec = await embed(content, embKey)
          // pgvector wants a bracketed string literal via PostgREST
          const { error: cErr } = await sb.from('document_chunks').insert({
            document_id: documentId, chunk_index: chunkOffset + i, content,
            embedding_voyage: `[${vec.join(',')}]`, page_number: segMeta[i].start,
          })
          if (cErr) throw new Error('document_chunks insert failed: ' + cErr.message)
          embeddedChunks++
        }
      }

      if (appendDocId && documentId) {
        // Re-merge previous + this batch's segments into one document-level abstraction.
        const prevSegs = Array.isArray(existingNotes._segments)
          ? (existingNotes._segments as Record<string, unknown>[])
          : (Object.keys(existingNotes).length ? [existingNotes] : [])
        const prevMeta = Array.isArray(existingNotes._segMeta)
          ? (existingNotes._segMeta as { start: number; end: number }[])
          : prevSegs.map(() => ({ start: 1, end: rangeStart }))
        const allSegs = [...prevSegs, ...extractions]
        const allMeta = [...prevMeta, ...segMeta]
        const remerged = mergeExtractions(allSegs, allMeta)
        await sb.from('documents').update({
          doc_type:   toDocTypeEnum(remerged.doc_type),
          title:      String(remerged.summary ?? '').slice(0, 200),
          notes:      JSON.stringify({ ...remerged, _segments: allSegs, _segMeta: allMeta }),
          is_indexed: true,
        }).eq('id', documentId)
      } else if (embeddedChunks > 0 && documentId) {
        await sb.from('documents').update({ is_indexed: true }).eq('id', documentId)
      }
    }

    return new Response(JSON.stringify({
      success: true, source: sourceId, model,
      pdf_bytes: bytes.length, page_count: pageCount, was_split: wasSplit, segments: extractions.length,
      stored_document_id: documentId, embedded_chunks: embeddedChunks,
      usage: usages, extraction,
    }, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
