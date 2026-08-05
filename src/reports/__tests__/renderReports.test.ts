// Render-audit for every client-side PDF builder. Each test renders a full
// report with stress fixtures (long names, unicode, negatives, page-break row
// counts) and fails on ANY render error — the class of bug that previously
// shipped silently because export buttons were only bundle-grep verified.
//
// Set PDF_AUDIT_DIR to also write each PDF to disk for a visual pass:
//   PDF_AUDIT_DIR=C:\tmp\pdfs npx vitest run src/reports/__tests__/renderReports.test.ts
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Font } from '@react-pdf/renderer'

import {
  abstractsInput, agreementAbstractInput, arAgingInput, clauseMatrixInput,
  docAbstractsInput, financialsInput, icMemoInput, inspectionInput,
  investorInput, onePagerInput, pcfInput, portfolioSnapshotInput,
  rentRollInput, saReportInput, serviceAgreementInput,
} from './fixtures/reportFixtures'

// jsdom's Blob lacks arrayBuffer(); real browsers have it. Polyfill via
// FileReader so both this harness and app code that reads blob bytes
// (serviceAgreement/renderPdf toBytes) work under the test environment.
beforeAll(() => {
  if (typeof Blob.prototype.arrayBuffer !== 'function') {
    Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
      return new Promise((res, rej) => {
        const fr = new FileReader()
        fr.onload = () => res(fr.result as ArrayBuffer)
        fr.onerror = () => rej(fr.error)
        fr.readAsArrayBuffer(this)
      })
    }
  }
})

// theme.ts registers the serif from '/fonts/…' (a browser URL). Under Node that
// path doesn't exist, so re-register the same family/weights from the repo's
// public/ folder — same store, the file source replaces the URL source.
beforeAll(() => {
  Font.register({
    family: 'Frank Ruhl Libre',
    fonts: [
      { src: resolve(process.cwd(), 'public/fonts/FrankRuhlLibre-Medium.ttf'), fontWeight: 500 },
      { src: resolve(process.cwd(), 'public/fonts/FrankRuhlLibre-Bold.ttf'), fontWeight: 700 },
    ],
  })
})

const auditDir = process.env.PDF_AUDIT_DIR
async function checkPdf(name: string, blob: Blob, minBytes = 3000) {
  expect(blob.size).toBeGreaterThan(minBytes)
  const buf = Buffer.from(await blob.arrayBuffer())
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  if (auditDir) {
    mkdirSync(auditDir, { recursive: true })
    writeFileSync(resolve(auditDir, `${name}.pdf`), buf)
  }
}

const T = 30_000

