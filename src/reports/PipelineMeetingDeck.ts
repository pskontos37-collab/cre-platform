import type { Deal, PipelineMetrics } from '../hooks/usePipeline'
import { isActiveStage, boardColumn } from '../hooks/usePipeline'

// Weekly Acquisitions Pipeline Review — the meeting deck. ONE editable PowerPoint
// covering EVERY live deal so the team can walk the pipeline in the 60-90 min
// standing meeting. Unlike the per-deal Investment Summary (AI-narrated, for IC),
// this deck is built entirely from the structured tracker record — fast, complete,
// and an exact mirror of the pipeline as it stands. Firm deck branding (cyan/steel
// banner blocks, Garamond serif, M&JWILKOW wordmark) matches InvestmentSummaryPpt.
//
// Flow: Cover → Pipeline Snapshot (KPIs + stage/mix distribution) → Pipeline
// Summary table(s) → one discussion slide per active deal (hottest stage first)
// → Watchlist appendix. Generated client-side with pptxgenjs (dynamic import).

export interface DeckTenant { name: string; sf: number | null; expiration: string | null }
export interface MeetingDeckInput {
  deals: Deal[]            // the full pipeline — this module sorts/sections internally
  metrics: PipelineMetrics
  preparedBy: string
  meetingDate: string      // e.g. 'July 11, 2026'
  generatedAt: string      // display timestamp for the cover
  /** Embedded assets gathered by the caller (site-plan images pre-rendered to
   *  data-URIs, OM-extracted tenant rosters + occupancy). All optional. */
  extras?: {
    sitePlanImgs?: Record<string, { data: string; w: number; h: number }>
    tenants?: Record<string, DeckTenant[]>
    occupancy?: Record<string, number | null>
  }
}

// palette sampled from the firm's Investment Summary deck (hex without # for pptxgenjs)
const NAVY = '1F4864'
const STEEL = '2F6284'
const CYAN = '31B7D8'
const CYAN_LIGHT = 'A9D9E8'
const ROW_A = 'DCE6F1'
const ROW_B = 'F4F8FB'
const TEXT = '1D2429'
const MUTED = '5B6A73'
const GREEN = '2E8B57'
const RED = 'C0654E'
const SERIF = 'Garamond'
const SANS = 'Arial'

const RISK_LABEL: Record<string, string> = { core: 'Core', core_plus: 'Core-Plus', value_add: 'Value-Add', opportunistic: 'Opportunistic' }
const ASSET_LABEL: Record<string, string> = { retail: 'Retail', office: 'Office', mixed: 'Mixed-Use', industrial: 'Industrial' }
const STAGE_LABEL: Record<string, string> = {
  tracking: 'Watchlist', sourced: 'Sourced / OM', screening: 'Screening', underwriting: 'Underwriting', loi: 'LOI',
  under_contract: 'Under Contract / DD', dd: 'Due diligence', ic_approval: 'IC approval',
  closing: 'Closing', closed: 'Closed', passed: 'Passed', dead: 'Dead', lost: 'Lost',
}
const LP_LABEL: Record<string, string> = { identified: 'Identified', teaser_sent: 'Teaser sent', reviewing: 'Reviewing', soft_circle: 'Soft-circled', committed: 'Committed', passed: 'Passed' }
// stage → banner-block color for the deal-slide chip (hex without #)
const STAGE_CHIP: Record<string, string> = {
  sourced: '8FA2AD', screening: '7C9CB0', underwriting: '2F6284', loi: '3E6FB0',
  under_contract: '2E8B57', dd: '2E8B57', ic_approval: '2E8B57', closing: '2E8B57', closed: '2E8B57',
}
// Discussion order: hottest first — under contract → LOI → underwriting → sourced → closed.
const STAGE_RANK: Record<string, number> = {
  under_contract: 0, dd: 0, ic_approval: 0, closing: 0, loi: 1, underwriting: 2, screening: 2, sourced: 3, closed: 5,
}

const BOARD_ORDER = ['under_contract', 'loi', 'underwriting', 'sourced', 'closed'] as const

