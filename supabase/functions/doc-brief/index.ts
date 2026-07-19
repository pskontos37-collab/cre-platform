// doc-brief — per-document structured extraction (abstraction-standard.md §2 Stage 1).
//
// Reads 100% of one document's corpus text and produces a structured BRIEF:
// classification (doc_class/chain_role), parties, execution status, dates,
// rent tables, option/guaranty/assignment effects, clause inventory with
// verbatim operative language, and critical dates. lease-abstract synthesizes
// from these briefs instead of truncated raw text — no instrument is ever
// partially read again.
//
// Giant instruments are walked in SEGMENTS (~180K chars each). One invocation
// processes segments until ~100s elapsed, persists progress to doc_briefs
// (segments/segments_done), and returns { done:false } so the caller loops —
// resumable across the edge runtime's 150s wall. When all segments are done a
// final merge call combines them into one brief.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.
// Usage: POST JSON { document_id: uuid, force?: boolean }
//   → { success, done, segments_done, segments_total, brief? }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canWriteProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

const MODEL = Deno.env.get('BRIEF_MODEL') ?? Deno.env.get('ABSTRACT_MODEL') ?? 'claude-sonnet-5'
// TIMING CONSTRAINT: the edge runtime kills a request after 150s without
// response bytes, and the model generates ~60-80 output tokens/sec — so one
// segment call must stay under ~8K output tokens to finish in time. Output
// scales with the clause density of the segment, so SMALL segments (60K chars
// ≈ 15K input tokens) keep each call's brief small; a clause-dense base lease
// spreads across several resumable calls instead of one giant one. Segments
// are merged DETERMINISTICALLY in code (no merge model call — a union of
// per-segment briefs would itself exceed the wall on giant instruments).
const SEGMENT_CHARS = 60_000
const SEGMENT_MAX_TOKENS = 8_000
// Stage 1.5: brief a giant document's segments CONCURRENTLY within one
// invocation instead of one-at-a-time across resumable calls. Concurrent fetches
// don't add wall-clock (they overlap), so a multi-segment base lease finishes in
// ~one segment's time instead of the sum. Each segment result is persisted AS IT
// COMPLETES (serialized write), so a 150s wall-kill still makes progress and the
// caller's resume finishes the rest. SOFT_DEADLINE stops launching new segment
// calls with headroom before the wall.
const SEGMENT_CONCURRENCY = Number(Deno.env.get('BRIEF_SEG_CONCURRENCY') ?? 4)   // segments of ONE doc at once
const SEGMENT_OVERLAP = 2_000     // look-back chars so a boundary-spanning clause/rent row stays whole in >=1 segment (merge dedupes the overlap)
// A worker only STARTS a new segment while under this deadline; one segment runs
// ~100-120s, so keeping this low guarantees a started segment finishes before the
// 150s wall. Effect: each invocation briefs one concurrent WAVE of up to
// SEGMENT_CONCURRENCY segments (the common giant doc = 3-4 segments = one wave =
// one invocation). Bigger docs persist the wave and resume for the next.
const SOFT_DEADLINE_MS = 30_000

async function anthropicJson(key: string, model: string, content: any[], maxTokens: number): Promise<any> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      tools: [{
        name: 'submit_brief',
        description: 'Submit the structured document brief.',
        input_schema: { type: 'object', additionalProperties: true },
      }],
      tool_choice: { type: 'tool', name: 'submit_brief' },
      messages: [{ role: 'user', content }],
    }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Anthropic API error: ' + JSON.stringify(d))
  if (d.stop_reason === 'max_tokens') throw new Error('Brief truncated at max_tokens — retry')
  const block = (d.content ?? []).find((c: { type: string }) => c.type === 'tool_use')
  if (!block) throw new Error('Model returned no tool_use block')
  // Some generations wrap the payload in an envelope key despite the schema —
  // observed variants: {"brief": {...}} and literal placeholder keys
  // ({"$PARAMETER_NAME": {...}}). Unwrap generically: if the top level doesn't
  // look like a brief but exactly one child does, use the child; if nothing
  // looks right, THROW so the caller retries instead of storing a null brief.
  const looksLikeBrief = (o: any) =>
    o && typeof o === 'object' && !Array.isArray(o) && ('doc_class' in o || 'chain_role' in o || 'clauses' in o)
  let out = block.input ?? {}
  if (!looksLikeBrief(out)) {
    const kids = Object.values(out).filter(looksLikeBrief)
    if (kids.length === 1) out = kids[0]
  }
  if (!looksLikeBrief(out)) throw new Error('Model returned a malformed brief envelope — retry')
  return out
}

