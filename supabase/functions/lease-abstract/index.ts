// lease-abstract — generates a Wilkow-template lease abstract for one tenant.
// v2 "brief synthesis" architecture (docs/abstraction-standard.md):
//
//   Stage 1 (doc-brief fn, separate): every document in the tenant's file gets
//   a structured brief extracted from 100% of its text — no truncation.
//   Stage 2 (THIS fn): synthesize the abstract from those briefs + the FULL
//   file inventory + MRI cross-checks (leases, lease_options notice deadlines,
//   latest rent roll) + property-level instruments (REAs, PMA).
//
// Why briefs: the v1 single-call design truncated each document at ~60K chars,
// which produced "NOT FULLY REVIEWED" on 91/98 abstracts and guessed terms.
// Briefs make every instrument fully-read; synthesis reasons over compact
// structured extractions instead of raw text.
//
// Unbriefed documents degrade gracefully: their raw text is included (bounded)
// exactly like v1, and the model is told which docs those are.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.
// Usage: POST JSON { property_id: uuid, tenant: string, max_pdfs?: number }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canReadProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

const MODEL = Deno.env.get('ABSTRACT_MODEL') ?? 'claude-sonnet-5'
const BRIEF_BUDGET = 300_000      // chars of brief JSON included in full
const RAWTEXT_BUDGET = 150_000    // chars of raw text for unbriefed docs
const RAW_PER_DOC_CAP = 40_000

const ilikeSafe = (s: string) => s.replace(/[(),%_]/g, ' ').replace(/\s+/g, ' ').trim()

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
  // Some generations wrap the payload in an envelope key despite the schema —
  // observed variants: {"abstract": {...}} and literal placeholder keys
  // {"$PARAMETER_NAME"/"$PARAMETER_VALUE": {...}}. Unwrap generically: if the
  // top level doesn't look like the abstract but exactly one child does, use
  // the child; if nothing looks right, THROW so the caller retries instead of
  // storing an empty abstract.
  const looksLikeAbstract = (o: any) =>
    o && typeof o === 'object' && !Array.isArray(o) && ('trade_name' in o || 'term' in o || 'lease_documents' in o)
  let out = block.input ?? {}
  if (!looksLikeAbstract(out)) {
    const kids = Object.values(out).filter(looksLikeAbstract)
    if (kids.length === 1) out = kids[0]
  }
  if (!looksLikeAbstract(out)) throw new Error('Model returned a malformed abstract envelope — retry')
  return out
}

