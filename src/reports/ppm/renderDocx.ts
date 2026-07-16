// PPM generator — Word (.docx) renderers.
//
// Three documents, matching the firm's PPM package:
//   buildPpmDocx()          - the main memorandum body (exec table + all sections)
//   buildOfferingPageDocx() - the personalized one-page offering cover
//   buildRiskFactorsDocx()  - the standing Risk Factors page set
//
// Dynamic-imported by PpmBuilderPage so `docx` + the boilerplate text stay out
// of the main bundle. Editable Word output on purpose: the author finishes the
// document in Word exactly like every prior deal.

import {
  AlignmentType, BorderStyle, Document, Packer, Paragraph, Table, TableCell,
  TableRow, TextRun, WidthType,
} from 'docx'
import {
  PPM_SECTIONS, fmtMoney, fmtMult, fmtNum, fmtPct, fmtPsf, sectionTitle,
  type PpmDataSheet,
} from '../../lib/ppm/template'
import type { PpmSectionState } from '../../hooks/usePpmDrafts'
import {
  RISK_FACTORS, RISK_FACTORS_INTRO, RISK_FACTORS_LEGENDS, RISK_FACTORS_TITLE,
  buildOfferingPage,
} from '../../lib/ppm/boilerplate'

const FONT = 'Times New Roman'
const SIZE = 22            // half-points -> 11pt
const HEADING_SIZE = 24    // 12pt

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } as const
const NO_BORDERS = {
  top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER,
  insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
}
const THIN = { style: BorderStyle.SINGLE, size: 4, color: '999999' } as const
const GRID_BORDERS = { top: THIN, bottom: THIN, left: THIN, right: THIN, insideHorizontal: THIN, insideVertical: THIN }

const run = (text: string, opts: { bold?: boolean; caps?: boolean; size?: number } = {}) =>
  new TextRun({ text, bold: opts.bold, allCaps: opts.caps, font: FONT, size: opts.size ?? SIZE })

const para = (text: string, opts: { bold?: boolean; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; after?: number; before?: number } = {}) =>
  new Paragraph({
    alignment: opts.align ?? AlignmentType.JUSTIFIED,
    spacing: { after: opts.after ?? 160, before: opts.before ?? 0 },
    children: [run(text, { bold: opts.bold })],
  })

function sectionHeading(title: string): Paragraph[] {
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 320, after: 60 },
      children: [run(title.toUpperCase(), { bold: true, size: HEADING_SIZE })],
    }),
    new Paragraph({
      spacing: { after: 200 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000' } },
      children: [],
    }),
  ]
}

/** True for a short standalone line that reads as a subsection lead-in. */
const isSubheading = (line: string) =>
  line.length < 80 && !line.endsWith('.') && !line.endsWith(':') && !line.includes('\t') &&
  /^[A-Z0-9"]/.test(line) && line.split(' ').length <= 10

/** Borderless label/value table for tab-delimited blocks (property details, wire). */
function tabbedTable(lines: string[]): Table {
  const rows = lines.map(line => {
    const idx = line.indexOf('\t')
    const label = idx >= 0 ? line.slice(0, idx) : line
    const value = idx >= 0 ? line.slice(idx + 1).replace(/\t/g, '   ') : ''
    const cell = (text: string, width: number, bold = false) =>
      new TableCell({
        borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
        width: { size: width, type: WidthType.PERCENTAGE },
        children: text.split('\n').map(t => new Paragraph({ spacing: { after: 40 }, children: [run(t, { bold })] })),
      })
    return new TableRow({ children: [cell(label, 32, true), cell(value, 68)] })
  })
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: NO_BORDERS, rows })
}

/** Render section prose: \n\n paragraphs; tab-bearing blocks become tables; short standalone lines become bold lead-ins. */
function renderRichText(text: string): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = []
  for (const block of text.split(/\n\s*\n/)) {
    const trimmed = block.replace(/\s+$/, '')
    if (!trimmed) continue
    const lines = trimmed.split('\n')
    if (lines.some(l => l.includes('\t'))) {
      out.push(tabbedTable(lines))
      out.push(new Paragraph({ spacing: { after: 120 }, children: [] }))
      continue
    }
    if (lines.length === 1 && isSubheading(lines[0])) {
      out.push(para(lines[0], { bold: true, align: AlignmentType.LEFT, before: 160, after: 100 }))
      continue
    }
    out.push(para(lines.join(' ')))
  }
  return out
}

