// ppm-draft — AI assist for the PPM generator (/ppm).
//
// Two actions:
//   { action:'draft',   sectionKey, dataSheet, notes? }  -> { text }
//     Drafts ONE narrative section of a Private Placement Memorandum in the
//     firm's house voice (exemplars from the Chapel Hills East 2024 / Silverado
//     2025 PPMs are embedded below). HARD RULE passed to the model: every
//     dollar figure / percentage / multiple must come verbatim from the data
//     sheet — the client independently re-verifies with verifyNumbers().
//   { action:'extract', text, focus? }                   -> { fields }
//     Parses pasted source-document text (rent roll, PCA, loan term sheet, JV
//     term sheet, market report...) into data-sheet fields.
//
// Drafting only — nothing is written to the database here. Deal data is
// restricted to admin / asset_manager (same as ic-memo).
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, corsHeaders, requireUser } from '../_shared/auth.ts'

const MODEL = Deno.env.get('PPM_DRAFT_MODEL') ?? 'claude-sonnet-5'

async function anthropicTool(key: string, prompt: string, toolName: string, maxTokens: number): Promise<any> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens,
      tools: [{ name: toolName, description: 'Submit the result.', input_schema: { type: 'object', additionalProperties: true } }],
      tool_choice: { type: 'tool', name: toolName },
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Anthropic API error: ' + JSON.stringify(d))
  const block = (d.content ?? []).find((c: { type: string }) => c.type === 'tool_use')
  if (!block) throw new Error('Model returned no tool_use block')
  return block.input
}

// ---------------------------------------------------------------------------
// Per-section coverage specs + short house-voice exemplars (Chapel Hills East
// 1-21-24). Exemplars teach TONE and SHAPE; the model must substitute this
// deal's facts throughout.
// ---------------------------------------------------------------------------