// Template schema v2 — a SUPERSET of v1 so the renderer/exports/clause matrix
// keep working on old abstracts. New in v2: date provenance (basis fields,
// bare-ISO date discipline), option lifecycle (notice_by/status/exercise
// evidence), guaranty_chain, exclusives split from use restrictions binding
// the tenant, document categories, rea_pma, critical_dates.
const SCHEMA = `{
 "trade_name": str, "tenant_legal_name": str, "suite": str, "square_footage": num|null,
 "lease_documents": [{"type": str, "category": "operative"|"ancillary", "date": "YYYY-MM-DD"|str, "signed": "Y"|"N"|"partial"|"?", "notes": str}],
 "term": {
   "rent_commencement": "YYYY-MM-DD"|null, "rcd_basis": str|null,
   "original_commencement": "YYYY-MM-DD"|null, "original_commencement_basis": str|null,
   "current_term_start": "YYYY-MM-DD"|null, "current_term_basis": str|null,
   "expiration": "YYYY-MM-DD"|null, "expiration_basis": str|null,
   "term_years": num|null, "section": str
 },
 "guarantor": {"exists": bool, "name": str|null, "details": str|null, "section": str|null},
 "guaranty_chain": [{"event": "original"|"reaffirmed"|"replaced"|"released"|"assignment", "date": "YYYY-MM-DD"|str|null, "instrument": str, "guarantor": str|null, "status": "current"|"released"|"superseded"|"surviving", "notes": str|null}],
 "base_rent_schedule": [{"months": num|null, "start": str, "end": str, "psf": num|null, "monthly": num|null, "annual": num|null}],
 "options": [{"term": str, "status": "open"|"exercised"|"lapsed"|"superseded", "notice_period": str, "notice_by": "YYYY-MM-DD"|null, "notice_by_basis": str|null, "exercise_evidence": str|null, "landlord_reminder_required": bool|null, "start": str|null, "end": str|null, "psf": num|null, "monthly": num|null, "annual": num|null, "section": str}],
 "percentage_rent": {"applicable": bool, "rate_pct": num|null, "breakpoint": str|null, "breakpoint_type": "natural"|"artificial"|null, "start": str|null, "end": str|null, "notes": str|null, "section": str|null},
 "sales_reporting": {"reports": bool, "frequency": "Does Not Report"|"Monthly"|"Quarterly"|"Semi-Annually"|"Annually"|str, "section": str|null},
 "cam": {"methodology": str, "includes": {"management_fee": bool|null, "marketing_promo": bool|null, "insurance": bool|null, "roof_repairs": bool|null, "seasonal_decorations": bool|null, "capital_expenses": bool|null},
   "details_exact_language": str, "prorata_share_calc": str, "shopping_center_definition": str, "admin_fee": str, "caps_exclusions": str,
   "audit_rights": bool|null, "audit_years_back": str|null, "section": str},
 "real_estate_tax": {"methodology": str, "sale_reassessment_caps": str|null, "section": str},
 "insurance": {"methodology": str, "section": str},
 "security_deposit": {"exists": bool, "type": "Letter of Credit"|"Cash"|str|null, "total": num|null},
 "tenant_allowance": {"exists": bool, "total": num|null, "psf": num|null},
 "exclusives": {"exists": bool, "exact_language": str|null, "remedies": str|null, "conditions": str|null, "section": str|null},
 "use_restrictions_on_tenant": {"exists": bool, "exact_language": str|null, "source_exhibit": str|null, "section": str|null},
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
 "estoppel": {"timing_for_delivery": str|null, "executed_on_file": str|null, "section": str|null},
 "snda": {"timing_for_delivery": str|null, "executed_on_file": str|null, "section": str|null},
 "rea_pma": {"subject_to_rea": bool|null, "rea_name": str|null, "tenant_impact": str|null, "pma_manager": str|null, "notes": str|null},
 "critical_dates": [{"date": "YYYY-MM-DD", "event": str, "source": str}],
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
      for (const s of new Set([seed, seed.normalize('NFD').replace(/[̀-ͯ]/g, '')])) {
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

    // ── Lease-model row FIRST: carries file_aliases (folder names that diverge
    // from the MRI trade name) which must feed the document search needles.
    const { data: leaseRows } = await sb.from('leases')
      .select('id, status, commencement_date, expiration_date, leased_sf, security_deposit, ti_allowance, has_percentage_rent, percentage_rent_rate, natural_breakpoint, artificial_breakpoint, has_exclusives, has_co_tenancy_clause, has_radius_restriction, tenants!inner(name, trade_name, file_aliases), units(unit_number)')
      .eq('property_id', propertyId)
    const nameRe = buildRe([...cands])
    const leaseRowFull = ((leaseRows ?? []) as any[]).find(l => {
      const n = (l.tenants?.name ?? '') + ' ' + (l.tenants?.trade_name ?? '')
      return nameRe.test(n)
    })
    for (const alias of (leaseRowFull?.tenants?.file_aliases ?? []) as string[]) addVariants(cands, alias)
    // strip file_aliases + internal id from the cross-check payload the model sees
    const leaseRow = leaseRowFull
      ? { ...leaseRowFull, id: undefined, tenants: { name: leaseRowFull.tenants?.name, trade_name: leaseRowFull.tenants?.trade_name } }
      : null

    // ── MRI option data (system of record for option notice dates — durable
    // rule #4). The v1 abstractor never joined this table, which is why 73/98
    // abstracts had no actual notice-by dates. ──
    let mriOptions: any[] = []
    if (leaseRowFull?.id) {
      const { data: lo } = await sb.from('lease_options')
        .select('option_type, notice_days_required, notice_deadline, exercise_deadline, term_if_exercised_months, rent_at_exercise, is_exercised, requires_landlord_reminder, notes')
        .eq('lease_id', leaseRowFull.id)
      mriOptions = (lo ?? []) as any[]
    }

    // ── Latest MRI rent-roll row (current-term window + RCD evidence) ──
    const { data: rrRows } = await sb.from('rent_roll_rows')
      .select('tenant_name, suite, sqft, lease_start, lease_end, monthly_base_rent, annual_base_rent, created_at')
      .eq('property_id', propertyId)
      .order('created_at', { ascending: false })
      .limit(300)
    const rrRow = ((rrRows ?? []) as any[]).find(r => nameRe.test(r.tenant_name ?? '')) ?? null
    const mriRentRoll = rrRow ? { ...rrRow, created_at: undefined } : null

    const candList = [...cands]
    const orExpr = candList.flatMap(c => [`title.ilike.%${c}%`, `file_path.ilike.%${c}%`]).join(',')
    // v2: pull EVERY match (v1's limit of 160 + top-30 cap silently dropped
    // ancillary instruments in acquisition binders, producing false "MISSING
    // FROM FILE" claims — e.g. BCBS's executed SNDA).
    const { data: tdocs, error: dErr } = await sb.from('documents')
      .select('id, doc_type, title, file_name, file_path, storage_path, file_size_bytes')
      .eq('property_id', propertyId)
      .or(orExpr)
      .limit(500)
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
      if (/\b(guaranty|snda|subordination|estoppel|commencement|supplement|assignment|exercise|renewal)\b/.test(both)) s += 1
      if (/unexecuted|draft|redline|blackline/.test(both)) s -= 5   // never spend attach budget on drafts
      if (/control sheet/.test(both)) s -= 3
      return s
    }
    // A tenant's folder also holds operational material that carries no lease
    // terms: buildout/closeout under \Construction\, plus \Accounting\,
    // \Insurance\, \Correspondence\. Matching the tenant name against file_path
    // sweeps the whole subtree, so these otherwise land in the brief queue
    // (Stage-1 AI cost), the abstract's stored source set (what the reviewer
    // sees), and the audit inventory (false "missing"/"discrepancy" noise). Drop
    // them unless the file is itself a typed lease instrument. The
    // \Lease Documents\ and \Documents\ trees, and files sitting directly under
    // the tenant folder, are unaffected.
    const NON_LEASE_SUBFOLDER = /\\(construction|accounting|insurance|correspondence)\\/i
    const isLeaseRelevant = (d: any) =>
      d.doc_type === 'lease' || !NON_LEASE_SUBFOLDER.test(d.file_path ?? '')
    const docs = ((tdocs ?? []) as any[])
      .filter(d => wordRe.test(d.title ?? '') || wordRe.test(d.file_path ?? ''))
      .filter(isLeaseRelevant)
      .map(d => ({ ...d, s: score(d) }))
      .sort((a, b) => b.s - a.s)
    if (!docs.length) throw new Error(`No documents found for "${tenant}" at this property`)

    // ── 2. Briefs for the matched documents (Stage-1 output) ──
    const { data: briefRows } = await sb.from('doc_briefs')
      .select('document_id, doc_class, chain_role, brief, status, segments_done, segments_total')
      .in('document_id', docs.map(d => d.id))
    const briefBy = new Map<string, any>()
    for (const b of (briefRows ?? []) as any[]) briefBy.set(b.document_id, b)

    const briefed = docs.filter(d => briefBy.get(d.id)?.status === 'complete' && briefBy.get(d.id)?.brief)
    const unbriefed = docs.filter(d => !briefed.includes(d))

    // PLAN MODE: return the matched file + brief coverage without generating,
    // so the caller (UI/batch script) can run Stage 1 (doc-brief) on the
    // unbriefed documents first, then call back for the real synthesis.
    if (body.plan) {
      return new Response(JSON.stringify({
        success: true, plan: true, tenant, property_id: propertyId,
        docs: docs.map(d => ({
          id: d.id, title: d.title ?? d.file_name,
          brief_status: briefBy.get(d.id)?.status ?? 'none',
        })),
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // Order briefed docs for the prompt: operative chain in instrument-date
    // order (the synthesis walks the chain forward), then ancillary, then the
    // rest as one-line inventory entries.
    const cls = (d: any) => briefBy.get(d.id)?.doc_class ?? 'other'
    const briefDate = (d: any) => briefBy.get(d.id)?.brief?.instrument_date ?? briefBy.get(d.id)?.brief?.effective_date ?? ''
    const operative = briefed.filter(d => cls(d) === 'operative_instrument')
      .sort((a, b) => String(briefDate(a)).localeCompare(String(briefDate(b))))
    const ancillary = briefed.filter(d => ['ancillary_executed', 'property_level'].includes(cls(d)))
      .sort((a, b) => String(briefDate(a)).localeCompare(String(briefDate(b))))
    const background = briefed.filter(d => !operative.includes(d) && !ancillary.includes(d))

    // Full brief JSON for operative+ancillary within budget; compact lines for
    // background docs (their briefs exist — the model can request nothing, but
    // key_facts keep material events like uncured defaults visible).
    let briefChars = 0
    const briefBlocks: string[] = []
    const briefIncluded = new Set<string>()
    for (const d of [...operative, ...ancillary]) {
      const b = briefBy.get(d.id)
      const json = JSON.stringify(b.brief)
      if (briefChars + json.length > BRIEF_BUDGET) break
      briefBlocks.push(`===== BRIEF: "${d.title ?? d.file_name}" [${b.doc_class}/${b.chain_role}] =====\n${json}`)
      briefChars += json.length
      briefIncluded.add(d.id)
    }
    const backgroundLines = background.map(d => {
      const b = briefBy.get(d.id)
      const kf = Array.isArray(b?.brief?.key_facts) ? b.brief.key_facts.slice(0, 3).join(' | ') : ''
      return `- "${d.title ?? d.file_name}" [${b.doc_class}/${b.chain_role}${b.brief?.instrument_date ? ` ${b.brief.instrument_date}` : ''}]${kf ? ` — ${kf}` : ''}`
    }).join('\n')

    // ── 2b. Raw-text fallback for unbriefed docs (v1 behavior, bounded).
    // Top-scored unbriefed docs get text so a tenant can be abstracted before
    // Stage 1 has swept the file; the prompt names them explicitly.
    const { data: chunks } = unbriefed.length ? await sb.from('document_chunks')
      .select('document_id, chunk_index, content')
      .in('document_id', unbriefed.slice(0, 12).map(d => d.id))
      .order('chunk_index') : { data: [] as any[] }
    const byDoc = new Map<string, string[]>()
    for (const c of (chunks ?? []) as any[]) {
      if (!byDoc.has(c.document_id)) byDoc.set(c.document_id, [])
      byDoc.get(c.document_id)!.push(c.content ?? '')
    }
    let rawUsed = 0
    const rawParts: string[] = []
    const rawIncluded = new Set<string>()
    for (const d of unbriefed) {
      const text = (byDoc.get(d.id) ?? []).join('\n')
      if (!text) continue
      const room = RAWTEXT_BUDGET - rawUsed
      if (room < 2000) break
      const slice = text.slice(0, Math.min(room, RAW_PER_DOC_CAP))
      const clipped = text.length > slice.length ? `\n[…truncated at ${slice.length.toLocaleString()} of ${text.length.toLocaleString()} chars — brief this document for full coverage]` : ''
      rawParts.push(`===== RAW TEXT (no brief yet): "${d.title ?? d.file_name}" (type: ${d.doc_type}) =====\n${slice}${clipped}`)
      rawUsed += slice.length
      rawIncluded.add(d.id)
    }

    // source_doc_ids: everything that materially informed this abstract.
    const usedDocIds = [...briefIncluded, ...rawIncluded]

    // ── 2c. Primary-source PDFs: attach the top operative instruments when
    // mirrored and small enough, grounding exact language & section cites. ──
    const MAX_ATTACH_BYTES = 8_000_000
    const MAX_ATTACH_TOTAL = 20_000_000
    const mp = Number(body.max_pdfs)
    const MAX_ATTACH_DOCS = Number.isFinite(mp) ? Math.max(0, Math.min(mp, 5)) : 3
    let attachBytes = 0
    const attachable: any[] = []
    for (const d of [...operative].reverse().concat(docs)) {   // newest operative first, then best-scored
      if (attachable.length >= MAX_ATTACH_DOCS) break
      if (attachable.includes(d)) continue
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

    // ── 3. Inventories & property-level context ──
    // FILE INVENTORY: EVERY matched document — the ground for any "missing"
    // claim. A doc listed here is IN THE FILE, full stop.
    const attachedIds = new Set(attachable.map((d: any) => d.id))
    const inventory = docs.map((d: any) => {
      const b = briefBy.get(d.id)
      const how = attachedIds.has(d.id) ? 'FULL PDF ATTACHED'
        : briefIncluded.has(d.id) ? 'structured brief included below'
        : rawIncluded.has(d.id) ? 'raw text included below (no brief yet)'
        : b?.status === 'complete' ? 'brief on file (summarized above)'
        : 'in file — title only in this request'
      return `- "${d.title ?? d.file_name}" [${d.doc_type}${b?.doc_class ? ` · ${b.doc_class}` : ''}] — ${how}`
    }).join('\n')

    // Property-level instruments (REAs/OEAs, PMA) — leases reference them
    // constantly; they are "on file at property level", never missing.
    const { data: reas } = await sb.from('rea_agreements')
      .select('name, agreement_date, operator, members, term_summary, key_provisions')
      .eq('property_id', propertyId)
    const reaInventory = ((reas ?? []) as any[]).map((r: any) => {
      const prov = typeof r.key_provisions === 'string' ? r.key_provisions.slice(0, 600)
        : r.key_provisions ? JSON.stringify(r.key_provisions).slice(0, 600) : ''
      return `- ${r.name} (${r.agreement_date ?? 'undated'})${r.operator ? ` — operator: ${r.operator}` : ''}${r.members ? ` — members: ${typeof r.members === 'string' ? r.members : JSON.stringify(r.members)}` : ''}${prov ? `\n  key provisions: ${prov}` : ''}`
    }).join('\n')
    const { data: pmas } = await sb.from('management_agreements')
      .select('manager_name, sub_manager_name, mgmt_fee_pct, term_start, term_end, is_current')
      .eq('property_id', propertyId)
      .eq('is_current', true)
    const pmaLine = ((pmas ?? []) as any[]).map((m: any) =>
      `${m.manager_name}${m.sub_manager_name ? ` / ${m.sub_manager_name}` : ''} — mgmt fee ${m.mgmt_fee_pct != null ? (m.mgmt_fee_pct * 100).toFixed(2) + '%' : '?'}${m.term_start ? `, term ${m.term_start}→${m.term_end ?? 'evergreen'}` : ''}`
    ).join('; ')

    // ── 4. Synthesis prompt (distilled from docs/abstraction-standard.md) ──
    const attachNote = attachments.length
      ? `\nThe ${attachments.length} attached PDF(s) are PRIMARY SOURCES (${attachable.map((d: any) => `"${d.title ?? d.file_name}"`).join(', ')}) — ground exact language and section citations in them.`
      : ''
    const prompt = `You are a commercial real estate lease abstractor for M&J Wilkow producing a lease abstract for tenant "${tenant}" per the firm's Abstraction Standard. Synthesize from the structured DOCUMENT BRIEFS below (each extracted from 100% of that document's text), the raw text of unbriefed documents, and the attached PDFs.${attachNote}