function gridTable(header: string[], rows: string[][], widths?: number[]): Table {
  const mk = (text: string, bold: boolean, i: number) =>
    new TableCell({
      width: widths ? { size: widths[i], type: WidthType.PERCENTAGE } : undefined,
      children: [new Paragraph({ alignment: i === 0 ? AlignmentType.LEFT : AlignmentType.CENTER, spacing: { after: 20 }, children: [run(text, { bold, size: 18 })] })],
    })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: GRID_BORDERS,
    rows: [
      new TableRow({ children: header.map((h, i) => mk(h, true, i)) }),
      ...rows.map(r => new TableRow({ children: r.map((c, i) => mk(c, false, i)) })),
    ],
  })
}

// ---------------------------------------------------------------------------
// Data-sheet-driven tables
// ---------------------------------------------------------------------------

function execSummaryTable(ds: PpmDataSheet): Table {
  const recap = ds.dealStructure === 'pref_equity_recap'
  const common: [string, string][] = [
    ['Location', [ds.address, [ds.city, ds.state].filter(Boolean).join(', ')].filter(Boolean).join(', ')],
    ['Property Type/Risk Profile', ds.propertyType],
    ['Rentable Area/Land Area', `${fmtNum(ds.glaSf)} Square Feet${ds.landAcres != null ? ` - ${ds.landAcres} Acres` : ''}`],
    [recap ? 'Existing Owner' : 'Joint Venture Partner', recap ? ds.existingOwnerName : ds.jvPartnerName],
    ['Year Built/Renovated', ds.yearBuilt],
    ['Current Occupancy', fmtPct(ds.occupancyPct, 0)],
    ['Parking', ds.parkingSpaces != null ? `${ds.parkingRatio || ''} (${fmtNum(ds.parkingSpaces)} spaces)` : ds.parkingRatio],
  ]
  // Recap deals: value + capital stack + preferred-equity + existing loan.
  const recapCore: [string, string][] = [
    ['Estimated Property Value', `${fmtMoney(ds.estimatedPropertyValue)}${ds.pricePsf != null ? ` (${fmtPsf(ds.pricePsf)})` : ''}${ds.estValueNote ? `\n${ds.estValueNote}` : ''}`],
    ['Existing Capital Stack', `Property Value: ${fmtMoney(ds.estimatedPropertyValue)}\nMortgage Balance: ${fmtMoney(ds.existingLoanBalance)}\nCurrent Ownership Equity: ${fmtMoney(ds.currentOwnershipEquity)}`],
    ['Preferred Equity Capital Requirement', `${fmtMoney(ds.prefEquityAmount)}${ds.prefEquityUse ? `:\nTo be used for ${ds.prefEquityUse}` : ''}`],
    ['Existing Loan', [ds.existingLoanOriginal != null ? `Original Amount: ${fmtMoney(ds.existingLoanOriginal)}` : '', ds.existingLoanBalance != null ? `Current Balance: ${fmtMoney(ds.existingLoanBalance)}` : '', ds.existingLoanRate != null ? `${fmtPct(ds.existingLoanRate, 2)} Fixed Interest Rate` : '', ds.existingLoanMaturity ? `Maturity: ${ds.existingLoanMaturity}` : ''].filter(Boolean).join('\n')],
    ['Refinancing Assumptions', ds.refinancingAssumptions],
  ]
  const acqCore: [string, string][] = [
    ['Purchase Price', `${fmtMoney(ds.purchasePrice)}${ds.pricePsf != null ? ` (${fmtPsf(ds.pricePsf)})` : ''}\n${fmtPct(ds.goingInCap, 2)} - going-in cap rate`],
    ['Equity Capital Requirement', `${fmtMoney(ds.totalEquity)}:\n${ds.jvPartnerShort || 'Partner'} (${fmtPct(ds.jvPartnerPct, 0)}): ${fmtMoney(ds.partnerEquity)}\nM & J Wilkow Investor Company (${fmtPct(ds.mjwPct, 0)}): ${fmtMoney(ds.mjwEquity)}\nPlus: Sponsor Fee ${fmtMoney(ds.sponsorFee)}\nInvestor Company Working Capital ${fmtMoney(ds.workingCapital)}\nM & J Wilkow Investor Company Total ${fmtMoney(ds.investorCompanyTotal)}`],
    ['Financing Assumption', [`Initial Loan Amount - ${fmtMoney(ds.loanAmount)}${ds.ltvPct != null ? ` (${fmtPct(ds.ltvPct, 0)} LTV)` : ''}`, ds.rateDescription, ds.loanTermYears != null ? `${ds.loanTermYears} Year Term` : '', ds.ioDescription, ds.futureFunding].filter(Boolean).join('\n')],
  ]
  const rows: [string, string][] = [
    ...common,
    ...(recap ? recapCore : acqCore),
    ['Investment Period', ds.hasUpsideCase
      ? `Base Case Forecast: ${ds.holdYears ?? '__'} Years\nUpside Case Forecast: ${ds.upsideHoldYears ?? '__'} Years`
      : `${ds.holdYears ?? '__'} Years`],
    ['Projected IRR', ds.hasUpsideCase
      ? `Base Case Forecast: ${fmtPct(ds.projIrr)}\nUpside Case Forecast: ${fmtPct(ds.upsideIrr)}`
      : fmtPct(ds.projIrr)],
    ['Average Annual Cash on Cash Yield', ds.hasUpsideCase
      ? `Base Case Forecast: ${fmtPct(ds.avgCoc)} per annum\nUpside Case Forecast: ${fmtPct(ds.upsideCoc)} per annum`
      : `${fmtPct(ds.avgCoc)} per annum`],
    ['Projected Equity Multiple', ds.hasUpsideCase
      ? `Base Case Forecast: ${fmtMult(ds.equityMultiple)}\nUpside Case Forecast: ${fmtMult(ds.upsideEm)}`
      : fmtMult(ds.equityMultiple)],
  ]
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: GRID_BORDERS,
    rows: rows.map(([label, value]) => new TableRow({
      children: [
        new TableCell({
          width: { size: 30, type: WidthType.PERCENTAGE },
          children: [new Paragraph({ spacing: { after: 20 }, children: [run(label, { bold: true, size: 20 })] })],
        }),
        new TableCell({
          width: { size: 70, type: WidthType.PERCENTAGE },
          children: (value || '____').split('\n').map(v => new Paragraph({ spacing: { after: 20 }, children: [run(v, { size: 20 })] })),
        }),
      ],
    })),
  })
}