const SECTIONS: Record<string, { coverage: string; exemplar: string }> = {
  exec_summary: {
    coverage: `Paragraph 1: the transaction opener — MUST begin "This transaction presents selected accredited investors with an opportunity to invest in <investorCompanyName>, a new Delaware limited liability company (the "Wilkow Investor Company"), which will enter into a joint venture..." naming the JV partner and the property; include the JV-history note if provided. Paragraph 2: the JV partner credibility paragraph (use jvPartnerBlurb). Paragraph 3: property overview — size, location, occupancy, anchor/tenant mix, what makes the location strong. Paragraph 4 (headed "Wilkow Investor Company"): the investment case + the raise: units, unit price, and the full Class A preference waterfall in prose. Paragraph 5 (headed "Projected Yields and Assumptions"): the base-case forecast sentence with exit year, exit cap, projected sale price ($ and /sf), average annual cash flow yield, levered IRR, and equity multiple; add the Upside Case paragraph only if upside data is present.`,
    exemplar: `"Base Case" Forecast Yields: If the underwriting assumptions underpinning the "Base Case" Financial Forecast are substantially realized, including a sale of the Property in the tenth year at an exit capitalization rate of 6.50% (which equates to a projected sale price of $51,286,066 ($228/sf)), then the Financial Forecast projects: (A) an average (but not consistently level) annual cash flow yield of 6.8%; (B) a levered internal rate of return ("IRR") of 11.4%; and (C) an equity multiple of 2.52x.`,
  },
  transaction_highlights: {
    coverage: `Bolded-lead subsections, each 1-2 paragraphs, in this order: Dominant Regional Location; Strong Market Fundamentals & Favorable Demographics; Diversified Tenant Mix; Attractive Current Yields; Attractive Cost Basis; Potential Value-Add Initiatives (render each data-sheet initiative as its own bolded lead-in + body). Put each subsection heading on its own line.`,
    exemplar: `Attractive Cost Basis\n\nOur $165/sf acquisition price is significantly lower than replacement cost. Recent sales of substantially leased, i.e., stabilized grocery-anchored shopping centers in the market were completed at prices near $255/sf, which compares favorably to the Financial Forecast's assumption that the Property will be sold at the end of the tenth year of the investment period for a price that equates to $228/sf. On a cap rate basis, the Venture will acquire the asset at a going-in cap rate of 7.98%, which again compares favorably to the 5.87% average cap rate for recent similar trades in the market.`,
  },
  market_analysis: {
    coverage: `Subsections on their own lines: "<MSA> Market Overview" (2-4 paragraphs: economy, population growth, employers, infrastructure, quality of life); "Retail Market Overview" (market size, absorption, vacancy, rents, submarket detail); "RELEVANT SALES COMPS" (1 paragraph using salesCompsNote); "RELEVANT COMPETING SHOPPING CENTER INFORMATION" (1-2 paragraphs using competingCentersNote); "RELEVANT LEASE COMPS" (1-2 paragraphs using leaseCompsNote). Only use figures present in the market stats/notes.`,
    exemplar: `The Colorado Springs MSA has vibrant growth that exceeds national trends, a diverse and strong economy with excellent job opportunities, and quality of life attributes that have drawn the attention of many who follow relocation trends. National publications have brought international recognition to the region for its pro-business atmosphere, excellent transportation infrastructure and affordable high-quality lifestyle.`,
  },
  property_description: {
    coverage: `2-3 paragraphs: (1) what/where the asset is — regional positioning, GLA, intersection/frontage/traffic counts, access, parking; (2) buildings and tenant placement (which tenants in which buildings, ground-leased pads); (3) trade-area demographics sentence. Do NOT cover PCA/ESA/zoning details — those blocks are auto-generated.`,
    exemplar: `Built in 1995, Chapel Hills East consists of 224,733 square feet of retail space in three separate buildings. Leading national tenants Best Buy, Old Navy, Carters, Nordstrom Rack, DSW Shoes, Whole Foods Market, and Pep Boys are located within the main multi-tenant building, consisting of approximately 181,683 square feet.`,
  },
  tenancy: {
    coverage: `(1) Overview paragraph: tenant count, mix of uses, notable tenants with SF. (2) Anchor performance paragraph(s): sales volumes/psf, health ratios, Placer rankings — only for tenants whose data-sheet rows carry those figures; name the tenants that report sales vs not. (3) Leasing momentum / renewal history paragraph (use anchorStory notes). (4) A short lead-in sentence for the co-tenancy summary ("On the following page is a summary of the On-going Co-Tenancy Requirements..." style) — the per-tenant co-tenancy blocks themselves are auto-generated, do not write them.`,
    exemplar: `One of the Property's key traffic drivers is Whole Foods Market. Whole Foods Market is a national AA credit rated tenant and the #1 specialty grocer in Colorado by market share. Whole Foods has been a tenant at the Property since 2003, and recently exercised its 5-year renewal option, thereby extending its lease to January 31, 2029.`,
  },
  financial_analysis: {
    coverage: `In order: (1) the forecast-summary paragraph (hold period, occupancy at exit, exit cap, projected sale price $ and /sf, cash yield, IRR, EM); (2) the loan paragraph (lender, amount, LTV, rate, term, IO); (3) going-in cap + in-place NOI paragraph with the renewal-options story; (4) per-anchor mark-to-market/renewal assumption paragraphs if the notes describe them; (5) capex paragraph tying the PCA numbers to the capex budget total; (6) "In addition to the foregoing, additional material underwriting assumptions..." list: opex psf + growth, RET psf + reassessment note, management fee %, structural reserve psf, audit/leasing/legal/travel reserve; (7) historical NOI commentary sentence; (8) the "Upside Case" subsection from upsideNotes if present.`,
    exemplar: `The Financial Forecast assumes terms quoted by John Hancock Life Insurance Company providing for a non-recourse, ten-year fixed rate [5.95% per annum] loan in the principal amount of $18,500,000 (the "Mortgage Loan"), which equates to a Loan to Value Ratio of 50.0% based on the $37.0 million purchase price for the Property.`,
  },
  risks: {
    coverage: `Lettered subsections A., B., C., ... each with "Risks:" and "Potential Risk Mitigants:" paragraphs. Standard set (include those that apply, tailor every mitigant to THIS deal's facts): Retail Industry in Transition (Store Closings and Bankruptcies) — include both macro and micro mitigants; Tenants' Exclusives, Co-Tenancy Rights, Performance Termination and "Go-Dark" Rights; Rollover Exposure; Future Competition; Unanticipated Capital Expenditures; Interest Rate Risk; Debt Service Coverage and Loan-to-Value Requirements/Cash Flow Sweep; Absence of Actual Sales Reports from Selected Tenants.`,
    exemplar: `C. Rollover Exposure\n\nRisks: Nearly all of the major tenants at the Property have leases that are set to expire within the assumed holding period.\n\nPotential Risk Mitigants: While there is a significant amount of potential rollover, MJW believes that all of the major tenants are likely to renew their leases. This assumption is based on a combination of current tenant sales, Placer rankings and the dynamics of the market.`,
  },
}

