// market-reports — finds current third-party market reports on the public web
// for one property's metro (brokerage retail/office research, cap-rate surveys,
// metro economic data) using the Anthropic web-search server tool.
//
// Pipeline:
//   1. Load the property (city/state/asset_type) to build the market query.
//   2. One claude call with the web_search server tool + a submit_reports
//      client tool — the model searches, then submits only URLs it actually
//      saw in search results (no guessed links).
//   3. Replace the property's market_reports rows with the fresh list.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.
// Usage: POST JSON { property_id: uuid }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canWriteProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

const MODEL = Deno.env.get('MARKET_MODEL') ?? 'claude-sonnet-5'

interface Report {
  title: string
  publisher: string
  period?: string
  url: string
  summary: string
  report_type: string
}

const SUBMIT_TOOL = {
  name: 'submit_reports',
  description: 'Submit the final list of market reports found on the web.',
  input_schema: {
    type: 'object',
    properties: {
      reports: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            publisher: { type: 'string', description: 'Publishing firm, e.g. CBRE, JLL, Cushman & Wakefield, Colliers, Marcus & Millichap, ICSC, U.S. Census' },
            period: { type: 'string', description: 'Period covered, e.g. "Q1 2026" or "2026 Outlook"' },
            url: { type: 'string', description: 'Direct URL exactly as seen in search results — never invented' },
            summary: { type: 'string', description: '1-2 sentences: what the report covers and why it matters for this market' },
            report_type: { type: 'string', enum: ['market_report', 'research_note', 'news', 'data_page'] },
          },
          required: ['title', 'publisher', 'url', 'summary', 'report_type'],
        },
      },
    },
    required: ['reports'],
  },
}

// The web_search tool runs server-side inside the same API request; the model
// may pause a long search turn (stop_reason 'pause_turn') — resend to continue.
async function findReports(key: string, prompt: string): Promise<Report[]> {
  let messages: any[] = [{ role: 'user', content: prompt }]
  for (let i = 0; i < 5; i++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 6000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }, SUBMIT_TOOL],
        messages,
      }),
    })
    const d = await r.json()
    if (!r.ok) throw new Error('Anthropic API error: ' + JSON.stringify(d))
    const toolUse = (d.content ?? []).find((c: any) => c.type === 'tool_use' && c.name === 'submit_reports')
    if (toolUse) return (toolUse.input?.reports ?? []) as Report[]
    messages = [...messages, { role: 'assistant', content: d.content }]
    if (d.stop_reason !== 'pause_turn') {
      messages = [...messages, { role: 'user', content: 'Call submit_reports now with every report you found.' }]
    }
  }
  throw new Error('Search did not complete — try again')
}

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    // Runs with the service role + spends AI/web-search budget; authorize the caller.
    const caller = await requireUser(req, sb)

    const body = await req.json().catch(() => ({}))
    const propertyId: string = body.property_id ?? ''
    if (!propertyId) throw new Error('property_id is required')
    if (!canWriteProperty(caller, propertyId)) throw new AuthError('No write access to this property', 403)   // WRITE gate (audit S2): this endpoint mutates state / spends AI credits

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')

    const { data: prop, error: pErr } = await sb.from('properties')
      .select('id, name, city, state, asset_type').eq('id', propertyId).single()
    if (pErr || !prop) throw new Error('property not found: ' + (pErr?.message ?? propertyId))

    const sector = prop.asset_type === 'office' ? 'office'
      : prop.asset_type === 'mixed_use' ? 'retail and office' : 'retail'
    const market = `${prop.city}, ${prop.state} — ${sector}`

    const prompt = `You are a commercial real estate research assistant. Find the most recent PUBLICLY AVAILABLE market reports and research for the ${sector.toUpperCase()} asset class covering ${prop.city}, ${prop.state} (the metro area around the property "${prop.name}"). Today's date: ${new Date().toISOString().slice(0, 10)}.

CRITICAL: every report must match BOTH dimensions — the market/submarket (${prop.city}, ${prop.state} metro) AND the asset class (${sector}). A generic "commercial real estate" metro report is acceptable only if it has a dedicated ${sector} section; an industrial or multifamily report for this metro is NOT acceptable, and neither is a ${sector} report for a different metro (except the national outlooks in item 2).

Search for, in priority order:
1. The latest quarterly ${sector} market reports for this metro from major brokerages — CBRE ("Figures"), JLL, Cushman & Wakefield ("MarketBeat"), Colliers, Marcus & Millichap, Matthews, Newmark. Search asset class + metro together (e.g. "${prop.city} ${sector} market report"). If the exact metro has no dedicated ${sector} report, use the nearest covering market (e.g. suburb → its metro) and say so in the summary.
2. National ${sector} outlook / cap-rate survey reports (current edition) that give sector-wide context for this asset class.
3. Recent local ${sector} real estate news for this market (business journal articles, major lease/sale announcements) from the last ~6 months.

Rules:
- Use web_search first, then call submit_reports exactly once with 5–10 items.
- Only include URLs that appeared in your search results — NEVER construct or guess a URL.
- Prefer links that go directly to the report or its download/landing page; prefer PDFs where available.
- Skip anything paywalled to the point of being useless (CoStar, subscription-only databases).
- "period" = the period the report covers (e.g. "Q1 2026"), not the publish date.
- Most recent edition only — do not list superseded quarters of the same series.`

    const found = await findReports(anthropicKey, prompt)
    const valid = found.filter(r => /^https?:\/\//i.test(r.url ?? ''))
    if (!valid.length) throw new Error('No reports with valid URLs found')

    // Replace this property's list; dedupe by URL within the batch.
    const seen = new Set<string>()
    const rows = valid.filter(r => !seen.has(r.url) && seen.add(r.url)).map(r => ({
      property_id: propertyId,
      market,
      title: r.title,
      publisher: r.publisher ?? null,
      period: r.period ?? null,
      url: r.url,
      summary: r.summary ?? null,
      report_type: r.report_type ?? 'market_report',
      fetched_at: new Date().toISOString(),
    }))
    const { error: delErr } = await sb.from('market_reports').delete().eq('property_id', propertyId)
    if (delErr) throw new Error('clear failed: ' + delErr.message)
    const { error: insErr } = await sb.from('market_reports').insert(rows)
    if (insErr) throw new Error('save failed: ' + insErr.message)

    return new Response(JSON.stringify({ success: true, market, count: rows.length, reports: rows }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