function tenancyTables(ds: PpmDataSheet): (Paragraph | Table)[] {
  if (!ds.tenants.length) return []
  const out: (Paragraph | Table)[] = []
  out.push(para(`${ds.propertyName || 'Property'} - Tenancy Overview`, { bold: true, align: AlignmentType.CENTER, before: 200 }))
  out.push(gridTable(
    ['Tenant', 'SF', '% of GLA', '% of Revenue', 'Rent PSF', 'Lease Type', 'Lease Expiration'],
    ds.tenants.map(t => [
      t.name + (t.groundLease ? ' (GL)' : ''), fmtNum(t.sf, ''), fmtPct(t.pctGla, 1, ''), fmtPct(t.pctRev, 1, ''),
      t.rentPsf != null ? '$' + t.rentPsf.toFixed(2) : '', t.leaseType, t.expiration,
    ]),
    [24, 12, 12, 14, 12, 12, 14],
  ))
  const totalSf = ds.tenants.reduce((s, t) => s + (t.sf ?? 0), 0)
  if (totalSf) out.push(para(`Total: ${fmtNum(totalSf)} SF`, { align: AlignmentType.LEFT, before: 60 }))

  const hasPerf = ds.tenants.some(t => t.salesPsf != null || t.healthRatio != null || t.placerRank)
  if (hasPerf) {
    out.push(para(`${ds.propertyName || 'Property'} - Tenant Analysis`, { bold: true, align: AlignmentType.CENTER, before: 200 }))
    out.push(gridTable(
      ['Tenant', 'SF', 'Sales PSF', 'Health Ratio', 'Ranking (Placer)'],
      ds.tenants.map(t => [
        t.name + (t.groundLease ? ' (GL)' : ''), fmtNum(t.sf, ''),
        t.salesPsf != null ? '$' + fmtNum(t.salesPsf, '') : 'N/A',
        fmtPct(t.healthRatio, 1, '-'), t.placerRank || '-',
      ]),
      [28, 14, 18, 18, 22],
    ))
  }

  if (ds.coTenancy.length) {
    out.push(para('On-going Co-Tenancy Requirements', { bold: true, align: AlignmentType.LEFT, before: 240 }))
    for (const ct of ds.coTenancy) {
      out.push(new Paragraph({
        alignment: AlignmentType.JUSTIFIED, spacing: { after: 100 },
        children: [run(`${ct.tenant}: `, { bold: true }), run(ct.requirement)],
      }))
      if (ct.conclusion) out.push(new Paragraph({
        alignment: AlignmentType.JUSTIFIED, spacing: { after: 160 },
        children: [run('Conclusion: ', { bold: true }), run(ct.conclusion)],
      }))
    }
  }
  return out
}

function historicalNoiTable(ds: PpmDataSheet): (Paragraph | Table)[] {
  if (!ds.historicalNoi.length) return []
  return [
    para('Historical Operating Results', { bold: true, align: AlignmentType.CENTER, before: 200 }),
    gridTable(
      ['Year', 'Total Income', 'Total Operating Expenses', 'Net Operating Income'],
      ds.historicalNoi.map(h => [h.year, fmtMoney(h.income, ''), fmtMoney(h.expenses, ''), fmtMoney(h.noi, '')]),
      [16, 28, 28, 28],
    ),
  ]
}