describe('every PDF report renders with stress data', () => {
  it('Financials', async () => {
    const { buildFinancialsPdf } = await import('../FinancialsReport')
    await checkPdf('financials', await buildFinancialsPdf(financialsInput))
  }, T)

  it('Financials — empty property (no GL)', async () => {
    const { buildFinancialsPdf } = await import('../FinancialsReport')
    await checkPdf('financials-empty', await buildFinancialsPdf({
      ...financialsInput, stmt: null, bs: null, vendors: null,
    }), 1500)
  }, T)

  it('Investor quarterly', async () => {
    const { buildInvestorReportPdf } = await import('../InvestorReport')
    await checkPdf('investor-quarterly', await buildInvestorReportPdf(investorInput))
  }, T)

  it('A/R aging', async () => {
    const { buildArAgingPdf } = await import('../ArAgingReport')
    await checkPdf('ar-aging', await buildArAgingPdf(arAgingInput))
  }, T)

  it('Rent roll', async () => {
    const { buildRentRollPdf } = await import('../RentRollReport')
    await checkPdf('rent-roll', await buildRentRollPdf(rentRollInput))
  }, T)

  it('REA summary', async () => {
    const { buildReaPdf } = await import('../ReaReport')
    await checkPdf('rea-summary', await buildReaPdf({
      generatedAt: 'August 5, 2026',
      agreements: [
        {
          id: 'rea-1', propertyId: 'prop-gw', propertyName: 'Gateway Port Chester',
          name: 'Declaration of Easements & Restrictions — Port Chester Shopping Center (1964)',
          agreementDate: '1964-01-06', termSummary: 'Perpetual, runs with the land',
          operator: 'M&J Wilkow Properties, LLC',
          members: [
            { name: 'Kohl\u2019s Department Stores, Inc.', role: 'Anchor party', tract: 'Tract II', mri: 'MRI-KOHLS', note: 'Self-managed tract', arTotal: 1250.55, arAsOf: '2026-07-31' },
            { name: 'Target Corporation', role: 'Anchor party', tract: 'Tract III', arTotal: null, arAsOf: null },
          ],
          costSharing: 'Common-area costs shared pro-rata by tract acreage; 15% admin fee on CAM.',
          keyProvisions: 'Parking ratios, no-build zones, signage criteria, use restrictions on outparcels.',
          amendments: 'First Amendment (1972); Second Amendment (1998) re-parceling Tract IV.',
          openItems: 'CONFIRM: 1998 exhibit map superseded?',
          sourceDocs: [{ id: 'd1', title: 'REA (1964) — recorded copy' }],
          abstract: null, qa: null, qaStatus: null, qaAt: null,
        },
      ],
    }))
  }, T)

  it('Property one-pager', async () => {
    const { buildPropertyOnePagerPdf } = await import('../PropertyOnePager')
    await checkPdf('property-one-pager', await buildPropertyOnePagerPdf(onePagerInput))
  }, T)

  it('Lease abstracts pack (merged, page-stamped)', async () => {
    const { buildAbstractsPackPdf } = await import('../AbstractReport')
    await checkPdf('abstracts-pack', await buildAbstractsPackPdf(abstractsInput), 8000)
  }, T)

  it('Clause matrix', async () => {
    const { buildClauseMatrixPdf } = await import('../ClauseMatrixReport')
    await checkPdf('clause-matrix', await buildClauseMatrixPdf(clauseMatrixInput))
  }, T)

  it('Doc abstracts (transactions / management)', async () => {
    const { buildDocAbstractsPdf } = await import('../DocAbstractsReport')
    await checkPdf('doc-abstracts', await buildDocAbstractsPdf(docAbstractsInput))
  }, T)

  it('Projected cash flow', async () => {
    const { buildPcfPdf } = await import('../PcfReport')
    await checkPdf('pcf', await buildPcfPdf(pcfInput))
  }, T)

  it('Inspection (with embedded photos)', async () => {
    const { buildInspectionPdf } = await import('../InspectionReport')
    await checkPdf('inspection', await buildInspectionPdf(inspectionInput))
  }, T)

  it('Service agreements register', async () => {
    const { buildServiceAgreementsPdf } = await import('../ServiceAgreementsReport')
    await checkPdf('service-agreements', await buildServiceAgreementsPdf(saReportInput))
  }, T)

  it('Executive portfolio snapshot (with property detail page)', async () => {
    const { buildPortfolioSnapshotPdf } = await import('../PortfolioSnapshotReport')
    await checkPdf('portfolio-snapshot', await buildPortfolioSnapshotPdf(portfolioSnapshotInput), 8000)
  }, T)

  it('IC memo', async () => {
    const { buildIcMemoPdf } = await import('../IcMemoReport')
    await checkPdf('ic-memo', await buildIcMemoPdf(icMemoInput))
  }, T)

  it('Agreement abstract (JV operating agreement)', async () => {
    const { buildAgreementAbstractPdf } = await import('../AgreementAbstractReport')
    await checkPdf('agreement-abstract-jv', await buildAgreementAbstractPdf(agreementAbstractInput))
  }, T)

  it('Service agreement contract (builder)', async () => {
    const { buildAgreementPdf } = await import('../serviceAgreement/renderPdf')
    await checkPdf('service-agreement-contract', await buildAgreementPdf(serviceAgreementInput), 8000)
  }, T)
})
