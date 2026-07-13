// Excel export for the /waterfall "Sold Today" analysis.
//
// The workbook is genuinely LIVE where the math is closed-form: the Sources &
// Uses cascade recomputes from the editable Assumptions cells, and every IRR /
// equity-multiple / per-unit / share figure is an Excel formula (XIRR over the
// dated flows on the Capital Flows sheet). The IRR-hurdle *ladder allocation*
// (which tier each dollar lands in) comes from the app's solver and is written
// as model-output values — reproducing the solver in cell formulas isn't
// practical — so those cells are clearly labelled. The Methodology tab spells
// this out. exceljs is dynamic-imported to stay out of the main bundle.
import type { DatedFlow } from '../lib/waterfall'

export interface WfTier {
  order: number
  lpSplit: number
  gpSplit: number
  hurdleIrr: number | null
  hurdleEm: number | null
  lp: number
  gp: number
  reachedHurdle: boolean
  emGoverned: boolean
}

export interface WfClass {
  key: string          // 'D' | 'A' | 'B'
  label: string
  contrib: number
  prior: number
  take: number
  irr: number | null
  unitKey: string | null   // key into units map for per-unit
  flows: DatedFlow[]
}

export interface WaterfallXlsxInput {
  propertyName: string
  asOf: string
  deemedDate: string        // freeze date or as-of; the date the sale flow is dated for XIRR
  generatedAt: string
  lpName: string
  l2Name: string | null

  inputs: {
    grossValue: number
    closingPct: number       // percent, e.g. 1.5
    nca: number
    payoff: number
    payoffLabel: string
    entityCash: number
  }
  override: { threshold: number; lp: number; gp: number } | null
  cashSplit: { lp: number; gp: number } | null
  freezeDate: string | null

  result: {
    priceNetOfCosts: number
    overrideExcess: number
    overrideLp: number
    overrideGp: number
    cashLp: number
    cashGp: number
    ladderPool: number
    ladderLpTake: number      // result.l1.lpTake (ROC + prefs + tier LP legs)
    ladderGpTake: number      // result.l1.gpTake
    returnOfCapital: number
    residualCash: number
    l1LpContrib: number
    l1LpPriorDist: number
    l1LpTotal: number
    l1LpIrr: number | null
    l1GpTotal: number
    tiers: WfTier[]
  }

  l1LpFlows: DatedFlow[]
  l1GpFlows: DatedFlow[]

  l2: null | {
    pool: number
    units: Record<string, number>
    classes: WfClass[]
  }

  sensitivity: Array<{
    m: number
    gross: number
    l1LpTotal: number
    l1LpIrr: number | null
    l1GpTotal: number
    classBValue: number | null
    bPerUnit: number | null
  }>
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const WILKOW = 'FF466371'
const USD = '$#,##0'
const USD2 = '$#,##0.00'
const PCT = '0.00%'
const MULT = '0.00"x"'

export async function buildWaterfallXlsx(input: WaterfallXlsxInput): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'M&J Wilkow Asset Management Platform'
  wb.title = `${input.propertyName} — Waterfall (Sold Today)`

  // ── date parsing (no timezone drift) ──
  const toDate = (iso: string): Date => {
    const [y, m, d] = iso.split('-').map(Number)
    return new Date(y, (m ?? 1) - 1, d ?? 1)
  }