// One brief shape for every document class; irrelevant sections stay empty.
// Verbatim `quote` fields ground every extracted value in the source text.
const BRIEF_SCHEMA = `{
 "doc_class": "operative_instrument"|"ancillary_executed"|"notice_correspondence"|"financial_operational"|"property_level"|"draft_unexecuted"|"other",
 "chain_role": "base_lease"|"amendment"|"cda"|"assignment"|"guaranty"|"option_exercise_notice"|"termination"|"snda"|"estoppel"|"mol"|"license"|"rea"|"pma"|"recon"|"sales_report"|"correspondence"|"other",
 "instrument_name": str,                      // e.g. "Third Amendment to Net Ground Lease"
 "instrument_date": "YYYY-MM-DD"|null,        // date AS STATED on the instrument
 "effective_date": "YYYY-MM-DD"|null,
 "parties": {"landlord": str|null, "tenant": str|null, "guarantor": str|null, "other": [str]},
 "executed": "Y"|"N"|"partial"|"?",           // partial = some signature blocks blank in this copy
 "execution_notes": str|null,
 "premises": {"suite": str|null, "square_feet": num|null, "center": str|null},
 "chain": {"amends": str|null, "recites_prior_chain": [str], "position": str|null},
 "term_effects": [{"field": str, "value": str, "quote": str, "section": str}],   // dates/term this instrument SETS or CHANGES (commencement, RCD, expiration, extension)
 "rent_effects": [{"start": "YYYY-MM-DD"|str|null, "end": "YYYY-MM-DD"|str|null, "psf": num|null, "monthly": num|null, "annual": num|null, "quote": str, "section": str, "replaces_prior": bool|null}],
 "option_effects": [{"action": "grants"|"voids"|"exercises"|"modifies"|"confirms", "detail": str, "notice_mechanics": str|null, "notice_by_date": "YYYY-MM-DD"|null, "landlord_reminder_required": bool|null, "quote": str, "section": str}],
 "guaranty_effects": [{"action": "creates"|"reaffirms"|"replaces"|"releases"|"caps"|"references", "guarantor": str|null, "detail": str, "quote": str, "section": str}],
 "assignment_effects": [{"assignor": str|null, "assignee": str|null, "assignor_released": bool|null, "replacement_guaranty": str|null, "detail": str, "section": str}],
 "clauses": [{"clause": str, "section": str, "operative_language": str, "notes": str|null}],
 "critical_dates": [{"date": "YYYY-MM-DD", "event": str, "quote": str}],
 "references_other_instruments": [str],       // instruments this document mentions that may or may not be in the file
 "key_facts": [str],
 "quality": {"text_legible": bool, "notes": str|null}
}`

