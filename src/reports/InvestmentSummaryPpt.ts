import type { IcMemoNarrative } from '../hooks/usePipeline'
import type { IcMemoInput } from './IcMemoReport'

// Investment Summary — PowerPoint edition. Mirrors the firm's real deck
// (Chapel Hills East, 12-6-2023): 11x8.5" letter-landscape slides, serif type,
// cyan/steel banner blocks, underlined section titles, the steel-blue property
// fact table, Investment Rationale lead-ins, and a SWOT quadrant page.
// Generated fully client-side with pptxgenjs (dynamic import keeps it out of
// the main bundle) so the team gets an EDITABLE deck to polish before IC.

export interface InvSummaryInput {
  deal: IcMemoInput['deal']
  memo: IcMemoNarrative
  preparedBy: string
  generatedAt: string
}

// palette sampled from the firm's deck (hex without # for pptxgenjs)
const NAVY = '1F4864'        // titles
const STEEL = '2F6284'       // table headers / accents
const CYAN = '31B7D8'        // bright banner block
const CYAN_LIGHT = 'A9D9E8'  // pale banner block
const ROW_A = 'DCE6F1'       // table row tint
const ROW_B = 'F4F8FB'
const TEXT = '1D2429'
const MUTED = '5B6A73'
const SERIF = 'Garamond'

const RISK_LABEL: Record<string, string> = { core: 'Core', core_plus: 'Core-Plus', value_add: 'Value-Add', opportunistic: 'Opportunistic' }
const ASSET_LABEL: Record<string, string> = { retail: 'Retail', office: 'Office', mixed: 'Mixed-Use', industrial: 'Industrial' }
const LP_LABEL: Record<string, string> = { identified: 'Identified', teaser_sent: 'Teaser sent', reviewing: 'Reviewing', soft_circle: 'Soft-circled', committed: 'Committed', passed: 'Passed' }

const fmt$ = (n: number | null | undefined) =>
  n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US')
const pct = (d: number | null | undefined, dp = 1) => (d == null ? '—' : `${(d * 100).toFixed(dp)}%`)
const clip = (s: string | null | undefined, n: number): string => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : (s || ''))

const DISCLAIMER =
  'THIS MATERIAL IS FOR INFORMATIONAL PURPOSES ONLY AND IS DIRECTED ONLY TO QUALIFIED PERSONS OR ENTITIES IN ANY JURISDICTION WHERE ACCESS TO SUCH INFORMATION AND ITS USE IS PERMISSIBLE UNDER APPLICABLE LAWS AND REGULATIONS. THIS SUMMARY DOES NOT CONSTITUTE AN OFFER TO SELL OR THE SOLICITATION OF AN OFFER TO BUY ANY SECURITIES. ANY OFFER OF INTERESTS IN THE “WILKOW INVESTOR COMPANY” (AS DEFINED HEREIN), WHEN AND IF MADE, WILL BE MADE ONLY BY MEANS OF A CONFIDENTIAL PRIVATE PLACEMENT MEMORANDUM (THE “MEMORANDUM”) AND ONLY TO PERSONS WHO MEET ALL APPLICABLE LEGAL AND SUITABILITY STANDARDS. PRIOR TO MAKING AN INVESTMENT DECISION WITH RESPECT TO THE UNITS REFERRED TO HEREIN, PROSPECTIVE INVESTORS AND THEIR ADVISORS MUST REVIEW THE OFFERING DOCUMENTS, INCLUDING THE COMPLETE MEMORANDUM AND THE EXHIBITS THERETO. THIS SUMMARY REFERS TO IMPORTANT ASPECTS OF THE TRANSACTION TO BE DISCUSSED, AND POSSIBLY SUPERSEDED, IN THE OFFERING DOCUMENTS WHICH MUST BE CAREFULLY CONSIDERED BY ALL POTENTIAL INVESTORS AND THEIR ADVISORS. AN INVESTMENT IN UNITS INVOLVES VARIOUS RISK FACTORS, CONFLICTS OF INTEREST AND COMPENSATION TO MANAGEMENT, ALL OF WHICH WILL BE DISCUSSED MORE FULLY IN THE MEMORANDUM. THE INFORMATION CONTAINED IN THIS SUMMARY IS CONFIDENTIAL AND MAY NOT BE DISTRIBUTED TO ANY OTHER PARTY.'