function capexTable(ds: PpmDataSheet): (Paragraph | Table)[] {
  if (!ds.capexBudgetLines.length) return []
  return [
    para('Estimated Capital Expenditures', { bold: true, align: AlignmentType.CENTER, before: 200 }),
    gridTable(
      ['Item', 'Est. Cost'],
      [...ds.capexBudgetLines.map(b => [b.item, fmtMoney(b.amount, '')]),
       ['Grand Total', fmtMoney(ds.capexBudgetTotal, '')]],
      [60, 40],
    ),
  ]
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const DOC_DEFAULTS = {
  creator: 'M&J Wilkow Asset Management Platform',
  styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
}
const PAGE = { page: { margin: { top: 1260, bottom: 1260, left: 1440, right: 1440 } } }

export async function buildPpmDocx(ds: PpmDataSheet, sections: Record<string, PpmSectionState>): Promise<Blob> {
  const body: (Paragraph | Table)[] = []

  // Page 1: key-terms table under the exec-summary banner.
  body.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 120 },
    children: [run(ds.propertyName || 'PROPERTY NAME', { bold: true, size: 28 })],
  }))
  body.push(...sectionHeading('EXECUTIVE SUMMARY'))
  body.push(execSummaryTable(ds))
  body.push(new Paragraph({ pageBreakBefore: true, children: [] }))

  for (const def of PPM_SECTIONS) {
    const text = def.mode === 'template'
      ? (def.render ? def.render(ds) : '')
      : (sections[def.key]?.text ?? '')

    // PCA/ESA/property-details ride inside PROPERTY DESCRIPTION in the real
    // document; they still get their own sub-banner for clarity.
    body.push(...sectionHeading(sectionTitle(def, ds)))
    if (text.trim()) {
      body.push(...renderRichText(text))
    } else {
      body.push(para(def.mode === 'ai'
        ? '[Section not yet drafted - generate it on the /ppm page.]'
        : '[Complete the corresponding data-sheet fields to populate this section.]',
        { align: AlignmentType.LEFT }))
    }

    if (def.key === 'tenancy') body.push(...tenancyTables(ds))
    if (def.key === 'financial_analysis') {
      body.push(...capexTable(ds))
      body.push(...historicalNoiTable(ds))
    }
  }

  const doc = new Document({
    ...DOC_DEFAULTS,
    title: `${ds.propertyName || 'PPM'} - Private Placement Memorandum`,
    sections: [{ properties: PAGE, children: body }],
  })
  return Packer.toBlob(doc)
}

export async function buildOfferingPageDocx(ds: PpmDataSheet): Promise<Blob> {
  const op = buildOfferingPage(ds)
  const body: (Paragraph | Table)[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 200 },
      children: [run(op.headline, { bold: true, size: 26 })],
    }),
    para(op.dateLine, { align: AlignmentType.LEFT, after: 240 }),
    tabbedTable(op.reLines.map(l => l.replace(/^\t/, ''))),
    new Paragraph({ spacing: { after: 160 }, children: [] }),
    ...op.paragraphs.flatMap((p2, i) =>
      i < 2 ? [para(p2, { bold: true, align: AlignmentType.CENTER })] : [para(p2)]),
    para(op.accreditedLegend, { bold: true, after: 400 }),
    para(op.offereeLine, { align: AlignmentType.LEFT }),
  ]
  const doc = new Document({
    ...DOC_DEFAULTS,
    title: `${ds.propertyName || 'PPM'} - Offering Page`,
    sections: [{ properties: PAGE, children: body }],
  })
  return Packer.toBlob(doc)
}

export async function buildRiskFactorsDocx(): Promise<Blob> {
  const body: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 200 },
      children: [run(RISK_FACTORS_TITLE, { bold: true, size: 26 })],
    }),
    para(RISK_FACTORS_INTRO),
    ...RISK_FACTORS.map((rf, i) => new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      spacing: { after: 200 },
      indent: { left: 360, hanging: 360 },
      children: [run(`${i + 1}.\t`, { bold: true }), run(rf)],
    })),
    ...RISK_FACTORS_LEGENDS.flatMap(l => [
      para(l),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [run('_______________________________')] }),
    ]),
  ]
  const doc = new Document({
    ...DOC_DEFAULTS,
    title: 'Risk Factors',
    sections: [{ properties: PAGE, children: body }],
  })
  return Packer.toBlob(doc)
}