const SEGMENT_PROMPT = (docMeta: string, segIdx: number, segTotal: number, priorContext: string, text: string) =>
  `You are extracting a structured brief from ONE commercial real estate document for M&J Wilkow's lease-abstraction system (segment ${segIdx + 1} of ${segTotal}).

DOCUMENT METADATA:
${docMeta}
${priorContext ? `\nCONTEXT FROM EARLIER SEGMENTS of this same document (already extracted — do not repeat, but use to interpret continuations):\n${priorContext}\n` : ''}
EXTRACTION RULES:
- Extract ONLY what THIS text states. Every date, dollar amount, party, and clause must carry a VERBATIM quote (trim to the operative sentence(s)). Never estimate or fill from general knowledge.
- QUOTE BUDGET: keep each quote/operative_language value to the most operative sentence(s), max ~600 characters (CAM/exclusive/co-tenancy language may run to ~1,200 where the remedies matter). One clauses[] entry per distinct clause — do not repeat near-identical entries. The brief is an index into the document, not a transcription of it.
- Classification (doc_class): correspondence, default notices, past-due letters, force-majeure letters, and emails are "notice_correspondence" — even when they discuss lease terms. CAM/RET reconciliations, sales reports, invoices are "financial_operational". Unsigned drafts/redlines are "draft_unexecuted". Executed leases/amendments/CDAs/lease supplements/assignments/terminations and executed option-EXERCISE notices are "operative_instrument". Guaranties, SNDAs, estoppels, MOLs, licenses are "ancillary_executed". REA/OEA/declarations and management agreements are "property_level".
- CLAUSE DISCIPLINE: distinguish (a) the tenant's PERMITTED USE (what tenant may do), (b) the tenant's OWN EXCLUSIVE (landlord covenant restricting OTHERS for tenant's benefit — include remedies), (c) USE RESTRICTIONS BINDING THE TENANT (other tenants' exclusives / prohibited-use schedules, often in exhibits). Label clause entries exactly: "permitted_use", "tenant_exclusive", "use_restrictions_on_tenant", "prohibited_uses", "co_tenancy", "kickout_termination", "radius", "continuous_operations", "go_dark", "relocation", "recapture", "assignment_subletting", "percentage_rent", "cam", "real_estate_tax", "insurance", "security_deposit", "tenant_allowance", "signage", "parking", "estoppel_obligation", "snda_obligation", "purchase_option_rofr", "default_remedies", "landlord_reminder" or a clear other name.
- OPTION MECHANICS: capture notice windows verbatim; when the instrument states or lets you compute a hard notice-by DATE for a specific option, set notice_by_date. If the LANDLORD must remind/notify the tenant about the option window, set landlord_reminder_required=true.
- GUARANTY/ASSIGNMENT: record every guaranty creation, reaffirmation, replacement, release, or cap, and for assignments whether the assignor remains liable and any replacement guaranty delivered.
- If the text is illegible/garbled OCR in places, set quality.text_legible=false and say where.
- This is segment ${segIdx + 1}/${segTotal}: extract everything in THIS segment; the merge step combines segments.

Call submit_brief with an object matching this schema exactly (all keys present, empty arrays where nothing applies). The fields (doc_class, chain_role, …) go at the TOP LEVEL of the tool input — do NOT wrap them in an envelope key:
${BRIEF_SCHEMA}

DOCUMENT TEXT (segment ${segIdx + 1}/${segTotal}):
${text}`