export async function buildInvestmentSummaryPptx(input: InvSummaryInput): Promise<Blob> {
  const { deal, memo } = input
  const { default: PptxGenJS } = await import('pptxgenjs')
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'WILKOW_LTR', width: 11, height: 8.5 })
  pptx.layout = 'WILKOW_LTR'
  pptx.author = 'M&J Wilkow'
  pptx.title = `${deal.name} — Investment Summary`
  pptx.compression = true

  const profile = `${RISK_LABEL[deal.riskProfile] ?? deal.riskProfile} ${ASSET_LABEL[deal.assetType] ?? deal.assetType}`
  const loc = [deal.city, deal.state].filter(Boolean).join(', ')
  const priceLabel = deal.askPrice != null
    ? `${fmt$(deal.askPrice)}${deal.glaSf ? ` ($${Math.round(deal.askPrice / deal.glaSf)}/sf)` : ''}`
    : (deal.priceText ? clip(deal.priceText, 40) : '—')

  // ── shared chrome: banner (cover) / footer + underlined title (body) ──
  let pageNo = 0
  function bodySlide(title: string) {
    pageNo++
    const s = pptx.addSlide()
    s.addText(title, { x: 0.45, y: 0.28, w: 8.5, h: 0.55, fontFace: SERIF, fontSize: 26, bold: true, color: STEEL, underline: true })
    // footer color blocks + wordmark + page number (mirrors the deck)
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 8.06, w: 2.9, h: 0.44, fill: { color: CYAN } })
    s.addShape(pptx.ShapeType.rect, { x: 2.9, y: 8.06, w: 2.9, h: 0.44, fill: { color: CYAN_LIGHT } })
    s.addShape(pptx.ShapeType.rect, { x: 5.8, y: 8.06, w: 2.9, h: 0.44, fill: { color: STEEL } })
    s.addText('M&JWILKOW', { x: 8.75, y: 8.02, w: 2.05, h: 0.5, fontFace: SERIF, fontSize: 16, color: NAVY, align: 'right' })
    s.addText(String(pageNo + 1), { x: 10.45, y: 0.15, w: 0.4, h: 0.3, fontSize: 10, color: MUTED, align: 'right' })
    return s
  }

  // ── 1. Cover ──
  {
    const s = pptx.addSlide()
    // top banner: color blocks + title stack + wordmark
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 11, h: 1.55, fill: { color: 'FFFFFF' } })
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 1.5, h: 1.55, fill: { color: CYAN_LIGHT } })
    s.addShape(pptx.ShapeType.rect, { x: 1.5, y: 0, w: 1.5, h: 1.55, fill: { color: STEEL } })
    s.addText(deal.name, { x: 3.2, y: 0.1, w: 5.6, h: 0.62, fontFace: SERIF, fontSize: 30, bold: true, color: NAVY })
    s.addText(loc || '—', { x: 3.2, y: 0.68, w: 5.6, h: 0.42, fontFace: SERIF, fontSize: 19, bold: true, color: NAVY })
    s.addText('Investment Summary', { x: 3.2, y: 1.06, w: 5.6, h: 0.4, fontFace: SERIF, fontSize: 17, color: STEEL })
    s.addText('M&JWILKOW', { x: 8.5, y: 0.18, w: 2.3, h: 0.5, fontFace: SERIF, fontSize: 20, color: NAVY, align: 'right' })
    // hero field (the real deck uses an aerial photo — swap in PowerPoint)
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 1.55, w: 11, h: 6.95, fill: { color: STEEL } })
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 1.55, w: 11, h: 0.06, fill: { color: CYAN } })
    s.addText(profile.toUpperCase(), { x: 0.8, y: 3.5, w: 9.4, h: 0.5, fontFace: SERIF, fontSize: 20, color: CYAN_LIGHT, align: 'center', charSpacing: 4 })
    s.addText(deal.name, { x: 0.8, y: 4.0, w: 9.4, h: 0.9, fontFace: SERIF, fontSize: 40, bold: true, color: 'FFFFFF', align: 'center' })
    s.addText([
      { text: deal.glaSf ? `${Math.round(deal.glaSf).toLocaleString()} SF` : '', options: {} },
      { text: deal.glaSf && (deal.askPrice != null || deal.priceText) ? '   ·   ' : '', options: {} },
      { text: deal.askPrice != null || deal.priceText ? `Guidance ${priceLabel}` : '', options: {} },
    ], { x: 0.8, y: 4.95, w: 9.4, h: 0.45, fontFace: SERIF, fontSize: 16, color: 'E8F4F9', align: 'center' })
    s.addText(`Prepared by ${input.preparedBy} · ${input.generatedAt} · Replace this field with a property aerial in PowerPoint`, {
      x: 0.8, y: 7.7, w: 9.4, h: 0.35, fontSize: 9.5, color: 'BFD8E4', align: 'center', italic: true,
    })
  }

  // ── 2. Legal Disclaimer ──
  {
    const s = bodySlide('Legal Disclaimer')
    s.addText(DISCLAIMER, { x: 0.7, y: 1.35, w: 9.6, h: 6.2, fontFace: SERIF, fontSize: 13, color: TEXT, align: 'justify', lineSpacingMultiple: 1.35 })
  }

  // ── 3. Executive Summary: narrative left, property table right ──
  {
    const s = bodySlide('Executive Summary')
    const paras = (memo.executive_summary || deal.thesis || '').split(/\n\n+/).filter(Boolean)
    s.addText(paras.map((p, i) => ({ text: p, options: { breakLine: true, paraSpaceAfter: i < paras.length - 1 ? 10 : 0 } })),
      { x: 0.45, y: 1.15, w: 4.9, h: 6.7, fontFace: SERIF, fontSize: 13, color: TEXT, lineSpacingMultiple: 1.25, valign: 'top', fit: 'shrink' } as any)

    const committed = deal.lps.reduce((a, l) => a + (l.committed ?? 0), 0)
    const rows: [string, string][] = [
      ['Location', loc || '—'],
      ['Property Type', `${deal.subType ? deal.subType + ' — ' : ''}${profile}`],
      ['Submarket', deal.submarket ?? '—'],
      ['Total GLA', deal.glaSf != null ? Math.round(deal.glaSf).toLocaleString() + ' SF' : '—'],
      ['Year Built', deal.yearBuilt != null ? String(deal.yearBuilt) : '—'],
      ['Purchase Price', priceLabel],
      ['Going-in Cap Rate', pct(deal.goingInCap)],
      ['Hold Period', deal.holdYears != null ? `${deal.holdYears} Years` : '—'],
      ['Equity Capital Requirement', deal.equityRequired != null ? `${fmt$(deal.equityRequired)}${committed ? ` (committed to date: ${fmt$(committed)})` : ''}` : '—'],
      ['Leveraged IRR', pct(deal.projIrr)],
      ['Avg. Cash Flow Yield', pct(deal.avgCoc)],
      ['Equity Multiple', deal.equityMultiple != null ? `${deal.equityMultiple.toFixed(2)}x` : '—'],
      ['Exit Cap Rate', pct(deal.exitCap)],
    ]
    const tableRows = [
      [
        { text: 'The Property', options: { bold: true, color: 'FFFFFF', fill: { color: STEEL } } },
        { text: deal.name, options: { bold: true, color: 'FFFFFF', fill: { color: STEEL } } },
      ],
      ...rows.map(([k, v], i) => [
        { text: k, options: { bold: true, color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A } } },
        { text: clip(v, 46), options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A } } },
      ]),
    ]
    s.addTable(tableRows as any, {
      x: 5.6, y: 1.15, w: 5.0, colW: [1.95, 3.05], fontFace: SERIF, fontSize: 11.5,
      border: { type: 'solid', color: 'FFFFFF', pt: 1 }, rowH: 0.34, valign: 'middle', margin: 0.06,
    })
  }

  // ── 4. Investment Rationale ──
  {
    const s = bodySlide('Investment Rationale')
    const sections = (memo.rationale?.length ? memo.rationale : [
      ...(memo.business_plan ? [{ title: 'Business Plan', body: memo.business_plan }] : []),
      ...(memo.headline ? [{ title: 'The Opportunity', body: memo.headline }] : []),
    ])
    const runs: any[] = []
    for (const r of sections) {
      runs.push({ text: `${r.title}: `, options: { bold: true, color: STEEL } })
      runs.push({ text: r.body, options: { color: TEXT, breakLine: true, paraSpaceAfter: 12 } })
    }
    s.addText(runs.length ? runs : 'No rationale drafted.', { x: 0.45, y: 1.2, w: 10.1, h: 6.6, fontFace: SERIF, fontSize: 13.5, lineSpacingMultiple: 1.25, valign: 'top', fit: 'shrink' } as any)
  }

  // ── 5. Tenancy Overview (when the OM gave us a roster) ──
  const tenants = memo.major_tenants ?? []
  if (tenants.length) {
    const s = bodySlide('Tenancy Overview')
    const tRows = [
      ['Tenant', 'SF', 'Lease Expiration'].map(h => ({ text: h, options: { bold: true, color: 'FFFFFF', fill: { color: STEEL } } })),
      ...tenants.slice(0, 14).map((t, i) => [
        { text: t.name, options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A } } },
        { text: t.sf != null ? Math.round(t.sf).toLocaleString() : '—', options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A }, align: 'right' } },
        { text: t.expiration ?? '—', options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A } } },
      ]),
    ]
    s.addTable(tRows as any, { x: 0.7, y: 1.3, w: 9.6, colW: [5.4, 1.8, 2.4], fontFace: SERIF, fontSize: 12, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, rowH: 0.36, valign: 'middle', margin: 0.06 })
    s.addText('Source: offering memorandum (AI-extracted) — verify against the rent roll before distribution.', { x: 0.7, y: 7.45, w: 9.6, h: 0.3, fontSize: 9.5, italic: true, color: MUTED })
  }

  // ── 6. SWOT Analysis (2×2 quadrants, like the deck) ──
  {
    const s = bodySlide('SWOT Analysis')
    const q = memo.swot ?? {}
    const quads: { label: string; items: string[]; x: number; y: number; hdr: string }[] = [
      { label: 'STRENGTHS', items: q.strengths ?? [], x: 0.45, y: 1.2, hdr: STEEL },
      { label: 'WEAKNESSES', items: q.weaknesses ?? [], x: 5.6, y: 1.2, hdr: CYAN },
      { label: 'OPPORTUNITIES', items: q.opportunities ?? [], x: 0.45, y: 4.55, hdr: CYAN },
      { label: 'THREATS', items: q.threats ?? [], x: 5.6, y: 4.55, hdr: STEEL },
    ]
    for (const quad of quads) {
      s.addShape(pptx.ShapeType.rect, { x: quad.x, y: quad.y, w: 4.95, h: 0.4, fill: { color: quad.hdr } })
      s.addText(quad.label, { x: quad.x + 0.1, y: quad.y + 0.02, w: 4.7, h: 0.36, fontFace: SERIF, fontSize: 14, bold: true, color: 'FFFFFF' })
      s.addShape(pptx.ShapeType.rect, { x: quad.x, y: quad.y + 0.4, w: 4.95, h: 2.75, fill: { color: ROW_B }, line: { color: 'D3DEE8', width: 0.75 } })
      s.addText((quad.items.length ? quad.items : ['—']).map(t => ({ text: t, options: { bullet: { characterCode: '2022', indent: 12 }, breakLine: true, paraSpaceAfter: 6 } })),
        { x: quad.x + 0.12, y: quad.y + 0.5, w: 4.7, h: 2.55, fontFace: SERIF, fontSize: 11.5, color: TEXT, valign: 'top', fit: 'shrink' } as any)
    }
  }

  // ── 7. Capital, Venture & The Ask ──
  {
    const s = bodySlide('Capital & The Ask')
    const committed = deal.lps.reduce((a, l) => a + (l.committed ?? 0), 0)
    const soft = deal.lps.reduce((a, l) => a + (l.soft ?? 0), 0)
    const gap = Math.max(0, (deal.equityRequired ?? 0) - committed - soft)
    const kRows = [
      ['Equity Capital Requirement', deal.equityRequired != null ? fmt$(deal.equityRequired) : '—'],
      ['Committed', fmt$(committed)], ['Soft-circled', fmt$(soft)], ['Remaining Gap', deal.equityRequired != null ? fmt$(gap) : '—'],
    ]
    s.addTable([
      ...kRows.map(([k, v], i) => [
        { text: k, options: { bold: true, color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A } } },
        { text: v, options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A }, align: 'right' } },
      ]),
    ] as any, { x: 0.45, y: 1.25, w: 4.6, colW: [2.7, 1.9], fontFace: SERIF, fontSize: 12, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, rowH: 0.36, valign: 'middle', margin: 0.06 })

    if (deal.lps.length) {
      const lpRows = [
        ['Capital Partner', 'Status', 'Committed'].map(h => ({ text: h, options: { bold: true, color: 'FFFFFF', fill: { color: STEEL } } })),
        ...deal.lps.map((l, i) => [
          { text: l.partnerName, options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A } } },
          { text: LP_LABEL[l.status] ?? l.status, options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A } } },
          { text: l.committed != null ? fmt$(l.committed) : (l.soft != null ? `${fmt$(l.soft)} (soft)` : '—'), options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A }, align: 'right' } },
        ]),
      ]
      s.addTable(lpRows as any, { x: 5.6, y: 1.25, w: 5.0, colW: [2.3, 1.4, 1.3], fontFace: SERIF, fontSize: 11.5, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, rowH: 0.34, valign: 'middle', margin: 0.06 })
    }

    if (memo.recommendation) {
      s.addText([{ text: 'Recommendation:  ', options: { bold: true, color: STEEL } }, { text: memo.recommendation, options: { color: TEXT } }],
        { x: 0.45, y: 4.35, w: 10.1, h: 1.1, fontFace: SERIF, fontSize: 13, lineSpacingMultiple: 1.25, valign: 'top', fit: 'shrink' } as any)
    }
    if (memo.ask) {
      s.addShape(pptx.ShapeType.rect, { x: 0.45, y: 5.7, w: 10.1, h: 1.05, fill: { color: ROW_A }, line: { color: STEEL, width: 1.5 } })
      s.addText([{ text: 'THE ASK   ', options: { bold: true, color: STEEL, charSpacing: 2 } }, { text: memo.ask, options: { color: TEXT } }],
        { x: 0.65, y: 5.82, w: 9.7, h: 0.8, fontFace: SERIF, fontSize: 13.5, valign: 'middle', fit: 'shrink' } as any)
    }
    s.addText('Narrative sections are AI-drafted from the deal record — verify against source materials before distribution.', { x: 0.45, y: 7.5, w: 10.1, h: 0.3, fontSize: 9.5, italic: true, color: MUTED })
  }

  try {
    const blob = await pptx.write({ outputType: 'blob' })
    console.log(`[PPT generated] ${(blob.size / 1024 / 1024).toFixed(2)} MB`)
    return blob as Blob
  } catch (e) {
    console.error('[PPT generation error]', e)
    throw new Error(`PowerPoint generation failed: ${e instanceof Error ? e.message : 'unknown error'}`)
  }
}
