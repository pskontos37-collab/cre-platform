// lease-abstract — generates a Wilkow-template lease abstract for one tenant.
//
// Pipeline:
//   1. Find the tenant's documents at the property (title/file_path whole-word
//      match, tenant folders live at …\TENANTS\<name>\…), leases+amendments first.
//   2. Pull the full chunk text of the top documents (capped char budget).
//   3. One claude-sonnet-5 call produces JSON shaped EXACTLY like the firm's
//      "Lease Abstract Template.xlsx" — exact language where the template asks
//      for it, lease section references, UNKNOWN where the docs are silent.
//   4. Upsert into lease_abstracts (property_id, tenant_name unique).
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.
// Usage: POST JSON { property_id: uuid, tenant: string, force?: boolean }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canReadProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

const MODEL = Deno.env.get('ABSTRACT_MODEL') ?? 'claude-sonnet-5'
const CHAR_BUDGET = 350_000   // ~90k tokens of document text

const ilikeSafe = (s: string) => s.replace(/[(),%_]/g, ' ').replace(/\s+/g, ' ').trim()

// Forced tool-use call: the API returns the abstract as an already-parsed JSON
// object (tool_use.input), so quoted lease language can never break parsing.
// `content` is a message-content array (document blocks + text).
async function anthropicJson(key: string, model: string, content: any[], maxTokens: number): Promise<any> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      tools: [{
        name: 'submit_abstract',
        description: 'Submit the completed lease abstract.',
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

// The JSON shape mirrors the template sheet section-for-section.
const SCHEMA = `{
 "trade_name": str, "tenant_legal_name": str, "suite": str, "square_footage": num|null,
 "lease_documents": [{"type": str, "date": "YYYY-MM-DD"|str, "signed": "Y"|"N"|"?", "notes": str}],
 "term": {"rent_commencement": str, "expiration": str, "term_years": num|null, "section": str},
 "guarantor": {"exists": bool, "name": str|null, "details": str|null, "section": str|null},
 "base_rent_schedule": [{"months": num|null, "start": str, "end": str, "psf": num|null, "monthly": num|null, "annual": num|null}],
 "options": [{"term": str, "notice_period": str, "start": str|null, "end": str|null, "psf": num|null, "monthly": num|null, "annual": num|null, "section": str}],
 "percentage_rent": {"applicable": bool, "rate_pct": num|null, "breakpoint": str|null, "start": str|null, "end": str|null, "notes": str|null, "section": str|null},
 "sales_reporting": {"reports": bool, "frequency": "Does Not Report"|"Monthly"|"Quarterly"|"Semi-Annually"|"Annually"|str, "section": str|null},
 "cam": {"methodology": str, "includes": {"management_fee": bool|null, "marketing_promo": bool|null, "insurance": bool|null, "roof_repairs": bool|null, "seasonal_decorations": bool|null, "capital_expenses": bool|null},
   "details_exact_language": str, "prorata_share_calc": str, "shopping_center_definition": str, "admin_fee": str, "caps_exclusions": str,
   "audit_rights": bool|null, "audit_years_back": str|null, "section": str},
 "real_estate_tax": {"methodology": str, "sale_reassessment_caps": str|null, "section": str},
 "insurance": {"methodology": str, "section": str},
 "security_deposit": {"exists": bool, "type": "Letter of Credit"|"Cash"|str|null, "total": num|null},
 "tenant_allowance": {"exists": bool, "total": num|null, "psf": num|null},
 "exclusives": {"exists": bool, "exact_language": str|null, "section": str|null},
 "co_tenancy": {"exists": bool, "exact_language_and_remedies": str|null, "replacement_tenants_permitted": str|null, "section": str|null},
 "termination_kickout": {"exists": bool, "details": str|null, "section": str|null},
 "prohibited_uses": {"exact_language": str|null, "section": str|null},
 "permitted_use": {"exact_language": str|null, "section": str|null},
 "relocation_rights": {"exists": bool, "who_pays": str|null, "notes": str|null, "section": str|null},
 "radius_clause": {"exists": bool, "details": str|null, "section": str|null},
 "continuous_operations": {"exists": bool, "details": str|null, "section": str|null},
 "recapture_rights": {"exists": bool, "details": str|null, "section": str|null},
 "parking": {"spaces_per_1000": str|null, "notes": str|null, "section": str|null},
 "assignment_subletting": {"allowed": str|null, "liability_continues_post_assignment": str|null, "notes": str|null, "section": str|null},
 "option_to_purchase": {"exists": bool, "details": str|null, "section": str|null},
 "signage": {"pylon_monument_right": bool|null, "exhibit": str|null, "notes": str|null, "section": str|null},
 "estoppel": {"timing_for_delivery": str|null, "section": str|null},
 "snda": {"timing_for_delivery": str|null, "section": str|null},
 "additional_rights_notes": str|null,
 "open_items": [str]
}`

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    // Runs with the service role + spends AI budget; authorize the caller.
    const caller = await requireUser(req, sb)

    const body = await req.json().catch(() => ({}))
    const propertyId: string = body.property_id ?? ''
    const tenant: string = (body.tenant ?? '').trim()
    if (!propertyId || !tenant) throw new Error('property_id and tenant are required')
    if (!canReadProperty(caller, propertyId)) throw new AuthError('No access to this property', 403)

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')

    // ── 1. Tenant documents at this property ──
    // Candidate needles handle the ways lease-model names diverge from file
    // names: store numbers ("Old Navy #4885"), legal suffixes ("HomeGoods,
    // Inc."), &/and swaps ("AT AND T" vs "AT&T"), stray apostrophes ("Cafe'").
    const addVariants = (cands: Set<string>, seed: string) => {
      // accent folding: MRI says "Café", the file system almost always "Cafe"
      for (const s of new Set([seed, seed.normalize('NFD').replace(/[\u0300-\u036f]/g, '')])) {
        const c = ilikeSafe(s).trim()
        if (c.length < 3) continue
        cands.add(c)
        const noApos = c.replace(/'/g, '').trim()
        if (noApos.length >= 3) cands.add(noApos)
        // concatenated form bridges "Salt Grass" ↔ "Saltgrass"
        const concat = noApos.replace(/\s+/g, '')
        if (/\s/.test(noApos) && concat.length >= 6) cands.add(concat)
        for (const v of [c, noApos]) {
          if (/&/.test(v)) cands.add(v.replace(/\s*&\s*/g, ' and '))
          if (/\band\b/i.test(v)) {
            cands.add(v.replace(/\s+and\s+/gi, ' & '))
            cands.add(v.replace(/\s+and\s+/gi, '&'))
          }
        }
      }
    }
    const buildRe = (candList: string[]) => {
      const rexParts = candList.map(c =>
        c.split(/\s+/)
          .map(tok => tok.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, ''))
          .filter(Boolean)
          .map(tok => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^a-zA-Z0-9]+')
      ).filter(p => p.length > 0)
      return new RegExp(`\\b(?:${rexParts.join('|')})`, 'i')
    }

    // Trailing MRI billing codes ("BANK OF AMERICA PNY53240000") are not part
    // of the file-system name — drop code-like trailing tokens before the
    // digit strip (which would otherwise leave an orphan "PNY" that matches
    // nothing on disk).
    const noCodes = tenant.replace(/\s+[A-Za-z]{0,4}\d{3,}[A-Za-z0-9]*\s*$/g, '')
    const rawBase = noCodes.replace(/#\S+/g, '').replace(/\d{3,}/g, '')
    const noSuffixRaw = rawBase.replace(/[,.]?\s+(inc|llc|l\.l\.c|ltd|lp|llp|corp|corporation|co|company)\.?$/i, '')
    const cands = new Set<string>()
    addVariants(cands, rawBase)
    addVariants(cands, noSuffixRaw)
    if (!cands.size) throw new Error('tenant name too short to match')

    // ── Lease-model row FIRST: it carries file_aliases (folder names that
    // diverge from the MRI trade name — renamed practices, assignments) which
    // must feed the document search needles.
    const { data: leaseRows } = await sb.from('leases')
      .select('status, commencement_date, expiration_date, leased_sf, security_deposit, ti_allowance, has_percentage_rent, percentage_rent_rate, natural_breakpoint, artificial_breakpoint, has_exclusives, has_co_tenancy_clause, has_radius_restriction, tenants!inner(name, trade_name, file_aliases), units(unit_number)')
      .eq('property_id', propertyId)
    const nameRe = buildRe([...cands])
    const leaseRowFull = ((leaseRows ?? []) as any[]).find(l => {
      const n = (l.tenants?.name ?? '') + ' ' + (l.tenants?.trade_name ?? '')
      return nameRe.test(n)
    })
    for (const alias of (leaseRowFull?.tenants?.file_aliases ?? []) as string[]) addVariants(cands, alias)
    // strip file_aliases from the cross-check payload the model sees
    const leaseRow = leaseRowFull
      ? { ...leaseRowFull, tenants: { name: leaseRowFull.tenants?.name, trade_name: leaseRowFull.tenants?.trade_name } }
      : null

    const candList = [...cands]
    const orExpr = candList.flatMap(c => [`title.ilike.%${c}%`, `file_path.ilike.%${c}%`]).join(',')
    const { data: tdocs, error: dErr } = await sb.from('documents')
      .select('id, doc_type, title, file_name, file_path, storage_path, file_size_bytes')
      .eq('property_id', propertyId)
      .or(orExpr)
      .limit(160)
    if (dErr) throw new Error('document search failed: ' + dErr.message)

    // Whole-word-ish match: tokens may be separated by ANY punctuation run
    // ("Homegoods, Inc" matches candidate "HomeGoods Inc").
    const wordRe = buildRe(candList)
    const score = (d: any) => {
      let s = 0
      const path = (d.file_path ?? '').toLowerCase()
      const title = (d.title ?? '').toLowerCase()
      const both = title + ' ' + path
      if (path.includes('\\tenants\\')) s += 4
      if (d.doc_type === 'lease') s += 5
      if (/\b(lse|lease)\b/.test(title) || /\blse-/.test(path)) s += 3
      if (/\blse-/.test(path)) s += 2                          // LSE- files are the instruments themselves
      if (/\b(amd|amendment|modification)\b/.test(both)) s += 3
      // Later amendments carry the CURRENT terms — rank 4th > 3rd > … so the
      // attachment budget always covers the top of the governing stack.
      const ord = both.match(/\b(1st|first|2nd|second|3rd|third|4th|fourth|5th|fifth|6th|sixth)\b[^.]{0,40}?\b(amd|amendment)\b|\b(amd|amendment)[- ]?(1st|first|2nd|second|3rd|third|4th|fourth|5th|fifth|6th|sixth)\b/)
      if (ord) {
        const o = ord[0]
        s += /6th|sixth/.test(o) ? 6 : /5th|fifth/.test(o) ? 5 : /4th|fourth/.test(o) ? 4 : /3rd|third/.test(o) ? 3 : /2nd|second/.test(o) ? 2 : 1
      }
      if (/\b(guaranty|snda|estoppel|commencement|assignment)\b/.test(both)) s += 1
      if (/unexecuted|draft|redline|blackline/.test(both)) s -= 5   // never spend attach budget on drafts
      if (/control sheet/.test(both)) s -= 3
      return s
    }
    const docs = ((tdocs ?? []) as any[])
      .filter(d => wordRe.test(d.title ?? '') || wordRe.test(d.file_path ?? ''))
      .map(d => ({ ...d, s: score(d) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
    if (!docs.length) throw new Error(`No documents found for "${tenant}" at this property`)

    // Heavy-job guard: a lease with a long instrument stack (many amendments +
    // ancillary docs) can push a single generation past the edge runtime's hard
    // 150s wall (e.g. Ross Dress for Less, 30 docs — timed out even at 2 PDFs).
    // When the matched set is large, trim the FULL-TEXT payload to the top-scored
    // governing instruments and lighten default PDF attachments; the amendment-
    // ordinal scorer already floats the controlling lease+amendments to the top.
    // Overridable with body.max_docs / body.max_pdfs.
    // Two tiers: 'heavy' trims text + PDFs; 'veryHeavy' additionally drops native
    // PDF attachment entirely (text-only). Native PDF parsing of large scanned
    // instruments is the dominant latency — Ross (30 docs) timed out at ~151s even
    // with 2 PDFs, but completed in 69s text-only. Text-only forfeits primary-source
    // PDF grounding for these extreme stacks, the only way to finish inside 150s.
    const heavy = docs.length > 18
    const veryHeavy = docs.length > 25
    const md = Number(body.max_docs)
    const TEXT_DOC_CAP = Number.isFinite(md) ? Math.max(1, md) : (veryHeavy ? 10 : heavy ? 14 : 30)
    const EFF_CHAR_BUDGET = veryHeavy ? 180_000 : heavy ? 220_000 : CHAR_BUDGET
    const textDocs = docs.slice(0, TEXT_DOC_CAP)

    // ── 2. Full text of the top documents, lease/amendments first, capped ──
    const { data: chunks } = await sb.from('document_chunks')
      .select('document_id, chunk_index, content')
      .in('document_id', textDocs.map(d => d.id))
      .order('chunk_index')
    const byDoc = new Map<string, string[]>()
    for (const c of (chunks ?? []) as any[]) {
      if (!byDoc.has(c.document_id)) byDoc.set(c.document_id, [])
      byDoc.get(c.document_id)!.push(c.content ?? '')
    }
    // Per-doc cap: since the OCR/verbatim-text layer landed, one instrument's
    // full text can run 100K+ chars and starve the rest of the tenant file
    // (Kay Jewelers: the superseded 2012 amendment chain consumed the whole
    // budget and the governing 2016 lease never made it in). Cap each doc so
    // the budget always covers BREADTH across the instrument stack; the model
    // still gets the operative sections (front matter, defined terms, rent
    // schedule) of every top-scored document.
    const PER_DOC_CAP = Math.min(60_000, Math.floor(EFF_CHAR_BUDGET / 6))
    let used = 0
    const parts: string[] = []
    const usedDocIds: string[] = []
    for (const d of textDocs) {
      const text = (byDoc.get(d.id) ?? []).join('\n')
      if (!text) continue
      const room = EFF_CHAR_BUDGET - used
      if (room < 2000) break
      const slice = text.slice(0, Math.min(room, PER_DOC_CAP))
      const clipped = text.length > slice.length ? `\n[…document truncated at ${slice.length.toLocaleString()} of ${text.length.toLocaleString()} chars]` : ''
      parts.push(`===== DOCUMENT: "${d.title ?? d.file_name}" (type: ${d.doc_type}) =====\n${slice}${clipped}`)
      used += slice.length
      usedDocIds.push(d.id)
    }

    // ── 2b. Primary sources: attach the governing PDFs (base lease + every
    // amendment the scorer surfaced) when mirrored and small enough for native
    // reading. Grounds exact language and section cites in the real lease
    // rather than extraction summaries. Budget: ≤5 docs, ≤8MB each, ≤20MB
    // total (native-PDF page cap safeguarded by the text-only retry below).
    const MAX_ATTACH_BYTES = 8_000_000
    const MAX_ATTACH_TOTAL = 20_000_000
    // body.max_pdfs caps attachments for heavyweight files whose 5-PDF runs
    // exceed the edge function's 150s idle limit (e.g. multi-piece OCR leases).
    const mp = Number(body.max_pdfs)
    const MAX_ATTACH_DOCS = Number.isFinite(mp) ? Math.max(0, Math.min(mp, 5)) : (veryHeavy ? 0 : heavy ? 2 : 5)
    let attachBytes = 0
    const attachable: any[] = []
    for (const d of docs) {
      if (attachable.length >= MAX_ATTACH_DOCS) break
      if (typeof d.storage_path !== 'string' || !d.storage_path.startsWith('p/')) continue
      const sz = Number(d.file_size_bytes)
      if (!(sz > 0) || sz > MAX_ATTACH_BYTES || attachBytes + sz > MAX_ATTACH_TOTAL) continue
      attachable.push(d)
      attachBytes += sz
    }
    let attachments: any[] = []
    if (attachable.length) {
      const { data: signedUrls } = await sb.storage.from('documents')
        .createSignedUrls(attachable.map((d: any) => d.storage_path), 3600)
      attachments = (signedUrls ?? [])
        .filter((s: any) => s.signedUrl)
        .map((s: any) => ({ type: 'document', source: { type: 'url', url: s.signedUrl } }))
    }

    // ── 3. Generate the abstract ──
    const attachNote = attachments.length
      ? `\nThe ${attachments.length} attached PDF(s) are PRIMARY SOURCES (${attachable.map((d: any) => `"${d.title ?? d.file_name}"`).join(', ')}) — ground exact language and section citations in them; the text excerpts below supplement with amendments/letters.`
      : ''
    // FILE INVENTORY: every matched document with how it is presented in this
    // request. Grounds the model's "missing document" claims — it must never
    // say a doc was "not provided" when the doc is in the tenant's file.
    // (If the stepped retry below drops attachments, a few FULL-PDF labels may
    // overstate — rare and preferable to rebuilding the prompt mid-retry.)
    const attachedIds = new Set(attachable.map((d: any) => d.id))
    const summarizedIds = new Set(usedDocIds)
    const inventory = docs.map((d: any) => {
      const how = attachedIds.has(d.id) ? 'FULL PDF ATTACHED'
        : summarizedIds.has(d.id) ? 'in file — summary text included below'
        : 'in file — title only (text not included in this request)'
      return `- "${d.title ?? d.file_name}" [${d.doc_type}] — ${how}`
    }).join('\n')

    // Property-level instruments (REAs/OEAs/declarations) live outside tenant
    // folders — leases reference them constantly. List them so the model cites
    // "on file at property level" instead of claiming they are missing.
    const { data: reas } = await sb.from('rea_agreements')
      .select('name, agreement_date, source_docs')
      .eq('property_id', propertyId)
    const reaInventory = ((reas ?? []) as any[]).map((r: any) => {
      const docsList = ((r.source_docs ?? []) as any[]).map((d: any) => d.title).join('; ')
      return `- ${r.name} (${r.agreement_date ?? 'undated'})${docsList ? ` — documents on file: ${docsList}` : ''}`
    }).join('\n')
    const prompt = `You are a commercial real estate lease abstractor for M&J Wilkow. Produce a lease abstract for tenant "${tenant}" following the firm's Lease Abstract Template, using ONLY the attached documents and text below.${attachNote}

FILE INVENTORY (every document in this tenant's file that matched the search):
${inventory}
${reaInventory ? `\nPROPERTY-LEVEL INSTRUMENTS ON FILE (REAs/OEAs/declarations held at property level, outside tenant folders — when the lease references one of these, cite it as "on file at property level", NOT as missing):\n${reaInventory}\n` : ''}
Abstraction method (firm standard):
- THE LATEST AMENDMENT IS THE LEASE. Establish the amendment chain from recitals, then abstract CURRENT effective terms newest-instrument-first, falling back to older instruments only for unamended provisions. Note superseded terms in notes fields.
- SOURCE HIERARCHY when instruments disagree on a term: trust the EXECUTED, binding instrument over secondary or derived documents. Authority order, highest first: (1) the lease and its executed amendments, and executed Commencement-Date / Lease-Commencement Agreements (these FIX otherwise-formula-based dates and rent-start — prefer them over the base lease's projected/estimated schedule); (2) executed guaranties, assignments, SNDAs, and estoppel certificates signed by the parties; (3) landlord-prepared summaries, CAM/RET reconciliations, rent rolls, control sheets. NEVER let an estoppel, reconciliation, or rent roll override an executed lease instrument. Example: if an executed Commencement Date Agreement states expiration 2028-12-31 and an estoppel or CAM recon implies 2026-12-31, abstract 2028-12-31 and flag the conflict in open_items ("DISCREPANCY: …").
- MRI IS A CROSS-CHECK, NOT A SOURCE. The system-of-record row below is provided ONLY to flag disagreements. NEVER populate an abstract field (dates, square_footage, rent, party names) with a value that comes only from MRI and is not stated in the documents — use the DOCUMENTED value, or null plus a "CONFIRM: …" open item. When MRI and the documents disagree, abstract the DOCUMENTED value and add "DISCREPANCY: MRI says X, documents say Y".
- GUARANTOR: set guarantor.exists=true and a guarantor.name ONLY if an executed guaranty, or a guaranty provision naming the guarantor, actually appears in the file. Do NOT infer a guarantor from a franchise/parent relationship or the tenant's trade name. If none is in the file, guarantor.exists=false (or null) + "MISSING FROM FILE: guaranty" if the lease references one.
- Track the assignment chain — assignments can change the tenant legal name and guaranty survival.
- MULTIPLE SEQUENTIAL TENANCIES: a tenant file may contain a PRIOR tenant's complete lease chain for the same space (a superseded tenancy — different legal tenant, older base lease that ended) alongside the CURRENT tenancy's lease. Abstract the CURRENT tenancy: the newest base lease and its amendments/CDA/option notices, using the system-of-record cross-check (commencement/expiration) to identify which chain is operative. This rule OVERRIDES attachment primacy — if the attached PDFs happen to belong to the prior tenancy, abstract the current tenancy from its text excerpts anyway, note the prior tenancy briefly in additional_rights_notes, and flag any of the current chain's instruments that need fuller review in open_items.
- Before submitting, run consistency checks and flag failures as DISCREPANCY items: commencement + term length vs. expiration; monthly rent × 12 vs. annual; annual vs. PSF × SF; option windows sequential and after the current term.

GROUNDING — NO FABRICATION (critical): every concrete value you output — a date, dollar amount, PSF, party/legal name, lender, guarantor, document title, or section cite — MUST be traceable to the attached PDFs or the text excerpts below. NEVER invent, estimate, or supply a plausible-looking value the documents do not state. In particular for ancillary instruments (SNDA, estoppel certificate, guaranty, assignment, commencement-date agreement, CAM reconciliation): do NOT emit a date, lender, or counterparty you did not read verbatim in the provided materials. If the lease merely references such an instrument but its executed copy is not in the FILE INVENTORY, leave the related fields null/false and add a "MISSING FROM FILE: …" line — do not fabricate its details. If a value is derived rather than stated (e.g. an expiration computed from a commencement-date formula), say so in the relevant notes/section field and flag it "CONFIRM: …" rather than presenting it as a firm figure.

Document-claim discipline for "open_items" (each entry MUST start with exactly one prefix):
- "MISSING FROM FILE: …" — ONLY for an instrument that reviewed documents reference (recitals, exhibit lists, estoppels) but that does NOT appear in the FILE INVENTORY above. Name the instrument and its date.
- "NOT FULLY REVIEWED: …" — for a document that IS in the inventory but was presented as summary/title only, when its full text is needed to confirm a term. Never describe these as "not provided" or "not received" — they are in the file.
- "CONFIRM: …" — a term that should be verified against MRI or ancillary documents.
- "DISCREPANCY: …" — conflicting values between instruments or vs. the system-of-record cross-check.

Rules:
- Call the submit_abstract tool with an object matching this schema exactly (all keys present):
${SCHEMA}
- "section" fields: cite the lease/amendment section or article (e.g. "§6.1.3(j)" or "Art. 24; 2nd Amd §3").
- Where the template asks for exact language (CAM details, exclusives, co-tenancy, prohibited/permitted use), QUOTE the operative language verbatim (trim boilerplate; keep remedies).
- base_rent_schedule — CURRENT CONTROLLING SCHEDULE ONLY. Use the rent table from the LATEST instrument that sets or resets rent (newest amendment / executed Commencement-Date Agreement / exercised-option notice). If a later instrument REPLACES or DELETES an earlier rent schedule, do NOT carry the superseded rows into base_rent_schedule — reference them, only if useful, in additional_rights_notes as "superseded by <instrument>". Never invent, interpolate, or pad a row to fill a gap; every row's start/end/psf/monthly/annual MUST trace to the controlling instrument. If the controlling schedule can't be fully read, list only the substantiated rows and add "NOT FULLY REVIEWED: base rent schedule …" to open_items — do not backfill with older/original-lease rows.
- Any item the documents do not address: use null/false and add a prefixed line to "open_items".
- lease_documents: list ONLY instruments actually present in the FILE INVENTORY or quoted in the reviewed text, each with the date AS STATED in that document. Do NOT create an entry (with a guessed date) for an instrument you did not actually see — a referenced-but-absent SNDA/estoppel/guaranty/assignment belongs in open_items as "MISSING FROM FILE: …", never in lease_documents with an invented date. Use "?" for signed when execution cannot be confirmed from the copy on hand.
- estoppel.timing_for_delivery / snda.timing_for_delivery are the DELIVERY-TIMING REQUIREMENTS from the lease clause (e.g. "within 10 days of request"), NOT the date of any executed estoppel/SNDA. Leave null if the lease is silent; never put a fabricated execution date here.
${leaseRow ? `\nSystem-of-record cross-check (MRI-reconciled; flag disagreements in open_items): ${JSON.stringify(leaseRow)}` : ''}

DOCUMENTS:
${parts.join('\n\n')}`

    // Reduce the text budget when PDFs are attached (context headroom).
    const textPrompt = attachments.length && used > 150_000
      ? prompt.slice(0, prompt.length - used + 150_000)
      : prompt
    // Stepped degradation: all attachments → top 2 → text-only. PDFs can blow
    // the native 100-page/context caps; each step keeps as much primary source
    // as fits.
    const isCapError = (e: unknown) =>
      /page|too long|too large|exceed|prompt is too long/i.test(e instanceof Error ? e.message : String(e))
    let abstract: any
    try {
      abstract = await anthropicJson(anthropicKey, MODEL, [...attachments, { type: 'text', text: textPrompt }], 16000)
    } catch (e) {
      if (!attachments.length || !isCapError(e)) throw e
      if (attachments.length > 2) {
        try {
          attachments = attachments.slice(0, 2)
          abstract = await anthropicJson(anthropicKey, MODEL, [...attachments, { type: 'text', text: textPrompt }], 16000)
        } catch (e2) {
          if (!isCapError(e2)) throw e2
          abstract = await anthropicJson(anthropicKey, MODEL, [{ type: 'text', text: prompt }], 16000)
          attachments = []
        }
      } else {
        abstract = await anthropicJson(anthropicKey, MODEL, [{ type: 'text', text: prompt }], 16000)
        attachments = []
      }
    }

    // ── 4. Upsert ──
    const { error: upErr } = await sb.from('lease_abstracts').upsert({
      property_id: propertyId,
      tenant_name: tenant,
      status: 'complete',
      abstract,
      source_doc_ids: usedDocIds,
      model: MODEL,
      error: null,
      // A fresh abstract invalidates any prior verification verdict.
      qa: null,
      qa_status: null,
      qa_at: null,
      qa_model: null,
      generated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'property_id,tenant_name' })
    if (upErr) throw new Error('save failed: ' + upErr.message)

    return new Response(JSON.stringify({
      success: true, tenant, property_id: propertyId,
      docs_used: usedDocIds.length, chars_used: used, pdf_sources: attachments.length, abstract,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