FILE INVENTORY (every document in this tenant's file that matched the search — a document listed here IS IN THE FILE):
${inventory}
${backgroundLines ? `\nBACKGROUND DOCUMENTS (briefed; correspondence/financial — NOT lease documents, corroboration only):\n${backgroundLines}\n` : ''}
${reaInventory ? `\nPROPERTY-LEVEL INSTRUMENTS ON FILE (REAs/OEAs/declarations — cite as "on file at property level", NEVER as missing):\n${reaInventory}\n` : ''}${pmaLine ? `\nPROPERTY MANAGEMENT AGREEMENT (current): ${pmaLine}\n` : ''}
ABSTRACTION METHOD (firm standard — binding):
1. THE LATEST AMENDMENT IS THE LEASE. Establish the amendment chain from the briefs' chain/recitals, then abstract CURRENT effective terms newest-instrument-first, falling back to older instruments only for unamended provisions. Note superseded terms in notes fields only.
2. SOURCE HIERARCHY when instruments disagree: (1) executed lease/amendments + executed Commencement Date Agreements/Lease Supplements/Acknowledgments (these FIX formula dates); (2) executed option-exercise notices (they roll the term); (3) executed guaranties, assignments, SNDAs, estoppels; (4) MRI system of record (see date rules); (5) landlord summaries/CAM recons/control sheets/correspondence — corroboration only, never override 1-4.
3. DATE DISCIPLINE — every date field holds a bare ISO date (YYYY-MM-DD) or null; NEVER prose, parentheticals, or formulas inside a date field. Provenance goes in the companion *_basis field ("Fourth Amendment §2.A", "executed Lease Supplement 2012-08-24", "MRI system of record", "estoppel (corroboration)").
   - rent_commencement (RCD): use an executed CDA/Lease Supplement/Acknowledgment if one is in the file; OTHERWISE USE THE MRI RCD from the system-of-record/rent-roll payload below with rcd_basis "MRI system of record". A lease-formula projection ("X days after delivery") is NEVER presented as the RCD — mention it only in rcd_basis or open_items if it materially contradicts MRI.
   - original_commencement = start of the initial term (documents). current_term_start = start of the CURRENT term segment (MRI governs; typically the latest renewal/extension start). These are different fields — do not conflate, do not flag their difference as a discrepancy.
   - expiration: latest executed instrument that extends/resets the term; cross-check MRI current-term end; disagreement → "DISCREPANCY:" open item naming both values.
4. OPTIONS ARE A LIFECYCLE: granted → exercised/lapsed/renegotiated → term rolls. For each option: status ("exercised" when an executed exercise notice is in the file, an amendment recites exercise, or MRI shows the rolled term — cite which in exercise_evidence; "superseded" when a later amendment voids/regrants it; otherwise "open"). notice_by = the hard date notice is due: prefer the MRI notice_deadline from the payload below (system of record, durable rule), else compute from the notice period and term end; state which in notice_by_basis and add "DISCREPANCY:" if your computation and MRI materially disagree. An exercised option's period IS the current term — do not list it as a future option. Set landlord_reminder_required=true when the lease obliges LANDLORD to notify the tenant of the window.
5. GUARANTY CHAIN: build guaranty_chain from every guaranty creation/reaffirmation/replacement/release and every assignment (assignor released or surviving? replacement guaranty delivered?). Silence in an assignment = assignor/guarantor NOT released (market standard) — status "surviving", note the silence. guarantor.name = the CURRENT guarantor(s) derived from the chain. Never infer a guarantor from a franchise/parent relationship; only executed guaranties or instruments reciting one.
6. EXCLUSIVES DISCIPLINE — three different things: permitted_use = what THIS tenant may do. exclusives = the tenant's OWN protection (a covenant restricting LANDLORD/other occupants for this tenant's benefit) — quote the operative language AND the remedies (rent abatement %, alternative rent, termination) and conditions (operating, not in default). use_restrictions_on_tenant = OTHER tenants' exclusives / prohibited-use schedules that BIND this tenant (typically an exhibit — name it in source_exhibit). Never mix these three.
   HARD RULE: exclusives.exists=true REQUIRES exact_language to QUOTE (verbatim, from an operative instrument's brief or PDF) a covenant by which the LANDLORD restricts other occupants/premises. NOT sufficient for exists=true: an MRI note code or has_exclusives flag; a landlord summary/control sheet asserting exclusivity; a paraphrase like "Tenant has exclusive rights to [its own permitted use]"; the tenant's own radius/non-compete covenant (binds TENANT — belongs in radius_clause); demise language ("for Tenant's exclusive use" = possession, not competition protection); a landlord NO-CONFLICT WARRANTY or indemnity about other tenants' exclusives (that protects tenant FROM exclusives — note it in additional_rights_notes, it is not an exclusive). If a flag/summary asserts an exclusive but no covenant can be quoted: exists=false + "CONFIRM: MRI/summary indicates an exclusive-use right but no operative covenant located in the file — obtain the granting instrument".
7. LEASE DOCUMENTS: list ONLY operative instruments (category "operative": lease, amendments, CDA/supplement, assignment, termination, executed exercise notices) and executed ancillary instruments (category "ancillary": guaranty, SNDA, estoppel, MOL, license). NEVER list correspondence, emails, default/past-due notices, force-majeure letters, CAM recons, sales reports, or invoices as lease documents — a material event they evidence (e.g. uncured default) goes in additional_rights_notes with the source named. Dates AS STATED on each instrument. "partial" for signature blocks blank in the copy on hand.
8. REA/PMA: fill rea_pma from the property-level inventory — is the premises subject to an REA (subject_to_rea; the center's REA obligations affect co-tenancy math and CAM denominators)? tenant_impact = how it touches THIS tenant (anchor operating covenants, REA-driven restrictions, CAM contribution structure). pma_manager from the PMA line. If the property has no REA, subject_to_rea=false.
9. CRITICAL DATES: every date creating a future duty or right — option notice_by dates, expiration, kickout windows, co-tenancy cure deadlines, landlord-reminder dates — also goes in critical_dates with its source.
10. base_rent_schedule — CURRENT CONTROLLING SCHEDULE ONLY, from the latest instrument that sets or resets rent. Never carry superseded rows; never invent/interpolate/pad. If the current term's rent isn't stated anywhere in the file, list substantiated rows only + "CONFIRM: current-term rent" in open_items.
11. Before submitting run consistency checks and flag failures as "DISCREPANCY:" items: commencement + term vs expiration; monthly × 12 vs annual; annual vs PSF × SF; option windows sequential and after the current term; breakpoint arithmetic (natural = annual fixed rent ÷ rate).

GROUNDING — NO FABRICATION: every concrete value must be traceable to a brief (whose quotes came from the document), the raw text, or an attached PDF. Values the documents do not state are null + open item. MRI-sourced values are labeled as such in the *_basis fields.

OPEN-ITEM DISCIPLINE (each entry starts with exactly one prefix, then an optional bracketed field tag):
- "MISSING FROM FILE: …" — ONLY for an instrument that reviewed documents reference but that appears NOWHERE in the FILE INVENTORY above. The inventory is the complete file — check it before claiming missing.
- "NOT FULLY REVIEWED: …" — ONLY for a document listed as "title only in this request" or whose raw text was truncated. Documents with briefs were read in full — never mark them not-fully-reviewed.
- "CONFIRM: …" — a term needing verification against a source outside this request.
- "DISCREPANCY: …" — conflicting values between instruments or vs. the MRI cross-check (name both values and both sources).
- FIELD TAG: when an open item concerns a specific abstract field, put its dotted path in brackets immediately after the prefix so the UI can footnote the field, e.g. "DISCREPANCY: [term.expiration] lease says 2030-01-31 but MRI holds 2031-01-31" or "CONFIRM: [base_rent_schedule] current-term rent not stated in the file". Omit the tag for file-level items (missing documents, not-reviewed).

Call the submit_abstract tool with an object matching this schema exactly (all keys present):
${SCHEMA}
- "section" fields cite the instrument + section (e.g. "§6.1.3(j)" or "3rd Amd §5").
- Where the template asks for exact language (CAM, exclusives, co-tenancy, permitted/prohibited use), QUOTE the operative language verbatim from the briefs/PDFs (trim boilerplate; keep remedies).
- MULTIPLE SEQUENTIAL TENANCIES: if the file holds a PRIOR tenant's superseded chain for the same space, abstract the CURRENT tenancy (use the MRI cross-check to identify it), note the prior tenancy briefly in additional_rights_notes.
${leaseRow ? `\nMRI SYSTEM-OF-RECORD CROSS-CHECK (current-term window; governs current-term dates/SF/suite/current rent/pct-rent flag; documents govern deposits/TI/clauses/options-language/guarantor/legal name): ${JSON.stringify(leaseRow)}` : ''}
${mriOptions.length ? `\nMRI OPTION DATA (RETAILRR-verified system of record for option notice dates & exercise state): ${JSON.stringify(mriOptions)}` : ''}
${mriRentRoll ? `\nMRI RENT ROLL (latest load — current term start/end, rent): ${JSON.stringify(mriRentRoll)}` : ''}

DOCUMENT BRIEFS (each extracted from 100% of the document's text; operative chain in date order, then ancillary):
${briefBlocks.join('\n\n')}
${rawParts.length ? `\nRAW TEXT OF UNBRIEFED DOCUMENTS (bounded — flag truncated ones NOT FULLY REVIEWED if needed):\n${rawParts.join('\n\n')}` : ''}`

    // Stepped degradation: all attachments → top 2 → text-only. PDFs can blow
    // the native 100-page/context caps; each step keeps as much primary source
    // as fits.
    const isCapError = (e: unknown) =>
      /page|too long|too large|exceed|prompt is too long/i.test(e instanceof Error ? e.message : String(e))
    let abstract: any
    try {
      abstract = await anthropicJson(anthropicKey, MODEL, [...attachments, { type: 'text', text: prompt }], 20000)
    } catch (e) {
      if (!attachments.length || !isCapError(e)) throw e
      if (attachments.length > 2) {
        try {
          attachments = attachments.slice(0, 2)
          abstract = await anthropicJson(anthropicKey, MODEL, [...attachments, { type: 'text', text: prompt }], 20000)
        } catch (e2) {
          if (!isCapError(e2)) throw e2
          abstract = await anthropicJson(anthropicKey, MODEL, [{ type: 'text', text: prompt }], 20000)
          attachments = []
        }
      } else {
        abstract = await anthropicJson(anthropicKey, MODEL, [{ type: 'text', text: prompt }], 20000)
        attachments = []
      }
    }

    // ── 4b. Deterministic consistency checks (code, not model). The model is
    // told to run these too — this layer catches what it misses and makes the
    // failures machine-visible regardless of model behavior. ──
    const flags: string[] = []
    const isIso = (v: any) => v == null || /^\d{4}-\d{2}-\d{2}$/.test(String(v))
    const term = abstract?.term ?? {}
    for (const [k, v] of Object.entries({
      rent_commencement: term.rent_commencement, original_commencement: term.original_commencement,
      current_term_start: term.current_term_start, expiration: term.expiration,
    })) {
      if (!isIso(v)) flags.push(`DISCREPANCY: term.${k} is not a bare ISO date ("${String(v).slice(0, 60)}…") — dates must be YYYY-MM-DD with provenance in the *_basis field`)
    }
    const sf = Number(abstract?.square_footage)
    const sched = Array.isArray(abstract?.base_rent_schedule) ? abstract.base_rent_schedule : []
    sched.forEach((r: any, i: number) => {
      const m = Number(r?.monthly), a = Number(r?.annual), p = Number(r?.psf)
      if (m > 0 && a > 0 && Math.abs(m * 12 - a) > Math.max(10, a * 0.01)) {
        flags.push(`DISCREPANCY: base_rent_schedule[${i}] monthly×12 (${(m * 12).toFixed(2)}) ≠ annual (${a.toFixed(2)})`)
      }
      if (p > 0 && a > 0 && sf > 0 && Math.abs(p * sf - a) > Math.max(50, a * 0.02)) {
        flags.push(`DISCREPANCY: base_rent_schedule[${i}] PSF×SF (${(p * sf).toFixed(0)}) ≠ annual (${a.toFixed(0)})`)
      }
    })
    // Exclusives hard rule (abstraction-standard §5.1): exists=true demands a
    // substantive quoted covenant that names the restricting party. Paraphrases
    // and MRI-flag-only assertions get machine-flagged for the verifier/human.
    const ex = abstract?.exclusives
    if (ex?.exists === true) {
      const lang = String(ex.exact_language ?? '')
      if (lang.length < 60 || !/landlord|lessor/i.test(lang)) {
        flags.push('DISCREPANCY: exclusives.exists=true but exact_language does not quote a landlord-restricting covenant (paraphrase/flag-only assertion) — per the abstraction standard this must be exists=false + CONFIRM unless the granting covenant is quoted')
      }
    }

    // Every OPEN MRI option notice deadline must surface on an abstract option
    // (MRI RETAILRR = system of record for option notice dates, durable rule).
    const abstractNoticeBys = new Set(
      (Array.isArray(abstract?.options) ? abstract.options : []).map((o: any) => String(o?.notice_by ?? '')))
    for (const o of mriOptions) {
      if (o?.notice_deadline && !o?.is_exercised && !abstractNoticeBys.has(String(o.notice_deadline))) {
        flags.push(`DISCREPANCY: MRI holds an open option notice deadline ${o.notice_deadline} that no abstract option carries as notice_by — reconcile against RETAILRR`)
      }
    }
    if (flags.length) {
      abstract.open_items = [...(Array.isArray(abstract?.open_items) ? abstract.open_items : []), ...flags]
    }

    // ── 5. Upsert ──
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
      docs_matched: docs.length, briefs_used: briefIncluded.size,
      unbriefed_in_file: unbriefed.length, raw_fallback_docs: rawIncluded.size,
      pdf_sources: attachments.length, abstract,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