const DRAFT_RULES = `HARD RULES:
- Voice: institutional, confident, plain — the measured house voice of the exemplar. No hype words, no filler.
- NUMBERS: every dollar figure, percentage, multiple, square footage, and count MUST be taken verbatim from the DATA SHEET. If a fact you would normally state is missing from the data sheet, write around it or omit the sentence — NEVER invent, estimate, or extrapolate a number.
- Percentages in the data sheet are decimals (0.0798 = 7.98%). Render them conventionally.
- Refer to the shopping center as "the Property" after first naming it.
- Paragraphs separated by blank lines. Subsection headings (where the coverage spec calls for them) on their own line.
- Output plain text only (no markdown syntax, no asterisks).`

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const caller = await requireUser(req, sb)
    if (!caller.isPrivileged) throw new AuthError('Deal data is restricted', 403)

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
    if (!anthropicKey) throw new Error('Missing ANTHROPIC_API_KEY secret')

    const body = await req.json().catch(() => ({}))
    const action: string = body.action ?? 'draft'

    if (action === 'draft') {
      const sectionKey: string = body.sectionKey ?? ''
      const spec = SECTIONS[sectionKey]
      if (!spec) throw new Error(`Unknown or non-AI section: ${sectionKey}`)
      const dataSheet = body.dataSheet ?? {}
      const notes: string = body.notes ?? ''

      const prompt = `You are drafting ONE section of a Private Placement Memorandum for M & J Wilkow, a Chicago shopping-center investment firm raising accredited-investor capital alongside an institutional JV partner. You write exactly in the firm's established PPM voice.

STYLE EXEMPLAR (from a prior firm PPM — match tone and sentence shape, NOT the facts):
---
${spec.exemplar}
---

SECTION TO WRITE: ${sectionKey}
COVERAGE SPEC: ${spec.coverage}

${DRAFT_RULES}
${notes ? `\nAUTHOR NOTES FOR THIS DRAFT:\n${notes}\n` : ''}
DATA SHEET (JSON — the only permitted source of facts and numbers):
${JSON.stringify(dataSheet, null, 1)}

Call submit_section with { "text": "<the full section text>" }.`

      const out = await anthropicTool(anthropicKey, prompt, 'submit_section', 4000)
      const text = typeof out.text === 'string' ? out.text : ''
      if (!text.trim()) throw new Error('Model returned an empty draft')
      return new Response(JSON.stringify({ success: true, text }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (action === 'extract') {
      const text: string = (body.text ?? '').slice(0, 150_000)
      if (!text.trim()) throw new Error('text is required')
      const focus: string = body.focus ?? ''

      const prompt = `You are extracting structured facts from acquisition due-diligence material for a PPM data sheet. Extract ONLY what the text actually states — never infer or compute. Omit any field the text does not support.

Field catalog (return any subset; use these exact keys):
- Identity: propertyName, address, city, state (full name), msa, propertyType, yearBuilt (string)
- Physical: glaSf (number), landAcres (number), occupancyPct (decimal, 1.0=100%), parkingSpaces (number), parkingRatio (string)
- Deal: purchasePrice, pricePsf, goingInCap (decimal), inPlaceNoi, totalCapitalization
- JV: jvPartnerName, jvPartnerShort, jvPartnerPct (decimal), mjwPct (decimal), jvVehicleName, propertyOwnerLlc, jvWaterfallTiers [{split, until}]
- Equity: totalEquity, partnerEquity, mjwEquity, sponsorFee, workingCapital, investorCompanyTotal, acquisitionBudget [{item, amount}]
- Loan: lenderName, loanAmount, ltvPct (decimal), interestRate (decimal), rateDescription, loanTermYears, ioDescription, futureFunding
- Forecast: holdYears, exitCap (decimal), projSalePrice, projSalePsf, projIrr (decimal), avgCoc (decimal), equityMultiple, afterTaxIrr (decimal), afterTaxCoc (decimal)
- Ops: opexPsfYr1, retPsfYr1, retNote, mgmtFeePct (decimal), capexBudgetTotal, capexBudgetLines [{item, amount}], structuralReservePsf, auditReserveAnnual, historicalNoi [{year, income, expenses, noi}]
- Tax: landBldgSplit, loanFeesAcqCosts, stateTaxRate (decimal), stateTaxName
- PCA/ESA: pcaFirm, pcaDate, pcaImmediateRepairs, pcaReserve12yr, pcaPsfPerYear, pcaKeyItems, esaFirm, esaDate, esaFindings
- Property details: taxParcels, zoningText, accessText, signageText, siteImprovementsText, foundationText, facadeText, roofsText, utilitiesText, floodZoneText
- Tenancy: tenants [{name, sf, pctGla (decimal), pctRev (decimal), rentPsf, leaseType, expiration, options, salesPsf, healthRatio (decimal), placerRank, groundLease (bool)}], coTenancy [{tenant, requirement, conclusion}]
- Market: submarketName, marketVacancy (decimal), submarketVacancy (decimal), pop3mi, pop5mi, hhi3mi, trafficCounts, salesCompsNote, leaseCompsNote, competingCentersNote, marketOverviewNotes
${focus ? `\nFOCUS: the text is primarily a ${focus} — prioritize those fields.` : ''}
SOURCE TEXT:
---
${text}
---

Call submit_fields with { "fields": { ...extracted key/values } }.`

      const out = await anthropicTool(anthropicKey, prompt, 'submit_fields', 8000)
      return new Response(JSON.stringify({ success: true, fields: out.fields ?? {} }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    throw new Error(`Unknown action: ${action}`)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