const fmt$ = (n: number | null | undefined) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'))
const fmtM = (n: number | null | undefined): string =>
  n == null ? '—' : n >= 1e6 ? '$' + (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M' : fmt$(n)
const pct = (d: number | null | undefined, dp = 1) => (d == null ? '—' : `${(d * 100).toFixed(dp)}%`)
const loc = (d: Deal) => [d.city, d.state].filter(Boolean).join(', ')
const profileLabel = (d: Deal) => `${RISK_LABEL[d.riskProfile] ?? d.riskProfile} ${ASSET_LABEL[d.assetType] ?? d.assetType}`
const priceLabel = (d: Deal) =>
  d.askPrice != null ? `${fmtM(d.askPrice)}${d.glaSf ? ` ($${Math.round(d.askPrice / d.glaSf)}/sf)` : ''}` : (d.priceText || '—')
const priceShort = (d: Deal) => (d.askPrice != null ? fmtM(d.askPrice) : (d.priceText || '—'))
const nextStep = (d: Deal): string =>
  d.bidText || (d.targetCloseDate ? `Target close ${d.targetCloseDate}` : '—')

/** Deal-team label: lead + analyst + any extra initials. */
function teamLabel(d: Deal): string {
  const parts: string[] = []
  if (d.leadName || d.leadInitials) parts.push(`Lead: ${d.leadName ?? d.leadInitials}`)
  if (d.analystName || d.analystInitials) parts.push(`Analyst: ${d.analystName ?? d.analystInitials}`)
  const extra = (d.team ?? []).filter(Boolean)
  if (extra.length) parts.push(`Team: ${extra.join(', ')}`)
  return parts.join('   ·   ') || '—'
}

/** Investment thesis / key points — thesis is stored as bulleted lines. */
function thesisPoints(d: Deal): string[] {
  if (!d.thesis) return []
  return d.thesis.split(/\n+/).map(s => s.replace(/^[\s•\-*]+/, '').trim()).filter(Boolean).slice(0, 6)
}

export async function buildPipelineMeetingDeck(input: MeetingDeckInput): Promise<Blob> {
  const { metrics } = input
  const { default: PptxGenJS } = await import('pptxgenjs')
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'WILKOW_LTR', width: 11, height: 8.5 })
  pptx.layout = 'WILKOW_LTR'
  pptx.author = 'M&J Wilkow'
  pptx.title = `Acquisitions Pipeline Review — ${input.meetingDate}`
  pptx.compression = true

  // Section the pipeline. Detailed slides cover the board deals (everything that
  // isn't watchlist/terminal); watchlist gets a summary appendix.
  const boardDeals = input.deals.filter(d => isActiveStage(d.stage) || d.stage === 'closed')
  const watchDeals = input.deals.filter(d => d.stage === 'tracking')
  const ordered = [...boardDeals].sort((a, b) =>
    (STAGE_RANK[a.stage] ?? 4) - (STAGE_RANK[b.stage] ?? 4) || (b.askPrice ?? 0) - (a.askPrice ?? 0))

  // A deal gets a companion Site Plan & Tenancy slide when we have either asset.
  const hasCompanion = (d: Deal): boolean =>
    !!input.extras?.sitePlanImgs?.[d.id] || !!(input.extras?.tenants?.[d.id]?.length)

  // Pre-compute slide indices so the Pipeline Summary can hyperlink each deal to
  // its discussion slide. Layout order: cover(1) · snapshot(2) · S summary pages ·
  // then per deal: discussion slide (+ optional companion slide) · watchlist.
  const PER_PAGE = 17
  const S = Math.max(1, Math.ceil(ordered.length / PER_PAGE))
  const discussionNo: Record<string, number> = {}
  { let slide = 2 + S
    for (const d of ordered) { slide += 1; discussionNo[d.id] = slide; if (hasCompanion(d)) slide += 1 } }

  let pageNo = 0
  const footer = (s: any) => {
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 8.06, w: 2.9, h: 0.44, fill: { color: CYAN } })
    s.addShape(pptx.ShapeType.rect, { x: 2.9, y: 8.06, w: 2.9, h: 0.44, fill: { color: CYAN_LIGHT } })
    s.addShape(pptx.ShapeType.rect, { x: 5.8, y: 8.06, w: 2.9, h: 0.44, fill: { color: STEEL } })
    s.addText('M&JWILKOW', { x: 8.75, y: 8.02, w: 2.05, h: 0.5, fontFace: SERIF, fontSize: 16, color: NAVY, align: 'right' })
    s.addText(String(pageNo + 1), { x: 10.45, y: 0.14, w: 0.4, h: 0.3, fontSize: 10, color: MUTED, align: 'right' })
  }
  function bodySlide(title: string, eyebrow?: string) {
    pageNo++
    const s = pptx.addSlide()
    s.addText(title, { x: 0.45, y: 0.28, w: 8.2, h: 0.55, fontFace: SERIF, fontSize: 26, bold: true, color: STEEL, underline: true })
    if (eyebrow) s.addText(eyebrow.toUpperCase(), { x: 0.47, y: 0.12, w: 8.2, h: 0.2, fontFace: SANS, fontSize: 8.5, bold: true, color: MUTED, charSpacing: 3 })
    footer(s)
    return s
  }

  // small metric tile
  const tile = (s: any, x: number, y: number, w: number, label: string, value: string, tint?: string) => {
    s.addShape(pptx.ShapeType.rect, { x, y, w, h: 0.82, fill: { color: 'FFFFFF' }, line: { color: ROW_A, width: 1 } })
    s.addText(label.toUpperCase(), { x: x + 0.1, y: y + 0.1, w: w - 0.2, h: 0.22, fontFace: SANS, fontSize: 7, bold: true, color: MUTED, charSpacing: 1 })
    s.addText(value, { x: x + 0.1, y: y + 0.32, w: w - 0.2, h: 0.44, fontFace: SERIF, fontSize: 16, bold: true, color: tint ?? NAVY })
  }

  // ── 1. Cover ──────────────────────────────────────────────────────────────
  {
    const s = pptx.addSlide()
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 11, h: 1.55, fill: { color: 'FFFFFF' } })
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 1.5, h: 1.55, fill: { color: CYAN_LIGHT } })
    s.addShape(pptx.ShapeType.rect, { x: 1.5, y: 0, w: 1.5, h: 1.55, fill: { color: STEEL } })
    s.addText('Acquisitions', { x: 3.2, y: 0.16, w: 5.6, h: 0.4, fontFace: SANS, fontSize: 12, bold: true, color: MUTED, charSpacing: 3 })
    s.addText('Pipeline Review', { x: 3.2, y: 0.5, w: 5.6, h: 0.7, fontFace: SERIF, fontSize: 34, bold: true, color: NAVY })
    s.addText('M&JWILKOW', { x: 8.5, y: 0.18, w: 2.3, h: 0.5, fontFace: SERIF, fontSize: 20, color: NAVY, align: 'right' })

    s.addShape(pptx.ShapeType.rect, { x: 0, y: 1.55, w: 11, h: 6.95, fill: { color: STEEL } })
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 1.55, w: 11, h: 0.06, fill: { color: CYAN } })
    s.addText('WEEKLY ACQUISITIONS MEETING', { x: 0.8, y: 3.15, w: 9.4, h: 0.5, fontFace: SERIF, fontSize: 20, color: CYAN_LIGHT, align: 'center', charSpacing: 4 })
    s.addText(input.meetingDate, { x: 0.8, y: 3.75, w: 9.4, h: 0.9, fontFace: SERIF, fontSize: 40, bold: true, color: 'FFFFFF', align: 'center' })
    s.addText(
      `${metrics.activeCount} active deals   ·   ${fmtM(metrics.activeVolume)} in play   ·   ${fmtM(metrics.weighted)} weighted`,
      { x: 0.8, y: 4.75, w: 9.4, h: 0.45, fontFace: SERIF, fontSize: 17, color: 'E8F4F9', align: 'center' })
    s.addText(`Prepared by ${input.preparedBy}  ·  ${input.generatedAt}`, {
      x: 0.8, y: 7.7, w: 9.4, h: 0.35, fontSize: 10, color: 'BFD8E4', align: 'center', italic: true,
    })
  }

  // ── 2. Pipeline Snapshot ────────────────────────────────────────────────────
  {
    const s = bodySlide('Pipeline Snapshot', 'Where the book stands this week')
    // KPI tiles
    const cols = 5, gap = 0.16, tW = (10.1 - gap * (cols - 1)) / cols
    const kpis: [string, string, string?][] = [
      ['Active deals', String(metrics.activeCount)],
      ['Active volume', fmtM(metrics.activeVolume)],
      ['Weighted pipeline', fmtM(metrics.weighted), STEEL],
      ['SF in play', `${Math.round(metrics.activeSf / 1000).toLocaleString()}k`],
      ['Equity committed', fmtM(metrics.committed), GREEN],
    ]
    kpis.forEach((k, i) => tile(s, 0.45 + i * (tW + gap), 1.2, tW, k[0], k[1], k[2]))

    // Left: distribution by stage
    s.addText('By stage', { x: 0.45, y: 2.35, w: 4.8, h: 0.3, fontFace: SERIF, fontSize: 15, bold: true, color: STEEL })
    const stageRows: any[] = [
      ['Stage', 'Deals', 'Volume'].map(h => ({ text: h, options: { bold: true, color: 'FFFFFF', fill: { color: STEEL }, align: h === 'Stage' ? 'left' : 'right' } })),
    ]
    BOARD_ORDER.forEach((col, i) => {
      const inCol = boardDeals.filter(d => boardColumn(d.stage) === col)
      if (!inCol.length) return
      const vol = inCol.reduce((a, d) => a + (d.askPrice ?? 0), 0)
      stageRows.push([
        { text: STAGE_LABEL[col] ?? col, options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A } } },
        { text: String(inCol.length), options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A }, align: 'right' } },
        { text: vol > 0 ? fmtM(vol) : '—', options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A }, align: 'right' } },
      ])
    })
    s.addTable(stageRows, { x: 0.45, y: 2.7, w: 4.8, colW: [2.6, 1.0, 1.2], fontFace: SERIF, fontSize: 12, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, rowH: 0.36, valign: 'middle', margin: 0.05 })

    // Right: distribution by investment profile (risk × asset)
    s.addText('By investment profile', { x: 5.6, y: 2.35, w: 4.95, h: 0.3, fontFace: SERIF, fontSize: 15, bold: true, color: STEEL })
    const byProfile = new Map<string, { n: number; vol: number }>()
    boardDeals.filter(d => d.stage !== 'closed').forEach(d => {
      const key = profileLabel(d)
      const cur = byProfile.get(key) ?? { n: 0, vol: 0 }
      cur.n += 1; cur.vol += d.askPrice ?? 0
      byProfile.set(key, cur)
    })
    const profRows: any[] = [
      ['Profile', 'Deals', 'Volume'].map(h => ({ text: h, options: { bold: true, color: 'FFFFFF', fill: { color: STEEL }, align: h === 'Profile' ? 'left' : 'right' } })),
    ]
    ;[...byProfile.entries()].sort((a, b) => b[1].vol - a[1].vol).slice(0, 8).forEach(([k, v], i) => {
      profRows.push([
        { text: k, options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A } } },
        { text: String(v.n), options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A }, align: 'right' } },
        { text: v.vol > 0 ? fmtM(v.vol) : '—', options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A }, align: 'right' } },
      ])
    })
    s.addTable(profRows, { x: 5.6, y: 2.7, w: 4.95, colW: [2.75, 1.0, 1.2], fontFace: SERIF, fontSize: 12, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, rowH: 0.36, valign: 'middle', margin: 0.05 })

    // Cadence note
    const perDeal = metrics.activeCount > 0 ? Math.round((75 / metrics.activeCount) * 10) / 10 : 0
    s.addText(
      `${ordered.length} deals on the agenda${watchDeals.length ? ` · ${watchDeals.length} on the watchlist` : ''}. ` +
      `${metrics.activeCount ? `~${perDeal} min per deal for a 75-minute meeting.` : ''}`,
      { x: 0.45, y: 7.55, w: 10.1, h: 0.3, fontFace: SERIF, fontSize: 11.5, italic: true, color: MUTED })
  }

  // ── 3. Pipeline Summary table(s) ────────────────────────────────────────────
  {
    const cols = ['Deal', 'Market', 'Profile', 'Guidance', 'Cap', 'Stage', 'Lead', 'Next / status']
    const colW = [2.4, 1.55, 1.4, 1.1, 0.6, 1.2, 0.6, 1.25]
    for (let pg = 0; pg < S; pg++) {
      const slice = ordered.slice(pg * PER_PAGE, (pg + 1) * PER_PAGE)
      const s = bodySlide(S > 1 ? `Pipeline Summary (${pg + 1}/${S})` : 'Pipeline Summary', 'All active deals, hottest first — click a name to jump to its slide')
      const rows: any[] = [cols.map((c, i) => ({ text: c, options: { bold: true, color: 'FFFFFF', fill: { color: STEEL }, align: i >= 3 && i <= 4 ? 'right' : 'left' } }))]
      slice.forEach((d, i) => {
        const bg = i % 2 ? ROW_B : ROW_A
        rows.push([
          { text: d.name, options: { color: NAVY, bold: true, fill: { color: bg }, hyperlink: { slide: discussionNo[d.id] } } },
          { text: loc(d) || '—', options: { color: TEXT, fill: { color: bg } } },
          { text: profileLabel(d), options: { color: TEXT, fill: { color: bg } } },
          { text: priceShort(d), options: { color: TEXT, fill: { color: bg }, align: 'right' } },
          { text: pct(d.goingInCap), options: { color: TEXT, fill: { color: bg }, align: 'right' } },
          { text: STAGE_LABEL[d.stage] ?? d.stage, options: { color: TEXT, fill: { color: bg } } },
          { text: d.leadInitials ?? '—', options: { color: TEXT, fill: { color: bg } } },
          { text: nextStep(d), options: { color: TEXT, fill: { color: bg }, fontSize: 10 } },
        ])
      })
      s.addTable(rows, { x: 0.45, y: 1.2, w: 10.1, colW, fontFace: SERIF, fontSize: 10.5, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, rowH: 0.355, valign: 'middle', margin: 0.05 })
    }
  }

  // ── 4. One discussion slide per deal ────────────────────────────────────────
  for (const d of ordered) {
    pageNo++
    const s = pptx.addSlide()
    const occ = input.extras?.occupancy?.[d.id] ?? null
    // header: name + location/profile subtitle + stage chip
    s.addText(d.name, { x: 0.45, y: 0.26, w: 7.6, h: 0.5, fontFace: SERIF, fontSize: 24, bold: true, color: STEEL, underline: true })
    s.addText(
      [loc(d), profileLabel(d) + (d.subType ? ` · ${d.subType}` : ''), d.submarket].filter(Boolean).join('   ·   ') || '—',
      { x: 0.47, y: 0.82, w: 7.6, h: 0.3, fontFace: SERIF, fontSize: 13, color: MUTED })
    // stage chip (top-right)
    const chip = STAGE_CHIP[d.stage] ?? STEEL
    const prob = d.stage === 'closed' ? 'Closed' : `${Math.round(d.probability * 100)}% to close`
    s.addShape(pptx.ShapeType.roundRect, { x: 8.35, y: 0.3, w: 2.2, h: 0.62, fill: { color: chip }, rectRadius: 0.08 } as any)
    s.addText(STAGE_LABEL[d.stage] ?? d.stage, { x: 8.4, y: 0.34, w: 2.1, h: 0.3, fontFace: SERIF, fontSize: 13, bold: true, color: 'FFFFFF', align: 'center' })
    s.addText(prob, { x: 8.4, y: 0.62, w: 2.1, h: 0.26, fontFace: SANS, fontSize: 9, color: 'EAF3F8', align: 'center' })
    footer(s)

    // metric tiles
    const cols = 5, gap = 0.14, tW = (10.1 - gap * (cols - 1)) / cols
    const tiles: [string, string, string?][] = [
      [d.stage === 'closed' ? 'Price' : 'Guidance', priceShort(d)],
      ['Going-in cap', pct(d.goingInCap)],
      ['Projected IRR', pct(d.projIrr), GREEN],
      ['Equity multiple', d.equityMultiple != null ? `${d.equityMultiple.toFixed(2)}x` : '—'],
      ['Equity to raise', fmtM(d.equityRequired)],
    ]
    tiles.forEach((t, i) => tile(s, 0.45 + i * (tW + gap), 1.25, tW, t[0], t[1], t[2]))

    // returns strip
    s.addText([
      { text: 'Hold ', options: { color: MUTED } }, { text: d.holdYears != null ? `${d.holdYears} yr` : '—', options: { color: TEXT, bold: true } },
      { text: '     Avg cash-on-cash ', options: { color: MUTED } }, { text: pct(d.avgCoc), options: { color: TEXT, bold: true } },
      { text: '     Exit cap ', options: { color: MUTED } }, { text: pct(d.exitCap), options: { color: TEXT, bold: true } },
      { text: '     Stabilized yield ', options: { color: MUTED } }, { text: pct(d.stabilizedYield), options: { color: TEXT, bold: true } },
      { text: '     Total cap. ', options: { color: MUTED } }, { text: fmtM(d.totalCapitalization ?? d.askPrice), options: { color: TEXT, bold: true } },
      ...(occ != null ? [{ text: '     Occupancy ', options: { color: MUTED } }, { text: pct(occ), options: { color: TEXT, bold: true } }] : []),
    ], { x: 0.47, y: 2.2, w: 10.1, h: 0.3, fontFace: SERIF, fontSize: 11 })

    // ── left column: property & deal facts ──
    const facts: [string, string][] = [
      ['Location', loc(d) || '—'],
      ['Investment profile', profileLabel(d)],
      ['Submarket', d.submarket ?? '—'],
      ['Total GLA', d.glaSf != null ? Math.round(d.glaSf).toLocaleString() + ' SF' : '—'],
      ['Year built', d.yearBuilt != null ? String(d.yearBuilt) : '—'],
      ['Purchase / guidance', priceLabel(d)],
      ['Seller', d.seller ?? '—'],
      ['Broker', d.broker ?? '—'],
      ['Deal source', d.dealSource === 'off_market' ? 'Off-market' : d.dealSource === 'marketed' ? 'Marketed' : '—'],
    ]
    const factRows = [
      [
        { text: 'The Deal', options: { bold: true, color: 'FFFFFF', fill: { color: STEEL } } },
        { text: '', options: { fill: { color: STEEL } } },
      ],
      ...facts.map(([k, v], i) => [
        { text: k, options: { bold: true, color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A } } },
        { text: v, options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A } } },
      ]),
    ]
    s.addTable(factRows as any, { x: 0.45, y: 2.6, w: 4.55, colW: [1.7, 2.85], fontFace: SERIF, fontSize: 10.5, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, rowH: 0.315, valign: 'middle', margin: 0.05 })

    // ── right column ──
    const rx = 5.25, rw = 5.3
    // thesis / key points
    s.addText('Investment thesis & key points', { x: rx, y: 2.55, w: rw, h: 0.28, fontFace: SERIF, fontSize: 13, bold: true, color: STEEL })
    const pts = thesisPoints(d)
    s.addText(
      (pts.length ? pts : ['No thesis captured yet — to be discussed.']).map(t => ({ text: t, options: { bullet: { characterCode: '2022', indent: 12 }, breakLine: true, paraSpaceAfter: 4 } })),
      { x: rx, y: 2.85, w: rw, h: 1.75, fontFace: SERIF, fontSize: 11, color: TEXT, valign: 'top' })

    // capital raise
    s.addText('Capital raise', { x: rx, y: 4.65, w: rw, h: 0.28, fontFace: SERIF, fontSize: 13, bold: true, color: STEEL })
    const committed = d.lps.reduce((a, l) => a + (l.committedAmount ?? 0), 0)
    const soft = d.lps.reduce((a, l) => a + (l.softAmount ?? 0), 0)
    const gap2 = Math.max(0, (d.equityRequired ?? 0) - committed - soft)
    s.addText([
      { text: 'Committed ', options: { color: MUTED } }, { text: fmtM(committed), options: { color: GREEN, bold: true } },
      { text: '   Soft ', options: { color: MUTED } }, { text: fmtM(soft), options: { color: TEXT, bold: true } },
      { text: '   Gap ', options: { color: MUTED } }, { text: d.equityRequired != null ? fmtM(gap2) : '—', options: { color: gap2 > 0 ? RED : GREEN, bold: true } },
    ], { x: rx, y: 4.93, w: rw, h: 0.28, fontFace: SERIF, fontSize: 11 })
    // progress bar
    const barW = rw, raise = d.equityRequired ? Math.min(1, committed / d.equityRequired) : 0
    s.addShape(pptx.ShapeType.rect, { x: rx, y: 5.25, w: barW, h: 0.13, fill: { color: ROW_A } })
    if (raise > 0) s.addShape(pptx.ShapeType.rect, { x: rx, y: 5.25, w: Math.max(0.03, barW * raise), h: 0.13, fill: { color: GREEN } })
    if (d.lps.length) {
      const top = [...d.lps].slice(0, 4)
      s.addText(
        top.map((l, i) => ({ text: `${l.partnerName} (${LP_LABEL[l.status] ?? l.status})${i < top.length - 1 ? '   ' : ''}`, options: {} })),
        { x: rx, y: 5.45, w: rw, h: 0.5, fontFace: SERIF, fontSize: 9.5, color: MUTED, valign: 'top' })
    } else {
      s.addText(d.partner ? `Targeted partner: ${d.partner}` : 'No LP engaged yet — raise to commence.', { x: rx, y: 5.45, w: rw, h: 0.3, fontFace: SERIF, fontSize: 9.5, italic: true, color: MUTED })
    }

    // status & next steps
    s.addShape(pptx.ShapeType.rect, { x: rx, y: 6.15, w: rw, h: 1.35, fill: { color: ROW_B }, line: { color: ROW_A, width: 1 } })
    s.addText('STATUS & NEXT STEPS', { x: rx + 0.12, y: 6.24, w: rw - 0.24, h: 0.22, fontFace: SANS, fontSize: 7.5, bold: true, color: STEEL, charSpacing: 2 })
    s.addText([
      { text: nextStep(d), options: { color: TEXT, bold: true, breakLine: true } },
      ...(d.stage === 'lost' || d.stage === 'passed' || d.stage === 'dead'
        ? [{ text: d.lostReason ? `Reason: ${d.lostReason}` : '', options: { color: RED, breakLine: true } as any }]
        : []),
      { text: teamLabel(d), options: { color: MUTED, breakLine: true } },
    ], { x: rx + 0.12, y: 6.48, w: rw - 0.24, h: 0.95, fontFace: SERIF, fontSize: 10.5, valign: 'top', lineSpacingMultiple: 1.15 })

    // ── companion slide: site plan (rendered image) + tenant roster ──
    const img = input.extras?.sitePlanImgs?.[d.id]
    const tlist = input.extras?.tenants?.[d.id] ?? []
    if (img || tlist.length) {
      const sp = bodySlide(`${d.name} — Site Plan & Tenancy`, 'Reference')
      const hasImg = !!img
      if (img) {
        const box = { x: 0.45, y: 1.25, w: 6.0, h: 6.45 }
        const ratio = img.w / img.h
        let dw = box.w, dh = box.w / ratio
        if (dh > box.h) { dh = box.h; dw = box.h * ratio }
        const ix = box.x + (box.w - dw) / 2, iy = box.y + (box.h - dh) / 2
        sp.addShape(pptx.ShapeType.rect, { x: box.x, y: box.y, w: box.w, h: box.h, fill: { color: ROW_B }, line: { color: ROW_A, width: 1 } })
        sp.addImage({ data: img.data, x: ix, y: iy, w: dw, h: dh })
        if (img.title) sp.addText(img.title, { x: box.x, y: 7.72, w: box.w, h: 0.28, fontFace: SANS, fontSize: 8, italic: true, color: MUTED, align: 'center' } as any)
      }
      const tx = hasImg ? 6.7 : 0.45
      const tw = hasImg ? 3.85 : 10.1
      sp.addText([
        { text: 'Occupancy ', options: { color: MUTED } }, { text: pct(occ), options: { color: TEXT, bold: true } },
        { text: '     GLA ', options: { color: MUTED } }, { text: d.glaSf != null ? Math.round(d.glaSf).toLocaleString() + ' SF' : '—', options: { color: TEXT, bold: true } },
      ], { x: tx, y: 1.25, w: tw, h: 0.3, fontFace: SERIF, fontSize: 11 })
      if (tlist.length) {
        const tRows: any[] = [
          ['Tenant', 'SF', 'Expiry'].map((h, i) => ({ text: h, options: { bold: true, color: 'FFFFFF', fill: { color: STEEL }, align: i ? 'right' : 'left' } })),
          ...tlist.slice(0, 15).map((t, i) => [
            { text: t.name, options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A } } },
            { text: t.sf != null ? Math.round(t.sf).toLocaleString() : '—', options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A }, align: 'right' } },
            { text: t.expiration ?? '—', options: { color: TEXT, fill: { color: i % 2 ? ROW_B : ROW_A }, align: 'right' } },
          ]),
        ]
        sp.addTable(tRows, { x: tx, y: 1.62, w: tw, colW: hasImg ? [2.15, 0.9, 0.8] : [5.5, 2.3, 2.3], fontFace: SERIF, fontSize: 10, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, rowH: 0.32, valign: 'middle', margin: 0.04 })
      } else {
        sp.addText('Tenant roster not captured from the OM.', { x: tx, y: 1.66, w: tw, h: 0.3, fontFace: SERIF, fontSize: 10.5, italic: true, color: MUTED })
      }
      if (!hasImg) sp.addText('Site plan not available for this property.', { x: 0.45, y: 7.5, w: 10.1, h: 0.3, fontFace: SERIF, fontSize: 10.5, italic: true, color: MUTED })
    }
  }

  // ── 5. Watchlist appendix ───────────────────────────────────────────────────
  if (watchDeals.length) {
    const s = bodySlide('Watchlist', 'Tracked for reference — not actively pursued')
    const rows: any[] = [
      ['Deal', 'Market', 'Profile', 'Guidance', 'Notes'].map((c, i) => ({ text: c, options: { bold: true, color: 'FFFFFF', fill: { color: STEEL }, align: i === 3 ? 'right' : 'left' } })),
    ]
    watchDeals.slice(0, 18).forEach((d, i) => {
      const bg = i % 2 ? ROW_B : ROW_A
      rows.push([
        { text: d.name, options: { color: TEXT, bold: true, fill: { color: bg } } },
        { text: loc(d) || '—', options: { color: TEXT, fill: { color: bg } } },
        { text: profileLabel(d), options: { color: TEXT, fill: { color: bg } } },
        { text: priceShort(d), options: { color: TEXT, fill: { color: bg }, align: 'right' } },
        { text: d.bidText ?? '—', options: { color: TEXT, fill: { color: bg }, fontSize: 10 } },
      ])
    })
    s.addTable(rows, { x: 0.45, y: 1.2, w: 10.1, colW: [2.7, 1.9, 1.7, 1.2, 2.6], fontFace: SERIF, fontSize: 10.5, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, rowH: 0.355, valign: 'middle', margin: 0.05 })
    if (watchDeals.length > 18) s.addText(`+ ${watchDeals.length - 18} more on the watchlist`, { x: 0.45, y: 7.55, w: 10.1, h: 0.3, fontFace: SERIF, fontSize: 11, italic: true, color: MUTED })
  }

  try {
    const blob = await pptx.write({ outputType: 'blob' })
    console.log(`[meeting-deck generated] ${(blob.size / 1024 / 1024).toFixed(2)} MB, ${pageNo + 1} slides`)
    return blob as Blob
  } catch (e) {
    console.error('[meeting-deck generation error]', e)
    throw new Error(`PowerPoint generation failed: ${e instanceof Error ? e.message : 'unknown error'}`)
  }
}