// Deterministic merge of per-segment briefs — no model call. Merging is
// mechanical (arrays union + dedupe, scalars take the most informative value),
// and a model-emitted union brief for a giant instrument would itself exceed
// the 150s output wall.
function mergeBriefs(segs: any[]): any {
  if (segs.length === 1) return segs[0]
  const firstNonNull = (get: (s: any) => any) => {
    for (const s of segs) { const v = get(s); if (v != null && v !== '' && v !== '?') return v }
    return get(segs[0]) ?? null
  }
  const unionBy = (key: (x: any) => string, lists: any[][]) => {
    const seen = new Set<string>(); const out: any[] = []
    for (const list of lists) for (const x of (Array.isArray(list) ? list : [])) {
      const k = key(x); if (seen.has(k)) continue; seen.add(k); out.push(x)
    }
    return out
  }
  // Signature blocks live in the tail segments: any segment that positively saw
  // execution beats '?'; full execution beats partial.
  const execVals = segs.map(s => s?.executed).filter(v => v && v !== '?')
  const executed = execVals.includes('Y') ? 'Y' : execVals.includes('partial') ? 'partial' : execVals.includes('N') ? 'N' : '?'
  return {
    doc_class: firstNonNull(s => s?.doc_class),
    chain_role: firstNonNull(s => s?.chain_role),
    instrument_name: firstNonNull(s => s?.instrument_name),
    instrument_date: firstNonNull(s => s?.instrument_date),
    effective_date: firstNonNull(s => s?.effective_date),
    parties: {
      landlord: firstNonNull(s => s?.parties?.landlord),
      tenant: firstNonNull(s => s?.parties?.tenant),
      guarantor: firstNonNull(s => s?.parties?.guarantor),
      other: unionBy(x => String(x), segs.map(s => s?.parties?.other ?? [])),
    },
    executed,
    execution_notes: segs.map(s => s?.execution_notes).filter(Boolean).join(' | ') || null,
    premises: {
      suite: firstNonNull(s => s?.premises?.suite),
      square_feet: firstNonNull(s => s?.premises?.square_feet),
      center: firstNonNull(s => s?.premises?.center),
    },
    chain: {
      amends: firstNonNull(s => s?.chain?.amends),
      recites_prior_chain: unionBy(x => String(x), segs.map(s => s?.chain?.recites_prior_chain ?? [])),
      position: firstNonNull(s => s?.chain?.position),
    },
    term_effects: unionBy(x => `${x?.field}|${x?.value}`, segs.map(s => s?.term_effects ?? [])),
    rent_effects: unionBy(x => `${x?.start}|${x?.end}|${x?.annual}|${x?.monthly}|${x?.psf}`, segs.map(s => s?.rent_effects ?? [])),
    option_effects: unionBy(x => `${x?.action}|${x?.detail}`, segs.map(s => s?.option_effects ?? [])),
    guaranty_effects: unionBy(x => `${x?.action}|${x?.guarantor}|${x?.detail}`, segs.map(s => s?.guaranty_effects ?? [])),
    assignment_effects: unionBy(x => `${x?.assignor}|${x?.assignee}|${x?.detail}`, segs.map(s => s?.assignment_effects ?? [])),
    clauses: unionBy(x => `${x?.clause}|${x?.section}`, segs.map(s => s?.clauses ?? [])),
    critical_dates: unionBy(x => `${x?.date}|${x?.event}`, segs.map(s => s?.critical_dates ?? [])),
    references_other_instruments: unionBy(x => String(x), segs.map(s => s?.references_other_instruments ?? [])),
    key_facts: unionBy(x => String(x), segs.map(s => s?.key_facts ?? [])),
    quality: {
      text_legible: segs.every(s => s?.quality?.text_legible !== false),
      notes: segs.map(s => s?.quality?.notes).filter(Boolean).join(' | ') || null,
    },
  }
}

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const t0 = Date.now()
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const caller = await requireUser(req, sb)

    const body = await req.json().catch(() => ({}))
    const documentId: string = body.document_id ?? ''
    if (!documentId) throw new Error('document_id is required')

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')

    // ── 1. Document + access ──
    const { data: doc, error: dErr } = await sb.from('documents')
      .select('id, property_id, doc_type, title, file_name, file_path')
      .eq('id', documentId).maybeSingle()
    if (dErr) throw new Error('document load failed: ' + dErr.message)
    if (!doc) throw new Error('document not found')
    // WRITE gate (audit S2): briefs are written to doc_briefs and AI credits are
    // spent — read access is not enough. Unconditional: null-property (company-
    // wide) documents need full access to (re)brief.
    if (!canWriteProperty(caller, doc.property_id ?? null)) {
      throw new AuthError('No write access to this document', 403)
    }

    // ── 2. Full text: prefer the verbatim kind='text' layer; fall back to
    // whatever chunks exist (curated extraction) for docs the text layer
    // hasn't reached. page-ordered. ──
    const { data: chunks, error: cErr } = await sb.from('document_chunks')
      .select('kind, chunk_index, content')
      .eq('document_id', documentId)
      .order('chunk_index')
    if (cErr) throw new Error('chunk load failed: ' + cErr.message)
    const all = (chunks ?? []) as any[]
    const textChunks = all.filter(c => c.kind === 'text')
    const useChunks = textChunks.length ? textChunks : all
    const fullText = useChunks.map(c => c.content ?? '').join('\n')
    if (!fullText.trim()) throw new Error('document has no indexed text — run reindex/OCR first')

    // ── 3. Existing brief? (idempotent unless text changed or force) ──
    const { data: existing } = await sb.from('doc_briefs')
      .select('id, brief, segments, segments_done, segments_total, text_chars, status')
      .eq('document_id', documentId).maybeSingle()
    if (existing?.status === 'complete' && existing.brief &&
        existing.text_chars === fullText.length && !body.force) {
      return new Response(JSON.stringify({
        success: true, done: true, cached: true,
        segments_done: existing.segments_done, segments_total: existing.segments_total,
        brief: existing.brief,
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    const segTotal = Math.max(1, Math.ceil(fullText.length / SEGMENT_CHARS))
    // Resume only when the prior run saw the SAME text AND the same segment
    // boundaries (segments_total match — SEGMENT_CHARS changes invalidate
    // partials); otherwise start over. segs is POSITIONAL (index i = segment i)
    // and may have holes while segments brief concurrently.
    const resume = existing && existing.text_chars === fullText.length
      && existing.segments_total === segTotal && !body.force
    const segs: any[] = new Array(segTotal).fill(null)
    if (resume && Array.isArray(existing!.segments)) {
      for (let i = 0; i < segTotal; i++) if (existing!.segments[i]) segs[i] = existing!.segments[i]
    }

    const docMeta = `title: ${doc.title ?? doc.file_name}\nfile: ${doc.file_path ?? ''}\ncorpus doc_type tag: ${doc.doc_type ?? '?'}\ntotal text: ${fullText.length.toLocaleString()} chars in ${segTotal} segment(s)`

    // Clause-dense instruments can exceed even the raised output cap; retry
    // once in TERSE mode (shortest operative quotes, material entries only)
    // rather than failing the whole brief.
    const TERSE_ADDENDUM = `\n\nTERSE MODE (your previous attempt exceeded the output limit): keep every quote to ONE operative sentence (max ~300 chars), cap clauses[] at the 20 most material entries, cap key_facts at 8, and omit rent_effects rows beyond the controlling schedule. Completeness of FIELDS still matters; verbosity does not.`
    const isTruncated = (e: unknown) => /truncated at max_tokens/i.test(e instanceof Error ? e.message : String(e))
    const callWithTerseRetry = async (text: string, maxTokens: number) => {
      try {
        return await anthropicJson(anthropicKey, MODEL, [{ type: 'text', text }], maxTokens)
      } catch (e) {
        if (!isTruncated(e)) throw e
        return await anthropicJson(anthropicKey, MODEL, [{ type: 'text', text: text + TERSE_ADDENDUM }], maxTokens)
      }
    }

    // ── 4. Brief the missing segments CONCURRENTLY (bounded pool). Segments are
    // independent given verbatim-only extraction + the overlap window, and the
    // deterministic merge dedupes any overlap. Each result is persisted as it
    // completes through a SERIALIZED write chain (single invocation → no
    // cross-writer race), so a wall-kill still advances and resume finishes. ──
    let persistChain: Promise<any> = Promise.resolve()
    const persistProgress = () => {
      persistChain = persistChain.then(() => sb.from('doc_briefs').upsert({
        document_id: documentId, property_id: doc.property_id,
        segments: segs, segments_done: segs.filter(Boolean).length, segments_total: segTotal,
        text_chars: fullText.length, status: 'in_progress', model: MODEL, error: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'document_id' }))
      return persistChain
    }
    const missing = [...Array(segTotal).keys()].filter(i => !segs[i])
    let segErr: string | null = null
    const worker = async () => {
      while (missing.length && Date.now() - t0 < SOFT_DEADLINE_MS) {
        const i = missing.shift()!                 // shift() is synchronous — no inter-worker race
        // Overlap look-back so a clause/rent row straddling a boundary is whole
        // in this segment too (merge dedupes). No prior-segment context: segments
        // run concurrently and extraction is verbatim-only.
        const start = Math.max(0, i * SEGMENT_CHARS - (i > 0 ? SEGMENT_OVERLAP : 0))
        const segText = fullText.slice(start, (i + 1) * SEGMENT_CHARS)
        try {
          segs[i] = await callWithTerseRetry(SEGMENT_PROMPT(docMeta, i, segTotal, '', segText), SEGMENT_MAX_TOKENS)
          await persistProgress()
        } catch (e) {
          // Leave this index for a resume retry; record only a genuinely
          // non-transient error to surface if NOTHING completes.
          const m = e instanceof Error ? e.message : String(e)
          if (!/truncated at max_tokens|overloaded|rate_limit|\b529\b|Anthropic API error/i.test(m)) segErr = m
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(SEGMENT_CONCURRENCY, Math.max(1, missing.length)) }, worker))
    await persistChain   // flush any in-flight serialized writes

    const doneCount = segs.filter(Boolean).length
    if (doneCount < segTotal) {
      if (doneCount === 0 && segErr) throw new Error('segment briefing failed: ' + segErr)
      return new Response(JSON.stringify({
        success: true, done: false, segments_done: doneCount, segments_total: segTotal,
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── 5. Merge (deterministic, in code) ──
    const brief = mergeBriefs(segs)

    const { error: upErr } = await sb.from('doc_briefs').upsert({
      document_id: documentId,
      property_id: doc.property_id,
      doc_class: typeof brief?.doc_class === 'string' ? brief.doc_class : null,
      chain_role: typeof brief?.chain_role === 'string' ? brief.chain_role : null,
      brief,
      segments: null,          // partials no longer needed once merged
      segments_done: doneCount,
      segments_total: segTotal,
      text_chars: fullText.length,
      status: 'complete',
      model: MODEL,
      error: null,
      extracted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'document_id' })
    if (upErr) throw new Error('save failed: ' + upErr.message)

    return new Response(JSON.stringify({
      success: true, done: true, segments_done: doneCount, segments_total: segTotal, brief,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