  // ── shared header styling ──
  const brandHeader = (row: any, ncols: number) => {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
    row.height = 18
    for (let c = 1; c <= ncols; c++) row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WILKOW } }
  }
  const titleRow = (ws: any, text: string) => {
    const r = ws.addRow([text])
    r.font = { bold: true, size: 14, color: { argb: WILKOW } }
    ws.addRow([])
    return r
  }

  // ══ 1. Assumptions ══════════════════════════════════════════════════════════
  const as = wb.addWorksheet('Assumptions')
  as.getColumn(1).width = 32
  as.getColumn(2).width = 18
  as.getColumn(3).width = 40
  titleRow(as, `${input.propertyName} — Sale Assumptions`)

  // label, value, format, note → track the value cell address per key
  const A: Record<string, string> = {}
  const addAssume = (key: string, label: string, value: number | string, fmt: string | null, note?: string) => {
    const r = as.addRow([label, value, note ?? ''])
    if (fmt) r.getCell(2).numFmt = fmt
    r.getCell(1).font = { bold: true }
    r.getCell(3).font = { italic: true, color: { argb: 'FF8FA2AD' }, size: 9 }
    A[key] = `Assumptions!$B$${r.number}`
  }
  addAssume('gross', 'Gross sale value', input.inputs.grossValue, USD, 'Editable — drives the whole cascade')
  addAssume('closing', 'Closing costs %', input.inputs.closingPct / 100, PCT, 'Editable')
  addAssume('nca', 'Net current assets', input.inputs.nca, USD, 'From GL balance sheet / stored default')
  addAssume('payoff', input.inputs.payoffLabel, input.inputs.payoff, USD, 'Debt or preferred-equity payoff')
  if (input.l2) addAssume('entityCash', 'Entity cash (Layer 2)', input.inputs.entityCash, USD)
  if (input.override) {
    addAssume('ovThreshold', 'Sale-price override threshold', input.override.threshold, USD, 'Excess over this splits outside the ladder')
    addAssume('ovLp', 'Override LP share', input.override.lp, PCT)
    addAssume('ovGp', 'Override MJW share', input.override.gp, PCT)
  }
  if (input.cashSplit) {
    addAssume('csLp', 'Cash-on-hand LP share', input.cashSplit.lp, PCT, 'NCA routed around the waterfall (Net Cash Flow)')
    addAssume('csGp', 'Cash-on-hand MJW share', input.cashSplit.gp, PCT)
  }
  const asOfRow = as.addRow(['As-of date', toDate(input.asOf), input.freezeDate ? `IRR hurdles frozen at ${input.freezeDate}` : ''])
  asOfRow.getCell(1).font = { bold: true }
  asOfRow.getCell(2).numFmt = 'yyyy-mm-dd'
  asOfRow.getCell(3).font = { italic: true, color: { argb: 'FF8FA2AD' }, size: 9 }

  // ══ 2. Sources & Uses — fully live from Assumptions ═══════════════════════════
  const su = wb.addWorksheet('Sources & Uses')
  su.getColumn(1).width = 44
  su.getColumn(2).width = 18
  su.getColumn(3).width = 46
  titleRow(su, 'Sources & Uses — Waterfall Pool')
  const suHead = su.addRow(['Line', 'Amount', 'Formula / basis'])
  brandHeader(suHead, 3)

  const SU: Record<string, string> = {}
  const f = (label: string, formula: string, result: number, note: string, key?: string) => {
    const r = su.addRow([label, { formula, result } as any, note])
    r.getCell(2).numFmt = USD
    r.getCell(3).font = { italic: true, color: { argb: 'FF8FA2AD' }, size: 9 }
    if (key) SU[key] = `'Sources & Uses'!$B$${r.number}`
    return r
  }

  f('Gross sale value', `=${A.gross}`, input.inputs.grossValue, 'Assumptions', 'gross')
  const closingResult = -(input.inputs.grossValue - input.result.priceNetOfCosts)
  f('Closing costs', `=-${A.gross}*${A.closing}`, closingResult, 'Gross x closing %', 'closing')
  f('Price net of closing costs', `=${A.gross}*(1-${A.closing})`, input.result.priceNetOfCosts, 'Gross x (1 - closing %)', 'priceNet')
  if (input.override) {
    f('Sale-price override excess', `=MAX(0,${SU.priceNet}-${A.ovThreshold})`, input.result.overrideExcess, 'Excess of net price over threshold', 'ovExcess')
    f('  · to LP (outside ladder)', `=${SU.ovExcess}*${A.ovLp}`, input.result.overrideLp, 'Override excess x LP share', 'ovLp')
    f('  · to MJW (outside ladder)', `=${SU.ovExcess}*${A.ovGp}`, input.result.overrideGp, 'Override excess x MJW share', 'ovGp')
  }
  f(input.inputs.payoffLabel, `=-${A.payoff}`, -input.inputs.payoff, 'Payoff', 'payoff')
  if (input.cashSplit) {
    f('Cash on hand — to LP', `=${A.nca}*${A.csLp}`, input.result.cashLp, 'NCA x LP share (Net Cash Flow)', 'cashLp')
    f('Cash on hand — to MJW', `=${A.nca}*${A.csGp}`, input.result.cashGp, 'NCA x MJW share (Net Cash Flow)', 'cashGp')
    f('Net current assets into pool', '=0', 0, 'Routed around the waterfall', 'ncaPool')
  } else {
    f('Net current assets into pool', `=${A.nca}`, input.inputs.nca, 'NCA flows through the ladder', 'ncaPool')
  }
  const ovTerm = input.override ? `-${SU.ovExcess}` : ''
  const poolRow = f('Waterfall pool (Layer 1)', `=MAX(0,${SU.priceNet}-${A.payoff}${ovTerm}+${SU.ncaPool})`, input.result.ladderPool, 'Net price - payoff - override + NCA', 'pool')
  poolRow.font = { bold: true }
  poolRow.getCell(2).numFmt = USD

  // ══ 3. Capital Flows (feeds XIRR) ═════════════════════════════════════════════
  const fl = wb.addWorksheet('Capital Flows')
  fl.getColumn(1).width = 26
  fl.getColumn(2).width = 14
  fl.getColumn(3).width = 18
  titleRow(fl, 'Dated Capital Flows (for XIRR)')
  const flHead = fl.addRow(['Series', 'Date', 'Amount'])
  brandHeader(flHead, 3)

  // Write a series' historical flows + a final "sold-today" row whose amount is a
  // formula ref to the summary total. Returns the XIRR-able ranges.
  const writeSeries = (label: string, flows: DatedFlow[], takeFormula: string, takeResult: number) => {
    const start = fl.rowCount + 1
    for (const fw of flows) {
      const r = fl.addRow([label, toDate(fw.date), fw.amount])
      r.getCell(2).numFmt = 'yyyy-mm-dd'
      r.getCell(3).numFmt = USD
    }
    const rr = fl.addRow([`${label} — sold-today`, toDate(input.deemedDate), { formula: takeFormula, result: takeResult } as any])
    rr.getCell(2).numFmt = 'yyyy-mm-dd'
    rr.getCell(3).numFmt = USD
    rr.font = { bold: true }
    const end = fl.rowCount
    return { amt: `'Capital Flows'!$C$${start}:$C$${end}`, dt: `'Capital Flows'!$B$${start}:$B$${end}` }
  }

  // ══ 4. Layer 1 ════════════════════════════════════════════════════════════════
  const l1 = wb.addWorksheet('Layer 1 — JV Waterfall')
  l1.getColumn(1).width = 40
  l1.getColumn(2).width = 18
  l1.getColumn(3).width = 44
  titleRow(l1, 'Layer 1 — JV Waterfall')

  const L1: Record<string, string> = {}
  const l1line = (label: string, value: number | { formula: string; result: number }, fmt: string, note = '', key?: string, bold = false) => {
    const r = l1.addRow([label, value as any, note])
    r.getCell(2).numFmt = fmt
    if (bold) r.getCell(1).font = r.getCell(2).font = { bold: true }
    r.getCell(3).font = { italic: true, color: { argb: 'FF8FA2AD' }, size: 9 }
    if (key) L1[key] = `'Layer 1 — JV Waterfall'!$B$${r.number}`
    return r
  }

  const lpHead = l1.addRow([input.lpName]); lpHead.font = { bold: true, color: { argb: WILKOW } }
  l1line('Contributed to date', input.result.l1LpContrib, USD, 'From flow history', 'lpContrib')
  l1line('Distributed to date', input.result.l1LpPriorDist, USD, 'From flow history', 'lpPrior')
  l1line('Ladder distribution (ROC + prefs + tiers)', input.result.ladderLpTake, USD, 'Model output — IRR-hurdle solver', 'ladderLp')
  if (input.override) l1line('Override leg', { formula: `=${SU.ovLp}`, result: input.result.overrideLp }, USD, 'Live from Sources & Uses', 'ovLp')
  if (input.cashSplit) l1line('Cash-on-hand leg', { formula: `=${SU.cashLp}`, result: input.result.cashLp }, USD, 'Live from Sources & Uses', 'cashLp')
  const lpTotalFormula = `=${L1.ladderLp}${input.override ? `+${L1.ovLp}` : ''}${input.cashSplit ? `+${L1.cashLp}` : ''}`
  l1line('LP sale distribution (total)', { formula: lpTotalFormula, result: input.result.l1LpTotal }, USD, 'Ladder + override + cash legs', 'lpTotal', true)

  const lpRanges = writeSeries(input.lpName, input.l1LpFlows, `=${L1.lpTotal}`, input.result.l1LpTotal)
  l1line('LP IRR (if sold today)', { formula: `=XIRR(${lpRanges.amt},${lpRanges.dt})`, result: input.result.l1LpIrr ?? 0 }, PCT, 'Live XIRR over LP flows + sale take', 'lpIrr')
  l1line('LP equity multiple', { formula: `=(${L1.lpPrior}+${L1.lpTotal})/${L1.lpContrib}`, result: input.result.l1LpContrib > 0 ? (input.result.l1LpPriorDist + input.result.l1LpTotal) / input.result.l1LpContrib : 0 }, MULT, 'Live: (distributed + sale) / contributed', 'lpEm')

  l1.addRow([])
  const gpHead = l1.addRow(['M&J Wilkow (sponsor)']); gpHead.font = { bold: true, color: { argb: WILKOW } }
  l1line('Ladder distribution (all tier legs)', input.result.ladderGpTake, USD, 'Model output — IRR-hurdle solver', 'ladderGp')
  if (input.override) l1line('Override leg', { formula: `=${SU.ovGp}`, result: input.result.overrideGp }, USD, 'Live from Sources & Uses', 'ovGp')
  if (input.cashSplit) l1line('Cash-on-hand leg', { formula: `=${SU.cashGp}`, result: input.result.cashGp }, USD, 'Live from Sources & Uses', 'cashGp')
  const gpTotalFormula = `=${L1.ladderGp}${input.override ? `+${L1.ovGp}` : ''}${input.cashSplit ? `+${L1.cashGp}` : ''}`
  l1line('MJW sale distribution (total)', { formula: gpTotalFormula, result: input.result.l1GpTotal }, USD, 'Ladder + override + cash legs', 'gpTotal', true)
  l1line('MJW share of total', { formula: `=${L1.gpTotal}/(${L1.lpTotal}+${L1.gpTotal})`, result: (input.result.l1LpTotal + input.result.l1GpTotal) > 0 ? input.result.l1GpTotal / (input.result.l1LpTotal + input.result.l1GpTotal) : 0 }, PCT, 'Live', 'gpShare')

  // Tier detail
  l1.addRow([])
  const tierTitle = l1.addRow(['Tier detail — IRR ladder']); tierTitle.font = { bold: true, color: { argb: WILKOW } }
  const tHead = l1.addRow(['Leg', 'Split LP/MJW', 'Hurdle', input.lpName, 'MJW', 'Status'])
  brandHeader(tHead, 6)
  l1.getColumn(4).width = 18
  l1.getColumn(5).width = 16
  l1.getColumn(6).width = 22
  if (input.result.returnOfCapital > 0.5) {
    const r = l1.addRow(['Return of capital', '100/0', '—', input.result.returnOfCapital, 0, 'preference'])
    r.getCell(4).numFmt = USD; r.getCell(5).numFmt = USD
  }
  const tierFirst = l1.rowCount + 1
  for (const t of input.result.tiers) {
    const hurdle = t.hurdleIrr == null && t.hurdleEm == null ? 'residual'
      : [t.hurdleIrr != null ? `${(t.hurdleIrr * 100).toFixed(0)}% IRR` : null, t.hurdleEm != null ? `${t.hurdleEm.toFixed(2)}x` : null].filter(Boolean).join(' / ')
    const status = t.hurdleIrr == null && t.hurdleEm == null ? 'residual'
      : t.reachedHurdle ? (t.emGoverned ? 'met (EM governed)' : 'met') : 'cash exhausted'
    const r = l1.addRow([`Tier ${t.order}`, `${Math.round(t.lpSplit * 100)}/${Math.round(t.gpSplit * 100)}`, hurdle, t.lp, t.gp, status])
    r.getCell(4).numFmt = USD; r.getCell(5).numFmt = USD
  }
  const tierLast = l1.rowCount
  if (input.override && input.result.overrideExcess > 0.5) {
    const r = l1.addRow(['Sale-price override', `${Math.round(input.override.lp * 100)}/${Math.round(input.override.gp * 100)}`, `> ${(input.override.threshold / 1e6).toFixed(0)}M`, { formula: `=${SU.ovLp}`, result: input.result.overrideLp } as any, { formula: `=${SU.ovGp}`, result: input.result.overrideGp } as any, 'outside IRR ladder'])
    r.getCell(4).numFmt = USD; r.getCell(5).numFmt = USD
  }
  if (input.cashSplit && (input.result.cashLp > 0.5 || input.result.cashGp > 0.5)) {
    const r = l1.addRow(['Cash on hand', `${Math.round(input.cashSplit.lp * 100)}/${Math.round(input.cashSplit.gp * 100)}`, '—', { formula: `=${SU.cashLp}`, result: input.result.cashLp } as any, { formula: `=${SU.cashGp}`, result: input.result.cashGp } as any, 'Net Cash Flow leg'])
    r.getCell(4).numFmt = USD; r.getCell(5).numFmt = USD
  }
  // Ladder subtotal (live SUM of tier rows + ROC)
  const totRow = l1.addRow(['Ladder subtotal', '', '', { formula: `=SUM(D${tierFirst - (input.result.returnOfCapital > 0.5 ? 1 : 0)}:D${tierLast})`, result: input.result.ladderLpTake } as any, { formula: `=SUM(E${tierFirst}:E${tierLast})`, result: input.result.ladderGpTake } as any, ''])
  totRow.font = { bold: true }
  totRow.getCell(4).numFmt = USD; totRow.getCell(5).numFmt = USD

  // ══ 5. Layer 2 — class returns ════════════════════════════════════════════════
  if (input.l2) {
    const l2 = wb.addWorksheet('Layer 2 — Class Returns')
    l2.getColumn(1).width = 24
    ;[2, 3, 4, 5, 6, 7].forEach(c => (l2.getColumn(c).width = 16))
    titleRow(l2, `Layer 2 — ${input.l2Name ?? 'M&J entity'} Class Returns`)
    const poolRow2 = l2.addRow(['Layer 2 pool', { formula: `=${L1.gpTotal}${input.inputs.entityCash ? `+${A.entityCash}` : ''}`, result: input.l2.pool } as any, 'MJW Layer-1 take + entity cash (live)'])
    poolRow2.getCell(2).numFmt = USD
    poolRow2.getCell(1).font = { bold: true }
    poolRow2.getCell(3).font = { italic: true, color: { argb: 'FF8FA2AD' }, size: 9 }
    l2.addRow([])
    const cHead = l2.addRow(['Class', 'Contributed', 'Distributed', 'Sold-today', 'IRR', 'Multiple', 'Per unit'])
    brandHeader(cHead, 7)

    for (const cl of input.l2.classes) {
      const r = l2.addRow([cl.label, cl.contrib, cl.prior, cl.take, null, null, null])
      const takeCell = `'Layer 2 — Class Returns'!$D$${r.number}`
      const contribCell = `'Layer 2 — Class Returns'!$B$${r.number}`
      const priorCell = `'Layer 2 — Class Returns'!$C$${r.number}`
      r.getCell(2).numFmt = USD; r.getCell(3).numFmt = USD; r.getCell(4).numFmt = USD
      // live IRR via a flow series on the Capital Flows sheet
      if (cl.contrib > 0 && cl.flows.length > 0) {
        const rng = writeSeries(`${input.l2Name ?? 'L2'} ${cl.label}`, cl.flows, `=${takeCell}`, cl.take)
        r.getCell(5).value = { formula: `=XIRR(${rng.amt},${rng.dt})`, result: cl.irr ?? 0 } as any
        r.getCell(5).numFmt = PCT
        r.getCell(6).value = { formula: `=(${priorCell}+${takeCell})/${contribCell}`, result: (cl.prior + cl.take) / cl.contrib } as any
        r.getCell(6).numFmt = MULT
      } else {
        r.getCell(5).value = '—'; r.getCell(6).value = '—'
      }
      const units = cl.unitKey ? (input.l2.units[cl.unitKey] ?? 0) : 0
      if (units > 0) {
        r.getCell(7).value = { formula: `=${takeCell}/${units}`, result: cl.take / units } as any
        r.getCell(7).numFmt = USD2
      } else {
        r.getCell(7).value = '—'
      }
    }
  }

  // ══ 6. Sensitivity (model outputs) ════════════════════════════════════════════
  const sn = wb.addWorksheet('Sensitivity')
  ;[1, 2, 3, 4, 5, 6].forEach(c => (sn.getColumn(c).width = 18))
  titleRow(sn, 'Value Sensitivity (model outputs, gross value ±10%)')
  const snCols = ['Gross value', input.lpName, 'LP IRR', 'MJW take']
  if (input.l2) snCols.push('Class B value', 'B / unit')
  const snHead = sn.addRow(snCols)
  brandHeader(snHead, snCols.length)
  for (const s of input.sensitivity) {
    const row: any[] = [s.gross, s.l1LpTotal, s.l1LpIrr ?? '—', s.l1GpTotal]
    if (input.l2) row.push(s.classBValue ?? 0, s.bPerUnit ?? '—')
    const r = sn.addRow(row)
    r.getCell(1).numFmt = USD; r.getCell(2).numFmt = USD; r.getCell(4).numFmt = USD
    if (typeof s.l1LpIrr === 'number') r.getCell(3).numFmt = PCT
    if (input.l2) { r.getCell(5).numFmt = USD; if (typeof s.bPerUnit === 'number') r.getCell(6).numFmt = USD }
    if (Math.abs(s.m - 1) < 1e-9) r.font = { bold: true }
  }

  // ══ 7. Methodology ════════════════════════════════════════════════════════════
  const md = wb.addWorksheet('Methodology')
  md.getColumn(1).width = 110
  const h = (t: string) => { const r = md.addRow([t]); r.font = { bold: true, size: 12, color: { argb: WILKOW } } }
  const p = (t: string) => { const r = md.addRow([t]); r.alignment = { wrapText: true, vertical: 'top' } }
  h(`${input.propertyName} — Sold-Today Waterfall Methodology`)
  p(`Generated ${input.generatedAt}. As-of ${input.asOf}${input.freezeDate ? ` (IRR hurdles deemed frozen at ${input.freezeDate} per the JV amendment)` : ''}.`)
  md.addRow([])
  h('What recomputes live in this workbook')
  p('• Sources & Uses: every line is an Excel formula referencing the editable cells on the Assumptions tab. Change the Gross sale value (or closing %, payoff, NCA) and the waterfall pool updates.')
  p('• IRR and equity multiples: computed with =XIRR / cell formulas over the dated flows on the Capital Flows tab, including the sold-today distribution as the final flow. Per-unit and share-of-total figures are also live formulas.')
  p('• Layer 2 pool = MJW’s Layer-1 take + entity cash (live), so it tracks Layer 1.')
  md.addRow([])
  h('What is a model output (written as values, not formulas)')
  p('• The IRR-hurdle LADDER ALLOCATION — how the pool splits across return-of-capital, preferred return, and each promote tier — comes from the app’s solver (src/lib/waterfall.ts). It finds the exact distribution that carries the LP to each tier’s IRR (or equity-multiple) hurdle before the promote steps up. This closed-form solver is not reproduced in cell formulas; the tier LP/MJW amounts are the solver’s output. Editing the pool in Excel will NOT re-run the ladder — regenerate from the app for a new pool.')
  p('• The Sensitivity tab is a set of full model runs at ±10% gross value, written as values.')
  md.addRow([])
  h('Payment order (per the operating agreements)')
  p('1. Preferred equity: return (cash or PIK accrual) + principal redemption when current.')
  p('2. Return of LP capital (pro-rata by contribution).')
  p('3. LP preferred return (accrues on unreturned capital).')
  p('4. GP catch-up (100% to GP until it reaches its promote %).')
  p('5. Promote split (remaining cash splits LP/MJW at the tier percentages).')
  if (input.override) p(`• Sale-price override: proceeds above ${(input.override.threshold / 1e6).toFixed(0)}M (measured on price net of closing costs) split ${Math.round(input.override.lp * 100)}/${Math.round(input.override.gp * 100)} LP/MJW, outside the IRR ladder.`)
  if (input.cashSplit) p(`• Cash on hand at closing splits ${Math.round(input.cashSplit.lp * 100)}/${Math.round(input.cashSplit.gp * 100)} LP/MJW as Net Cash Flow, outside the waterfall.`)
  p('• Layer 2 Class A preferences are the LESSER of the IRR hurdle and the equity-multiple cap; prior distributions count toward the multiple, so the EM leg can govern.')
  md.addRow([])
  p('Tier terms verified against the executed operating agreements; flow history from the distribution workbooks. Confidential — internal use only.')

  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], { type: XLSX_MIME })
}
