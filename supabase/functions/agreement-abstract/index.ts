// agreement-abstract — verified abstracts for property-level instruments
// (REA/OEA/declarations and PMAs), the REA/PMA phase of the abstractor-v2
// program (docs/abstraction-standard.md). Same brief-synthesis architecture as
// lease-abstract v2: every source document is read 100% into a doc_brief
// (Stage 1, doc-brief fn), and this fn SYNTHESIZES the abstract from briefs +
// raw-text fallback for unbriefed docs. agreement-verify runs the adversarial
// second pass.
//
// kind='rea': rea_agreements row; source docs from source_docs[].id.
// kind='pma': management_agreements row; source docs = document_id plus the
//             amends_id ancestor chain's document_ids. The row's structured
//             fields (mgmt_fee_pct, term, notice) ride along as a cross-check.
//
// Usage: POST { kind: 'rea'|'pma', id: uuid, plan?: boolean, max_pdfs?: number }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canReadProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

const MODEL = Deno.env.get('ABSTRACT_MODEL') ?? 'claude-sonnet-5'
const BRIEF_BUDGET = 280_000
const RAWTEXT_BUDGET = 150_000
const RAW_PER_DOC_CAP = 40_000

async function anthropicJson(key: string, model: string, content: any[], maxTokens: number, looksRight: (o: any) => boolean): Promise<any> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      tools: [{
        name: 'submit_abstract',
        description: 'Submit the completed agreement abstract.',
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
  // Generic envelope unwrap + validity gate (observed variants: named key,
  // literal $PARAMETER_NAME placeholders). Throw on garbage so callers retry.
  let out = block.input ?? {}
  if (!looksRight(out)) {
    const kids = Object.values(out).filter(looksRight)
    if (kids.length === 1) out = kids[0]
  }
  if (!looksRight(out)) throw new Error('Model returned a malformed abstract envelope — retry')
  return out
}

const REA_SCHEMA = `{
 "agreement_name": str, "instrument_type": "REA"|"OEA"|"COREA"|"declaration"|"easement"|str,
 "original_date": "YYYY-MM-DD"|null, "recorded": str|null,
 "term": {"expiration": "YYYY-MM-DD"|str|null, "basis": str|null, "section": str|null},
 "parties_parcels": [{"party": str, "parcel": str|null, "role": "declarant"|"owner"|"operator"|"benefited"|"burdened"|str, "current_successor": str|null, "notes": str|null}],
 "amendment_chain": [{"instrument": str, "date": "YYYY-MM-DD"|str|null, "effect": str}],
 "operating_covenants": [{"party": str, "covenant": str, "duration": str|null, "quote": str|null, "section": str}],
 "use_restrictions": [{"scope": str, "exact_language": str, "benefits": str|null, "section": str}],
 "exclusives_granted": [{"holder": str, "protection": str, "quote": str|null, "section": str}],
 "cost_sharing": {"common_area_formula": str|null, "shares": str|null, "maintenance": [{"party": str, "scope": str, "section": str}], "insurance": str|null, "section": str|null},
 "approval_rights": [{"party": str, "right": str, "section": str}],
 "building_restrictions": {"details": str|null, "section": str|null},
 "parking": {"requirements": str|null, "section": str|null},
 "transfer_assignment": {"notes": str|null, "section": str|null},
 "self_help_remedies": [{"party": str, "remedy": str, "section": str}],
 "estoppel_obligations": str|null,
 "critical_dates": [{"date": "YYYY-MM-DD", "event": str, "source": str}],
 "impact_on_landlord_leasing": str,
 "open_items": [str]
}`

const JV_SCHEMA = `{
 "entity": str, "agreement_name": str, "effective_date": "YYYY-MM-DD"|null,
 "parties_members": [{"member": str, "role": "managing_member"|"investor_member"|"preferred"|str, "ownership_pct": num|null, "capital_commitment": str|null, "notes": str|null}],
 "amendment_chain": [{"instrument": str, "date": "YYYY-MM-DD"|str|null, "effect": str}],
 "capital": {"initial_contributions": str|null, "capital_calls": {"mechanics": str|null, "failure_remedy": str|null, "section": str|null}, "deferred_commitments": str|null},
 "distributions_waterfall": [{"tier": num, "description": str, "split": str, "hurdle": str|null, "quote": str, "section": str}],
 "preferred_return": {"rate": str|null, "compounding": str|null, "accrues_on": str|null, "section": str|null},
 "promote": {"structure": str|null, "quote": str|null, "section": str|null},
 "management_control": {"manager": str|null, "major_decisions": [str], "removal": str|null, "section": str|null},
 "transfer_restrictions": {"rofr_rofo": str|null, "consent": str|null, "permitted_transfers": str|null, "section": str|null},
 "exit": {"buy_sell": str|null, "forced_sale": str|null, "drag_tag": str|null, "section": str|null},
 "fees_to_affiliates": [str],
 "reporting_tax": str|null,
 "critical_dates": [{"date": "YYYY-MM-DD", "event": str, "source": str}],
 "open_items": [str]
}`

const PMA_SCHEMA = `{
 "manager": str, "sub_manager": str|null, "owner": str,
 "effective_date": "YYYY-MM-DD"|null,
 "term": {"start": "YYYY-MM-DD"|null, "end": "YYYY-MM-DD"|str|null, "evergreen": bool|null, "renewal": str|null, "section": str|null},
 "termination": {"for_convenience": {"who": str|null, "notice_days": num|null, "section": str|null}, "for_cause": str|null, "on_sale": str|null, "fees_on_termination": str|null},
 "fees": {"management": {"pct": num|null, "base": str|null, "minimum": str|null, "section": str|null}, "construction": {"pct": num|null, "basis": str|null, "section": str|null}, "leasing": {"terms": str|null, "section": str|null}, "other": [{"fee": str, "terms": str, "section": str}]},
 "reimbursables": {"included": str|null, "excluded": str|null, "section": str|null},
 "duties": [{"duty": str, "standard": str|null, "section": str}],
 "budget": {"approval": str|null, "variance_authority": str|null, "section": str|null},
 "banking": {"accounts": str|null, "section": str|null},
 "reporting": [{"report": str, "due": str, "section": str}],
 "insurance_indemnity": {"manager_insurance": str|null, "indemnities": str|null, "section": str|null},
 "affiliate_transactions": str|null,
 "amendment_chain": [{"instrument": str, "date": "YYYY-MM-DD"|str|null, "effect": str}],
 "critical_dates": [{"date": "YYYY-MM-DD", "event": str, "source": str}],
 "open_items": [str]
}`

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const caller = await requireUser(req, sb)

    const body = await req.json().catch(() => ({}))
    const kind: string = body.kind ?? ''
    const id: string = body.id ?? ''
    if (!['rea', 'pma', 'jv'].includes(kind) || !id) throw new Error("kind ('rea'|'pma'|'jv') and id are required")

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')

    // ── 1. Agreement row + its source document ids ──
    let row: any, docIds: string[] = [], crossCheck: any = null, table: string
    if (kind === 'rea') {
      table = 'rea_agreements'
      const { data, error } = await sb.from(table).select('*').eq('id', id).maybeSingle()
      if (error || !data) throw new Error('rea_agreements row not found')
      row = data
      docIds = ((row.source_docs ?? []) as any[]).map((d: any) => d.id).filter(Boolean)
      crossCheck = { name: row.name, agreement_date: row.agreement_date, operator: row.operator, members: row.members }
    } else if (kind === 'jv') {
      table = 'deals'
      const { data, error } = await sb.from(table).select('*').eq('id', id).maybeSingle()
      if (error || !data) throw new Error('deals row not found')
      row = data
      // The rollout script passes the entity-matched doc ids explicitly
      // (entity discrimination is hand-curated per layer — Gateway L1's
      // ML-MJW entities vs L2's M&J PC Investors must never conflate).
      docIds = Array.isArray(body.doc_ids) && body.doc_ids.length
        ? body.doc_ids
        : (Array.isArray(row.abstract_source_doc_ids) ? row.abstract_source_doc_ids : [])
      const { data: tiers } = await sb.from('waterfall_tiers')
        .select('tier_order, tier_type, description, hurdle_irr, hurdle_em, lp_split_pct, gp_split_pct, pref_rate, is_cumulative, is_pik')
        .eq('deal_id', id).order('tier_order')
      crossCheck = { deal_name: row.name, layer: row.layer, modeled_waterfall_tiers: tiers ?? [] }
    } else {
      table = 'management_agreements'
      const { data, error } = await sb.from(table).select('*').eq('id', id).maybeSingle()
      if (error || !data) throw new Error('management_agreements row not found')
      row = data
      // amends chain: walk amends_id ancestors, collecting document_ids
      const seen = new Set<string>()
      let cur: any = row
      while (cur) {
        if (cur.document_id) docIds.push(cur.document_id)
        if (!cur.amends_id || seen.has(cur.amends_id)) break
        seen.add(cur.amends_id)
        const { data: parent } = await sb.from(table).select('id, document_id, amends_id').eq('id', cur.amends_id).maybeSingle()
        cur = parent
      }
      crossCheck = {
        manager_name: row.manager_name, sub_manager_name: row.sub_manager_name, owner_name: row.owner_name,
        effective_date: row.effective_date, term_start: row.term_start, term_end: row.term_end,
        termination_notice_days: row.termination_notice_days, mgmt_fee_pct: row.mgmt_fee_pct,
        construction_fee_pct: row.construction_fee_pct, leasing_fee_pct: row.leasing_fee_pct,
        budget_variance_pct: row.budget_variance_pct, monthly_report_due_day: row.monthly_report_due_day,
      }
    }
    if (row.property_id && !canReadProperty(caller, row.property_id)) throw new AuthError('No access', 403)
    if (!docIds.length) throw new Error('agreement has no linked source documents')

    const { data: docRows } = await sb.from('documents')
      .select('id, doc_type, title, file_name, storage_path, file_size_bytes')
      .in('id', docIds)
    const docs = (docRows ?? []) as any[]

    // ── 2. Briefs + raw-text fallback ──
    const { data: briefRows } = await sb.from('doc_briefs')
      .select('document_id, doc_class, chain_role, brief, status')
      .in('document_id', docIds)
    const briefBy = new Map<string, any>()
    for (const b of (briefRows ?? []) as any[]) if (b.status === 'complete' && b.brief) briefBy.set(b.document_id, b)

    if (body.plan) {
      return new Response(JSON.stringify({
        success: true, plan: true, kind, id,
        docs: docs.map(d => ({ id: d.id, title: d.title ?? d.file_name, brief_status: briefBy.has(d.id) ? 'complete' : 'none' })),
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    let briefChars = 0
    const briefBlocks: string[] = []
    const briefIncluded = new Set<string>()
    for (const d of docs) {
      const b = briefBy.get(d.id)
      if (!b) continue
      const json = JSON.stringify(b.brief)
      if (briefChars + json.length > BRIEF_BUDGET) break
      briefBlocks.push(`===== BRIEF: "${d.title ?? d.file_name}" [${b.doc_class ?? '?'}/${b.chain_role ?? '?'}] =====\n${json}`)
      briefChars += json.length
      briefIncluded.add(d.id)
    }
    const unbriefed = docs.filter(d => !briefIncluded.has(d.id))
    const { data: chunks } = unbriefed.length ? await sb.from('document_chunks')
      .select('document_id, chunk_index, content')
      .in('document_id', unbriefed.map(d => d.id))
      .order('chunk_index') : { data: [] as any[] }
    const byDoc = new Map<string, string[]>()
    for (const c of (chunks ?? []) as any[]) {
      if (!byDoc.has(c.document_id)) byDoc.set(c.document_id, [])
      byDoc.get(c.document_id)!.push(c.content ?? '')
    }
    let rawUsed = 0
    const rawParts: string[] = []
    for (const d of unbriefed) {
      const text = (byDoc.get(d.id) ?? []).join('\n')
      if (!text) continue
      const room = RAWTEXT_BUDGET - rawUsed
      if (room < 2000) break
      const slice = text.slice(0, Math.min(room, RAW_PER_DOC_CAP))
      const clipped = text.length > slice.length ? `\n[…truncated at ${slice.length.toLocaleString()} of ${text.length.toLocaleString()} chars — brief this document for full coverage]` : ''
      rawParts.push(`===== RAW TEXT (no brief yet): "${d.title ?? d.file_name}" =====\n${slice}${clipped}`)
      rawUsed += slice.length
    }
    const inventory = docs.map(d =>
      `- "${d.title ?? d.file_name}" [${d.doc_type}] — ${briefIncluded.has(d.id) ? 'structured brief below' : 'raw text below (or title only if no text)'}`).join('\n')

    // ── 2b. Attach primary PDFs (up to 3) ──
    const mp = Number(body.max_pdfs)
    const MAX_ATTACH_DOCS = Number.isFinite(mp) ? Math.max(0, Math.min(mp, 5)) : 3
    let attachBytes = 0
    const attachable: any[] = []
    for (const d of docs) {
      if (attachable.length >= MAX_ATTACH_DOCS) break
      if (typeof d.storage_path !== 'string' || !d.storage_path.startsWith('p/')) continue
      const sz = Number(d.file_size_bytes)
      if (!(sz > 0) || sz > 8_000_000 || attachBytes + sz > 20_000_000) continue
      attachable.push(d); attachBytes += sz
    }
    let attachments: any[] = []
    if (attachable.length) {
      const { data: signedUrls } = await sb.storage.from('documents')
        .createSignedUrls(attachable.map((d: any) => d.storage_path), 3600)
      attachments = (signedUrls ?? []).filter((s: any) => s.signedUrl)
        .map((s: any) => ({ type: 'document', source: { type: 'url', url: s.signedUrl } }))
    }

    // ── 3. Synthesis prompt ──
    const kindLabel = kind === 'rea' ? 'REA/OEA/declaration' : kind === 'jv' ? 'joint-venture / LLC operating agreement' : 'property management agreement'
    const subject = kind === 'rea' ? row.name : kind === 'jv' ? row.name : `${row.manager_name} PMA`
    const prompt = `You are a commercial real estate ${kindLabel} abstractor for M&J Wilkow, producing a verified abstract of "${subject}" per the firm's Abstraction Standard. Synthesize from the structured DOCUMENT BRIEFS (each extracted from 100% of that document's text), the raw text of unbriefed documents, and the attached PDFs.

SOURCE FILE INVENTORY (a document listed here IS on file):
${inventory}

ABSTRACTION METHOD (binding):
1. THE LATEST AMENDMENT CONTROLS. Establish the amendment chain and abstract CURRENT effective terms; record the chain in amendment_chain with each instrument's effect.
2. DATE DISCIPLINE — every date field holds a bare ISO date (YYYY-MM-DD) or null; provenance in the companion basis/section field.
3. QUOTE the operative language for ${kind === 'rea' ? 'use restrictions, exclusives, and operating covenants (these drive leasing decisions — the beneficiary must be explicit)' : kind === 'jv' ? 'every distribution/waterfall tier, the preferred return, and the promote (these drive real money — quote the split percentages verbatim)' : 'fee provisions, termination rights, and budget/variance authority'}; cite instrument + section on every entry.
${kind === 'rea'
  ? `4. PARTIES & PARCELS: map every party to its parcel/tract and role; where an original party has a known successor (e.g. the declarant's interest now held by the current owner entity), note it in current_successor without guessing.
5. OPERATING COVENANTS vs USE RESTRICTIONS vs EXCLUSIVES are three different things: an operating covenant OBLIGES a party to operate; a use restriction LIMITS what parcels may be used for; an exclusive PROTECTS a named party's use against others. Never mix them.
6. impact_on_landlord_leasing: a plain-English summary of what this instrument means for leasing decisions at the center (what uses are blocked, whose consent is needed, which anchor covenants feed co-tenancy math).`
  : kind === 'jv'
  ? `4. THIS DEAL LAYER ONLY: the cross-check names the layer ("${row.name}"). Abstract the operating agreement of THIS layer's entity — if documents for the other layer's entity are in the inventory, use them only for cross-references, never for this layer's waterfall/promote terms.
5. distributions_waterfall: one entry per tier IN PAYMENT ORDER, each with a VERBATIM quote of the split language. The modeled waterfall tiers in the cross-check are the platform's current model — abstract the DOCUMENTED terms and flag every disagreement (rate, split, hurdle, ordering) as "DISCREPANCY: …" naming both values.
6. CONTROL & EXIT: major-decision list (as enumerated), manager removal, transfer/ROFR/ROFO, buy-sell/forced-sale, and capital-call failure remedies (dilution formulas verbatim).`
  : `4. FEES: capture every fee with its percentage, base (e.g. gross receipts definition), minimums, and section — plus reimbursables and their exclusions. The structured cross-check payload below holds the tracker's current values; abstract the DOCUMENTED values and flag disagreements as "DISCREPANCY: …" open items.
5. TERMINATION: who may terminate, on what notice, for what causes, on sale, and any termination fees.
6. REPORTING & BUDGET: report due dates and the manager's spending/variance authority.`}
7. GROUNDING — NO FABRICATION: every value traces to a brief, raw text, or attached PDF; silent items are null + open item ("MISSING FROM FILE:" only for instruments referenced but absent from the inventory; "CONFIRM:"/"DISCREPANCY:" as in the lease standard).

Call submit_abstract with an object matching this schema exactly (all keys present; fields at the TOP LEVEL of the tool input, no wrapper key):
${kind === 'rea' ? REA_SCHEMA : kind === 'jv' ? JV_SCHEMA : PMA_SCHEMA}

STRUCTURED CROSS-CHECK (current tracker values — flag disagreements, do not copy blindly):
${JSON.stringify(crossCheck)}

DOCUMENT BRIEFS:
${briefBlocks.join('\n\n')}
${rawParts.length ? `\nRAW TEXT OF UNBRIEFED DOCUMENTS:\n${rawParts.join('\n\n')}` : ''}`

    const looksRight = kind === 'rea'
      ? (o: any) => o && typeof o === 'object' && !Array.isArray(o) && ('parties_parcels' in o || 'agreement_name' in o || 'use_restrictions' in o)
      : kind === 'jv'
      ? (o: any) => o && typeof o === 'object' && !Array.isArray(o) && ('distributions_waterfall' in o || 'parties_members' in o || 'entity' in o)
      : (o: any) => o && typeof o === 'object' && !Array.isArray(o) && ('fees' in o || 'manager' in o || 'termination' in o)

    const isCapError = (e: unknown) =>
      /page|too long|too large|exceed|prompt is too long/i.test(e instanceof Error ? e.message : String(e))
    let abstract: any
    try {
      abstract = await anthropicJson(anthropicKey, MODEL, [...attachments, { type: 'text', text: prompt }], 16000, looksRight)
    } catch (e) {
      if (!attachments.length || !isCapError(e)) throw e
      abstract = await anthropicJson(anthropicKey, MODEL, [{ type: 'text', text: prompt }], 16000, looksRight)
      attachments = []
    }

    // Deterministic ISO-date checks
    const flags: string[] = []
    const isIso = (v: any) => v == null || /^\d{4}-\d{2}-\d{2}$/.test(String(v))
    for (const c of (Array.isArray(abstract?.critical_dates) ? abstract.critical_dates : [])) {
      if (!isIso(c?.date)) flags.push(`DISCREPANCY: critical_dates entry "${String(c?.date).slice(0, 40)}" is not a bare ISO date`)
    }
    if (flags.length) abstract.open_items = [...(Array.isArray(abstract?.open_items) ? abstract.open_items : []), ...flags]

    // ── 4. Save (fresh abstract invalidates any prior verification) ──
    const patch: any = {
      abstract,
      abstract_model: MODEL,
      abstract_generated_at: new Date().toISOString(),
      qa: null, qa_status: null, qa_at: null, qa_model: null,
      updated_at: new Date().toISOString(),
    }
    // JV deals carry no doc linkage of their own — persist the entity-matched
    // set so agreement-verify re-reads the SAME documents.
    if (kind === 'jv') patch.abstract_source_doc_ids = docIds
    const { error: upErr } = await sb.from(table).update(patch).eq('id', id)
    if (upErr) throw new Error('save failed: ' + upErr.message)

    return new Response(JSON.stringify({
      success: true, kind, id, docs_used: docs.length, briefs_used: briefIncluded.size, abstract,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
