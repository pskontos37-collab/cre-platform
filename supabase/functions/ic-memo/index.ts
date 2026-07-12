// ic-memo — drafts the narrative for an Investment Committee review memo from a
// pipeline deal: executive summary, business plan, risks + mitigants, and a
// recommendation. One forced-tool Claude call returns parsed JSON. The client
// renders it (plus the deal's structured data) into a branded PDF deck.
//
// Nothing is written here — it only drafts. Deal/capital data is restricted to
// admin / asset_manager.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.
// Usage: POST JSON { dealId: uuid }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, corsHeaders, requireUser } from '../_shared/auth.ts'

const MODEL = Deno.env.get('IC_MEMO_MODEL') ?? 'claude-sonnet-5'

async function anthropicJson(key: string, model: string, prompt: string, maxTokens: number): Promise<any> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      tools: [{ name: 'submit_memo', description: 'Submit the IC memo narrative.', input_schema: { type: 'object', additionalProperties: true } }],
      tool_choice: { type: 'tool', name: 'submit_memo' },
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Anthropic API error: ' + JSON.stringify(d))
  const block = (d.content ?? []).find((c: { type: string }) => c.type === 'tool_use')
  if (!block) throw new Error('Model returned no tool_use block')
  return block.input
}

const SCHEMA = `{
 "headline": str,                 // one-line positioning of the opportunity
 "executive_summary": str,        // 2-3 PARAGRAPHS (separated by \\n\\n) in the firm's Investment Summary voice: what the asset is, tenancy/market strength, and the return story
 "business_plan": str,            // 3-5 sentences: the value-creation plan over the hold
 "rationale": [{"title": str, "body": str}],  // 3-5 Investment Rationale sections, each a bolded lead-in title ("Attractive Cost Basis", "Durable Tenancy", ...) + 2-4 sentence body
 "swot": { "strengths": [str], "weaknesses": [str], "opportunities": [str], "threats": [str] },  // 2-4 crisp bullets each
 "risks": [{"risk": str, "mitigant": str}],   // 3-5 of the most material risks, each with a mitigant
 "recommendation": str,           // 2-3 sentences: advance or pass, and why
 "ask": str                       // one sentence: exactly what the IC is asked to approve (e.g. authorize an LOI at $X with $Y of equity)
}`

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const caller = await requireUser(req, sb)
    if (!caller.isPrivileged) throw new AuthError('Deal data is restricted', 403)

    const body = await req.json().catch(() => ({}))
    const dealId: string = body.dealId ?? ''
    if (!dealId) throw new Error('dealId is required')

    const { data: deal, error: dErr } = await sb.from('pipeline_deals').select('*').eq('id', dealId).single()
    if (dErr || !deal) throw new Error('deal not found')

    const { data: lps } = await sb.from('pipeline_deal_lps')
      .select('status, soft_amount, committed_amount, notes, capital_partners(name, return_target, deal_size)')
      .eq('deal_id', dealId)
    const { data: om } = await sb.from('om_intake')
      .select('extracted').eq('deal_id', dealId).order('created_at', { ascending: false }).limit(1)

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')

    // Compact, model-friendly view of everything we know about the deal.
    const facts = {
      name: deal.name, asset_type: deal.asset_type, risk_profile: deal.risk_profile, sub_type: deal.sub_type,
      submarket: deal.submarket, city: deal.city, state: deal.state, gla_sf: deal.gla_sf, year_built: deal.year_built,
      stage: deal.stage, deal_source: deal.deal_source, broker: deal.broker, seller: deal.seller, partner: deal.partner,
      ask_price: deal.ask_price, price_text: deal.price_text, going_in_cap: deal.going_in_cap,
      equity_required: deal.equity_required, total_capitalization: deal.total_capitalization,
      target_close_date: deal.target_close_date, thesis: deal.thesis,
      returns: { proj_irr: deal.proj_irr, equity_multiple: deal.equity_multiple, avg_coc: deal.avg_coc,
        hold_years: deal.hold_years, exit_cap: deal.exit_cap, stabilized_yield: deal.stabilized_yield },
      lps: (lps ?? []).map((l: any) => ({ partner: l.capital_partners?.name, status: l.status,
        soft: l.soft_amount, committed: l.committed_amount, note: l.notes })),
      om_extraction: (om ?? [])[0]?.extracted ?? null,
    }

    const prompt = `You are an acquisitions principal at M&J Wilkow preparing an Investment Committee (IC) memo for a retail/office acquisition where the firm is the GP raising institutional LP capital. Write crisp, decision-useful institutional prose — no hype, no filler. Ground every claim in the deal data below; where a figure is missing, work with what's given and fold the gap into the risks/open items rather than inventing numbers. Percentages in the data are decimals (0.066 = 6.6%).

Call the submit_memo tool with an object matching this schema exactly (all keys present):
${SCHEMA}

DEAL DATA (JSON):
${JSON.stringify(facts, null, 1)}`

    const memo = await anthropicJson(anthropicKey, MODEL, prompt, 3500)
    // Pass the OM's tenant roster through so the client can render a tenancy
    // table without a second fetch.
    memo.major_tenants = (facts.om_extraction as any)?.major_tenants ?? []
    return new Response(JSON.stringify({ success: true, memo }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
