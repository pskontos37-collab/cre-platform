// Shared fixtures for the render-all-reports audit. Deliberately synthetic but
// shaped exactly like the real hook outputs, with stress content baked in:
//  - very long tenant/vendor names (ellipsis + wrap paths)
//  - unicode the WinAnsi body font can't show (→ ≥ × — pdfSafe must map/strip)
//  - negative amounts (parenthesized house style)
//  - enough rows to force page breaks
import type { FinancialsReportInput } from '../../FinancialsReport'
import type { InvestorReportInput } from '../../InvestorReport'
import type { RentRollReportInput, RentRollLine } from '../../RentRollReport'
import type { OnePagerInput } from '../../PropertyOnePager'
import type { PcfReportInput, PcfReportLine } from '../../PcfReport'
import type { AbstractsReportInput } from '../../AbstractReport'
import type { ClauseMatrixInput } from '../../ClauseMatrixReport'
import type { DocAbstractsReportInput } from '../../DocAbstractsReport'
import type { InspectionReportInput } from '../../InspectionReport'
import type { SaReportInput } from '../../ServiceAgreementsReport'
import type { IcMemoInput } from '../../IcMemoReport'
import type { AgreementAbstractReportInput } from '../../AgreementAbstractReport'
import type { PortfolioSnapshotInput } from '../../PortfolioSnapshotReport'
import type { ArAgingReportInput } from '../../ArAgingReport'
import type { AgreementInput } from '../../serviceAgreement/config'

export const LONG_NAME =
  'Extraordinarily Long Legal Entity Name of a National Tenant Holdings Corporation LLC, Series QQQ (f/k/a Shorter Name, Inc.)'
export const UNICODE_PROBE = 'Rent → $12,500/mo ≥ prior; 2× CPI cap — "curly quotes" and –$1,200 credit'

const stmtLine = (label: string, v: number) => ({
  category: label, label, mtd: v, ytd: v * 7, ttm: v * 12,
  budMtd: v * 0.95, budYtd: v * 7 * 0.95,
})

export const financialsInput: FinancialsReportInput = {
  propertyName: 'Gateway Port Chester',
  stmt: {
    latest: { year: 2026, month: 7 },
    months: [{ year: 2026, month: 7 }, { year: 2026, month: 6 }],
    hasBudget: true,
    income: [stmtLine('Base Rent', 903211.55), stmtLine('Recoveries — CAM/RET/INS', 214880.12), stmtLine(LONG_NAME, 1200)],
    expense: [stmtLine('CAM / Repairs & Maintenance', 121400.77), stmtLine('Insurance', 40650), stmtLine('Management Fees', 18200)],
    revenue: stmtLine('Total Revenue', 1119291.67),
    opex: stmtLine('Total Operating Expenses', 180250.77),
    noi: stmtLine('Net Operating Income', 939040.9),
    belowNoi: stmtLine('Below-NOI (Interest, Depreciation)', 310000),
    netIncome: stmtLine('Net Income', -629040.9),
  } as FinancialsReportInput['stmt'],
  bs: {
    assets: Array.from({ length: 16 }, (_, i) => ({ account_code: `10${i}0-00`, account_name: i === 0 ? LONG_NAME : `Asset Account ${i}`, balance: 2400000 / (i + 1) })),
    liabilities: [{ account_code: '2000-00', account_name: 'Mortgage Payable — NY Life $120M', balance: 120000000 }],
    equity: [{ account_code: '3000-00', account_name: 'Members Equity', balance: -117000000 }],
    totalAssets: 2400000, totalLiabilities: 120000000, totalEquity: -117000000, currentEarnings: -600000,
  } as FinancialsReportInput['bs'],
  vendors: Array.from({ length: 22 }, (_, i) => ({
    vendor: i === 0 ? `${LONG_NAME} (MRI-Property)` : `Vendor ${i} Landscaping & Snow Services (MRI-Property)`,
    invoice_count: 3 + i, total_spend: 48210.55 / (i + 1),
  })) as FinancialsReportInput['vendors'],
  vendorWindowLabel: 'Past 90 days',
  generatedAt: 'August 5, 2026, 9:00 AM',
}

export const investorInput: InvestorReportInput = {
  property: { name: 'Gateway Port Chester', location: 'Port Chester, NY', assetType: 'retail', totalSf: 503740 },
  quarter: { label: 'Q2 2026', start: '2026-04-01', end: '2026-06-30' },
  financials: {
    months: [
      { label: 'Apr 2026', revenue: 1000321.44, opex: 300111.02, noi: 700210.42 },
      { label: 'May 2026', revenue: 1011000.5, opex: 310010, noi: 700990.5 },
      { label: 'Jun 2026', revenue: 1020500, opex: 320100, noi: 700400 },
    ],
    qRevenue: 3031821.94, qOpex: 930221.02, qNoi: 2101600.92, prevQNoi: 2050000.11, t12Noi: 8301244.31, hasGl: true,
  },
  leasing: { occupancyPct: 0.941, walt: 5.2, tenantCount: 42, avgPsf: 28.51, annualRent: 12501000, asOfLabel: 'Jul 2026' },
  topTenants: [
    { tenant: LONG_NAME, sf: 120327, annualRent: 2178000, pct: 0.084, leaseEnd: '2031-01-31' },
    ...Array.from({ length: 9 }, (_, i) => ({ tenant: `Tenant ${i + 2}`, sf: 45000 - i * 2000, annualRent: 1650000 - i * 100000, pct: 0.06 - i * 0.004, leaseEnd: i % 3 === 0 ? null : `202${7 + (i % 3)}-10-31` })),
  ],
  rollover: [2026, 2027, 2028, 2029, 2030].map((year, i) => ({ year, sf: 45000 - i * 5000, pct: 0.09 - i * 0.01 })),
  partnerships: [
    {
      dealName: 'Gateway JV — MetLife/URS <-> MJW', layer: 1,
      parties: [
        { name: 'MetLife / URS', contributed: 50000000, qDistributed: 900000, ytdDistributed: 1800000, cumDistributed: 5826600, dpi: 0.12, irr: 0.081, lastDistribution: '2026-06-15' },
        { name: 'M&J Wilkow', contributed: 5000000, qDistributed: 90000, ytdDistributed: 180000, cumDistributed: 582660, dpi: 0.12, irr: null, lastDistribution: null },
      ],
    },
    { dealName: 'Gateway L2 (Class D)', layer: 2, parties: [{ name: 'Class D Members', contributed: 1200000, qDistributed: -22000, ytdDistributed: 0, cumDistributed: 264000, dpi: null, irr: null, lastDistribution: '2025-12-31' }] },
  ],
  generatedAt: 'August 5, 2026',
}

export const rentRollInput: RentRollReportInput = {
  propertyName: 'Knightdale Marketplace East',
  totalSf: 353000,
  asOfLabel: 'July 2026',
  walt: 4.1,
  generatedAt: 'August 5, 2026',
  rows: [
    ...Array.from({ length: 38 }, (_, i): RentRollLine => ({
      suite: `${100 + i}`,
      tenantName: i === 0 ? LONG_NAME : i % 9 === 8 ? null : `Tenant ${i + 1} Retail Co.`,
      sqft: 1200 + i * 350,
      leaseStart: '2021-03-01',
      leaseEnd: i % 9 === 8 ? null : `202${6 + (i % 4)}-0${1 + (i % 9)}-31`,
      monthlyRent: i % 9 === 8 ? 0 : 2400 + i * 120,
      annualRent: i % 9 === 8 ? 0 : (2400 + i * 120) * 12,
      psf: i % 9 === 8 ? 0 : 24 + (i % 7),
      isOccupied: i % 9 !== 8,
    })),
  ],
}

export const onePagerInput: OnePagerInput = {
  property: { name: 'Magnolia Park Shopping Center', address: '5000 Buford Hwy NE, Atlanta, GA', assetType: 'retail', totalSf: 480000, acquisitionDate: '2014-06-30', acquisitionPrice: 68500000 },
  kpis: { t12Noi: 6120000, t12Revenue: 9100000, occupancyPct: 0.93, annualRent: 8200000, avgPsf: 18.4, walt: 4.8, rentRollAsOf: 'Jul 2026', docCount: 1240 },
  noiTrend: Array.from({ length: 12 }, (_, i) => ({ label: `M${i + 1}`, value: 480000 + (i % 5) * 15000 })),
  topTenants: [
    { tenant: LONG_NAME, sf: 56000, annualRent: 980000, leaseEnd: '2029-01-31' },
    ...Array.from({ length: 7 }, (_, i) => ({ tenant: `Anchor ${i + 2}`, sf: 30000 - i * 2500, annualRent: 700000 - i * 60000, leaseEnd: i % 2 ? null : '2027-06-30' })),
  ],
  loans: [
    { lender: 'MetLife Real Estate Lending, LLC', balance: 42000000, rate: 0.0465, maturity: '2029-07-01', dscr: 1.42, debtYield: 0.098, covenant: 'DSCR ≥ 1.20x', status: 'ok' },
    { lender: 'Bridge Lender (repaid)', balance: null, rate: null, maturity: null, dscr: null, debtYield: null, covenant: null, status: 'none' },
  ],
  deals: [{ name: 'Magnolia JV — MetLife/MJW 90/10', tiers: 3, equity: 27500000, prefs: ['9% pref', '$6.84M pref equity'] }],
  management: { manager: 'M&J Wilkow Properties, LLC', mgmtFeePct: 2.75, constructionFeePct: 5, leasingFeePct: null, reportsDueDay: 20 },
  criticalDates: [
    { label: `${LONG_NAME} — renewal notice`, due: '2026-09-30', days: 56 },
    { label: 'Insurance renewal', due: '2026-10-15', days: 71 },
  ],
  generatedAt: 'August 5, 2026',
}

export const pcfInput: PcfReportInput = {
  propertyName: 'Gateway Port Chester',
  fiscalYear: 2026,
  asOfMonth: 7,
  statusLabel: 'Draft — actuals through Jul',
  cashBasisLabel: 'Cumulative cash (no opening balance)',
  includeVariance: true,
  kpis: [
    { label: 'FY NOI', value: '$9,401,220', sub: 'through Jul actual + forecast' },
    { label: 'Ending cash', value: '($1,204,500)', sub: 'cumulative basis' },
    { label: 'Debt service', value: '$6,120,000' },
  ],
  generatedAt: 'August 5, 2026',
  lines: [
    { kind: 'section', label: 'OPERATIONS', values: Array(12).fill(null), fyTotal: 0 },
    ...Array.from({ length: 14 }, (_, i): PcfReportLine => ({
      kind: 'line',
      label: i === 0 ? LONG_NAME : `Operating line ${i + 1} — recoveries & reimbursements`,
      values: Array.from({ length: 12 }, (_, m) => (m > 8 && i % 4 === 1 ? null : (i % 3 === 2 ? -1 : 1) * (12000 + m * 340 + i * 90))),
      fyTotal: 145000 + i * 1000,
      fyBudget: i % 5 === 4 ? null : 141000 + i * 1000,
      fyVar: i % 5 === 4 ? null : 4000,
      isNonCash: i === 13,
      noBudgetCoverage: i % 5 === 4,
    })),
    { kind: 'subtotal', label: 'NET OPERATING CASH', values: Array.from({ length: 12 }, (_, m) => 96000 + m * 200), fyTotal: 1180000, strong: true, fyBudget: 1150000, fyVar: 30000 },
    { kind: 'spacer', label: '', values: Array(12).fill(null), fyTotal: 0 },
    { kind: 'section', label: 'FINANCING', values: Array(12).fill(null), fyTotal: 0 },
    { kind: 'line', label: 'Debt service — NY Life $120M @ 4.65%', values: Array.from({ length: 12 }, () => -510000), fyTotal: -6120000, fyBudget: -6120000, fyVar: 0 },
    { kind: 'subtotal', label: 'ENDING CASH (cumulative)', values: Array.from({ length: 12 }, (_, m) => -100000 - m * 90000), fyTotal: -1204500, strong: true },
  ],
}

// Shaped like a real lease_abstracts.abstract row (key inventory verified
// against prod), with stress strings. Deliberately PARTIAL — sparse abstracts
// exist in the wild and the report must render them.
export const leaseAbstract = {
  tenant_legal_name: 'H.F.D. No. 55, Inc.',
  trade_name: 'Test Tenant Apparel Co.',
  suite: 'Spaces 13 & 24 (small shop wing adjacent to anchor)',
  square_footage: 5360,
  term: {
    section: 'Section 1.01',
    original_commencement: '2023-03-06',
    rent_commencement: '2023-05-19',
    expiration: '2034-01-31',
    term_years: 10,
    rcd_basis: UNICODE_PROBE,
  },
  base_rent_schedule: [
    { start: '2023-05-19', end: '2024-05-18', months: 12, monthly: 24566.67, annual: 294800.04, psf: 55 },
    { start: '2033-02-01', end: '2034-01-31', months: null, monthly: 32052.8, annual: 384633.6, psf: 71.76 },
  ],
  options: [
    { term: 'First Extension Period (60 months)', start: '2034-02-01', end: '2039-01-31', status: 'open', notice_by: '2033-05-01', section: 'Article 27.02', monthly: null, annual: null, psf: null, notice_period: 'Not stated explicitly in briefs; MRI governs', landlord_reminder_required: false },
  ],
  co_tenancy: {
    exists: true, section: 'Article Seven / §7.04',
    exact_language_and_remedies: 'Co-tenancy triggered when less than 75% of Shopping Center Rentable Area is open or when Named Tenants are not open; Tenant may pay reduced rent (5% of Gross Sales) or go dark paying only Base Rent; if the violation continues 180 consecutive days without a Like Replacement tenant, Tenant may terminate the Lease. This sentence is deliberately long to exercise paragraph wrapping across the column width of the abstract PDF without any manual breaks.',
  },
  percentage_rent: { applicable: true, rate_pct: 4, breakpoint: '$7,370,001 (Year 1) escalating to $9,615,840 (Year 10)', breakpoint_type: 'natural', section: 'Article 4' },
  cam: { methodology: 'Tenant share via monthly Rent Adjustment Deposit with annual true-up', caps_exclusions: '5% per calendar year cap on Controllable Expenses, non-cumulative', prorata_share_calc: '1.064% (5,360 SF / 503,740 SF)', admin_fee: 'Not separately itemized — CONFIRM' },
  security_deposit: { exists: false, type: null, total: null },
  tenant_allowance: { exists: true, total: 214400, psf: 40 },
  exclusives: { exists: false, section: null, exact_language: null, remedies: null, conditions: null },
  critical_dates: [
    { date: '2033-05-01', event: 'Notice deadline for First Renewal Option exercise', source: 'MRI RETAILRR option data' },
    { date: '2034-01-31', event: 'Initial Term Expiration', source: 'Lease §1.01; MRI system of record' },
  ],
  open_items: [
    `DISCREPANCY: [square_footage] MRI rent roll lists suite '013' at 4,250 SF while the lease states 5,360 SF for the combined premises — CONFIRM which figure is the controlling rent-roll basis. ${UNICODE_PROBE}`,
    'CONFIRM: [options] notice mechanics for Second Extension Period not located in file.',
  ],
  lease_documents: [
    { date: '2023-03-07', type: 'Retail Lease Agreement', signed: 'Y', category: 'operative', notes: 'Base lease including Rider 1 and Exhibit E (prohibited uses / existing exclusives).' },
  ],
}

export const abstractsInput: AbstractsReportInput = {
  title: 'Lease Abstracts — Gateway Port Chester',
  subtitle: 'Verified abstracts · 2 tenants',
  docs: [
    { propertyName: 'Gateway Port Chester', tenantName: 'Test Tenant Apparel Co.', abstract: leaseAbstract, generatedAt: '2026-08-01', sourceDocCount: 12 },
    { propertyName: 'Gateway Port Chester', tenantName: LONG_NAME, abstract: { ...leaseAbstract, trade_name: LONG_NAME, open_items: [] }, generatedAt: null, sourceDocCount: 3 },
  ],
  generatedAt: 'August 5, 2026',
  showPropertyHeadings: true,
}

export const clauseMatrixInput: ClauseMatrixInput = {
  title: 'Clause Matrix — All Properties',
  subtitle: 'Key clauses per tenant',
  docs: abstractsInput.docs,
  generatedAt: 'August 5, 2026',
}

export const docAbstractsInput: DocAbstractsReportInput = {
  title: 'Gateway Port Chester',
  subtitle: 'Narrative abstracts of all active closing documents',
  scopeLabel: 'Gateway Port Chester · 2 active documents',
  generatedAt: 'August 5, 2026',
  items: [
    {
      docTitle: 'Closing Statement — 451/421 Boston Post Road', docType: 'closing_statement', roleLabel: 'Closing statement',
      abstract: {
        doc_title: 'Closing Statement', doc_type: 'closing_statement', effective_date: '2025-10-28',
        parties: ['ML-MJW Port Chester SC Owner LLC (Buyer)', 'DPPC Holdings L.P. (Seller)'],
        summary: `Total purchase price $103,478,461.14 for the Gateway Shopping Center buyout. ${UNICODE_PROBE}`,
        key_terms: ['Purchase price $103,478,461.14', 'Closing date 2025-10-28', LONG_NAME],
        dates: [{ date: '2025-10-28', event: 'Closing' }],
        financial_terms: [{ item: 'Purchase price', amount: '$103,478,461.14' }],
        obligations: ['Post-closing true-up of prorations within 90 days'],
        notes: 'Escrow instructions executed concurrently.',
        open_items: ['CONFIRM final proration schedule'],
      },
    },
    { docTitle: 'Deed', docType: 'deed', roleLabel: 'Deed', abstract: { doc_title: 'Bargain and Sale Deed', summary: 'Conveyance of fee interest.', parties: [], key_terms: [], dates: [], financial_terms: [], obligations: [], notes: null, open_items: [] } },
  ],
}

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

export const inspectionInput: InspectionReportInput = {
  propertyName: 'Knightdale Marketplace West',
  formTitle: 'Retail Property Inspection',
  formVersion: 'v2.1',
  inspectionDate: '2026-08-01',
  inspectedBy: 'Pat Skontos',
  weather: 'Clear, 84°F',
  specialEvents: 'None',
  sections: [
    {
      title: 'Exterior & Parking',
      items: [
        { n: 1, label: 'Parking lot striping and signage visible and in good repair', na: false, yn: 'yes', score: 4, detail: 'Restripe planned for fall.', photos: [] },
        { n: 2, label: 'Landscaping and irrigation', na: false, yn: 'no', score: 2, detail: `Dead plantings near pylon. ${UNICODE_PROBE}`, photos: [] },
        { n: 3, label: 'Roof access secured', na: true, yn: null, score: null, detail: '', photos: [] },
      ],
    },
    {
      title: 'Common Areas',
      items: [{ n: 4, label: LONG_NAME, na: false, yn: 'yes', score: 5, detail: 'Excellent condition.', photos: [] }],
    },
  ] as InspectionReportInput['sections'],
  photosByItem: { 2: [TINY_PNG, TINY_PNG] },
  comments: 'Overall the property presents well; two follow-ups noted.',
  actionItems: '1) Replace plantings at pylon. 2) Quote lot restripe.',
  score: { average: 3.7, scored: 3, flagged: 1, needNote: 0 },
  generatedAt: 'August 5, 2026',
}

export const saReportInput: SaReportInput = {
  scopeLabel: 'All properties',
  generatedAt: 'August 5, 2026',
  groups: [
    { propertyName: 'Gateway Port Chester', vendor: LONG_NAME, category: 'Landscaping', lifecycle: 'active', description: 'Full-service grounds maintenance including seasonal color rotations and storm cleanup.', termSummary: 'Evergreen w/ 30-day out', startDate: '2024-04-01', endDate: null, agreementDate: '2024-03-15', pricingSummary: '$4,850/mo + per-event snow', annualValue: 58200, cancelNoticeDays: 30, isForm: true },
    { propertyName: 'Knightdale Marketplace East', vendor: 'Tri-State Commercial Roofing Corporation', category: 'Roofing', lifecycle: 'expired', description: null, termSummary: 'Single project', startDate: '2023-08-22', endDate: '2024-02-29', agreementDate: '2023-08-22', pricingSummary: '$5,400 fixed', annualValue: 5400, cancelNoticeDays: null, isForm: false },
    { propertyName: 'Magnolia Park Shopping Center', vendor: 'Sweep Rite', category: 'Sweeping', lifecycle: 'expiring', description: 'Nightly lot sweeping', termSummary: '12 months', startDate: '2025-09-01', endDate: '2026-08-31', agreementDate: '2025-08-20', pricingSummary: '$1,900/mo', annualValue: 22800, cancelNoticeDays: 60, isForm: true },
  ],
}

export const icMemoInput: IcMemoInput = {
  deal: {
    name: 'Riverchase Commons', assetType: 'retail', riskProfile: 'core_plus', subType: 'grocery-anchored',
    submarket: 'Hoover', city: 'Birmingham', state: 'AL', glaSf: 285000, yearBuilt: 1998,
    askPrice: 51500000, priceText: null, goingInCap: 0.0725, equityRequired: 19500000, totalCapitalization: 54200000,
    targetCloseDate: '2026-11-15', projIrr: 0.152, equityMultiple: 1.85, avgCoc: 0.083, holdYears: 7,
    exitCap: 0.0775, stabilizedYield: 0.081,
    thesis: `Grocery-anchored center at a hard corner with below-market anchor rent and 96% historical occupancy. ${UNICODE_PROBE}`,
    partner: 'Institutional Partner A', broker: 'JLL — Southeast Retail Capital Markets', seller: 'Legacy Family Office',
    team: ['Pat Skontos', 'Deal Team Analyst'],
    lps: [{ partnerName: 'Partner A', status: 'soft', soft: 12000000, committed: null }, { partnerName: 'Partner B', status: 'committed', soft: null, committed: 5000000 }],
    tenants: [{ name: LONG_NAME, sf: 54000, expiration: '2029-01-31' }, { name: 'Grocer Anchor', sf: 62000, expiration: '2032-06-30' }],
  },
  promote: { lpEquityPct: 0.9, prefRate: 0.09, lpIrr: 0.138, lpEm: 1.74, gpIrr: 0.31, gpEm: 2.9, gpPromote: 2450000, gpPromotePctOfProfit: 0.18 },
  scenarios: [
    { name: 'Base', leveredIrr: 0.152, equityMultiple: 1.85, avgCoc: 0.083, yearOneDscr: 1.38, equity: 19500000, exitCap: 0.0775 },
    { name: 'Downside', leveredIrr: 0.09, equityMultiple: 1.4, avgCoc: 0.06, yearOneDscr: 1.21, equity: 19500000, exitCap: 0.085 },
  ],
  strategyFit: { category: 'Grocery-anchored', buyBox: 'SE metro, $30–80M, cap ≥ 7%', score: 0.86 },
  topLps: ['Partner A', 'Partner B', 'Partner C'],
  memo: {
    headline: 'Below-market anchor rent with a 7.25% going-in cap',
    executive_summary: 'A long executive summary paragraph designed to wrap across multiple lines and pages if needed. '.repeat(12),
    business_plan: 'Renew the grocer early, remerchandise two junior boxes, and harvest the outparcel pads.',
    risks: [{ risk: 'Anchor renewal at above-market TI', mitigant: 'Early renewal LOI in hand at $18/SF TI' }],
    recommendation: 'Proceed to LOI.',
    ask: 'Approve $250k pursuit budget.',
  },
  preparedBy: 'Pat Skontos',
  generatedAt: 'August 5, 2026',
}

// Shaped like deals.abstract (jv) — key inventory verified against prod.
export const jvAbstract = {
  agreement_name: 'Amended and Restated Limited Liability Company Agreement',
  entity: 'ML-MJW Port Chester SC Owner LLC',
  effective_date: '2019-06-28',
  parties_members: [
    { name: 'MetLife / URS JV Member LLC', role: 'Investor Member', pct: '90%' },
    { name: 'MJW Port Chester Member LLC', role: 'Operating Member', pct: '10%' },
  ],
  capital: { initial: '$55,000,000 aggregate', additional: 'Pro-rata capital calls; dilution remedy at 150%' },
  preferred_return: { rate: '9% cumulative, compounded monthly', on: 'Unreturned capital' },
  distributions_waterfall: [
    'First, 90/10 pro rata until Investor IRR of 9%',
    'Then 80/20 until 12% IRR',
    `Thereafter 70/30. ${UNICODE_PROBE}`,
  ],
  promote: { tiers: 2, description: 'Operating Member promote steps at 9% and 12% IRR hurdles' },
  management_control: { manager: 'Operating Member, subject to Major Decisions', major_decisions: ['Sale', 'Financing', 'Annual budget approval'] },
  fees_to_affiliates: [{ fee: 'Property management', amount: '1.75% of gross receipts' }],
  transfer_restrictions: 'No transfers without consent except to affiliates; ROFO on exit.',
  exit: { lockout: '3 years', mechanism: 'Buy/sell after year 5; forced sale after year 7' },
  reporting_tax: { reports: 'Monthly operating reports by day 20; audited annuals by March 31' },
  critical_dates: [{ date: '2026-06-28', event: 'Buy/sell window opens', source: 'OA §12.3' }],
  amendment_chain: [{ date: '2021-02-01', instrument: 'First Amendment', notes: 'Admitted URS as co-investor.' }],
  open_items: ['CONFIRM: exhibit C org chart superseded by 2021 amendment?'],
}

export const agreementAbstractInput: AgreementAbstractReportInput = {
  kind: 'jv',
  name: 'Gateway JV — Operating Agreement',
  abstract: jvAbstract,
  qa: { verdict: 'verified', checks: [{ field: 'preferred_return.rate', status: 'confirmed', note: 'Ties to §8.1' }] },
  qaStatus: 'verified',
  qaAt: '2026-07-20T12:00:00Z',
  generatedAt: 'August 5, 2026',
}

export const arAgingInput: ArAgingReportInput = {
  rows: [
    ...Array.from({ length: 26 }, (_, i) => ({
      id: `row-${i}`,
      propertyId: i % 2 ? 'prop-gw' : 'prop-mag',
      propertyName: i % 2 ? 'Gateway Port Chester' : 'Magnolia Park Shopping Center',
      asOf: '2026-07-31',
      tenantName: i === 0 ? LONG_NAME : `Tenant ${i + 1}`,
      tenantId: null,
      mriLeaseId: i % 3 ? `MRI-${1000 + i}` : null,
      suite: `${200 + i}`,
      status: i % 5 === 4 ? 'REA' : 'Current',
      total: 42000 / (i + 1) + 500,
      current: 12000 / (i + 1),
      b30: 9000 / (i + 1),
      b60: i % 4 ? 0 : 4200,
      b90: i % 6 ? 0 : 2100.55,
      b120: i % 8 ? 0 : 15000,
      pastDue: 30000 / (i + 1) + 500,
      lastPaymentDate: i % 4 ? '2026-07-15' : null,
      lastPaymentAmount: i % 4 ? 8200.25 : null,
      categories: [{ code: 'CAM', desc: 'Common area maintenance', total: 1200.5 }, { code: 'RNT', desc: `Base rent ${UNICODE_PROBE}`, total: 2400 }],
    })),
  ] as ArAgingReportInput['rows'],
  notes: { 'prop-gw|MRI-1001': `Payment plan agreed 7/20 — ${UNICODE_PROBE}` },
  followUps: { 'prop-gw|mri:MRI-1001': [{ id: 'f1', method: 'email', recipients: ['ap@tenant.com'], pastDue: 12000, createdAt: '2026-07-22T15:00:00Z', sentByName: 'Pat Skontos' }] },
  reaMris: ['MRI-1004'],
  asOf: '2026-07-31',
  generatedAt: 'August 5, 2026',
}

export const portfolioSnapshotInput: PortfolioSnapshotInput = {
  scopeLabel: 'Entire portfolio',
  generatedAt: 'August 5, 2026, 9:00 AM',
  kpis: { propertyCount: 4, occupancyPct: 0.94, occupiedSf: 1610000, totalSf: 1713000, t12Noi: 24800000, t12Revenue: 36200000, t12Opex: 11400000, walt: 4.6, totalPastDueAr: 1940000, arAsOf: '2026-07-31' },
  noiTrend: Array.from({ length: 24 }, (_, i) => ({ year: 2024 + Math.floor(i / 12), month: (i % 12) + 1, noi: 1900000 + (i % 7) * 45000 })),
  budget: { year: 2026, throughMonth: 7, mixedClose: false, noiActual: 14600000, noiBudget: 14200000 },
  occupancy: [
    { propertyName: 'Gateway Port Chester', physicalPct: 0.96, occupiedSf: 483000, totalSf: 503740 },
    { propertyName: 'Magnolia Park Shopping Center', physicalPct: 0.93, occupiedSf: 446000, totalSf: 480000 },
    { propertyName: 'Knightdale Marketplace East', physicalPct: 0.92, occupiedSf: 325000, totalSf: 353000 },
    { propertyName: LONG_NAME, physicalPct: 0.88, occupiedSf: 356000, totalSf: 376260 },
  ],
  rollover: [2026, 2027, 2028, 2029, 2030].map((year, i) => ({ year, sf: 120000 - i * 15000, count: 14 - i * 2, pctOfTotal: 0.075 - i * 0.008 })),
  topTenants: Array.from({ length: 10 }, (_, i) => ({ tenantName: i === 0 ? LONG_NAME : `Tenant ${i + 1}`, propertyName: 'Gateway Port Chester', annualRent: 2178000 - i * 150000, pctOfTotal: 0.084 - i * 0.006, leasedSf: 120327 - i * 8000 })),
  dscr: [
    { propertyName: 'Gateway Port Chester', loanLabel: 'NY Life $120M', dscr: 1.31, debtYield: 0.089, covenantType: 'dscr', headroom: 0.11, isNear: true, isBreach: false },
    { propertyName: 'Knightdale Marketplace (Consolidated)', loanLabel: 'MetLife $46M', dscr: 1.82, debtYield: 0.121, covenantType: 'debt_yield', headroom: 0.31, isNear: false, isBreach: false },
  ],
  criticalDates: [
    { propertyName: 'Gateway Port Chester', tenantName: LONG_NAME, dateType: 'renewal_notice', dueDate: '2026-09-30', daysUntil: 56, description: `Renewal option notice deadline. ${UNICODE_PROBE}` },
    { propertyName: 'Magnolia Park Shopping Center', tenantName: null, dateType: 'insurance', dueDate: '2026-10-15', daysUntil: 71, description: null },
  ],
  coTenancy: [{ propertyName: 'Gateway Port Chester', triggerReason: 'Anchor dark > 90 days — reduced rent in effect for 2 inline tenants' }],
  delinquency: Array.from({ length: 8 }, (_, i) => ({ tenantName: i === 0 ? LONG_NAME : `Delinquent Tenant ${i + 1}`, propertyName: 'Magnolia Park Shopping Center', pastDue: 210000 / (i + 1) })),
  workOrders: { open: 34, urgent: 3, unassigned: 6 },
  returns: {
    dealCount: 5,
    lp: { contributed: 118000000, distributed: 56500000, currentEquity: 92000000, totalValueMultiple: 1.26, totalValueIrr: 0.078 },
    gp: { contributed: 13100000, distributed: 6300000, currentEquity: 10200000, totalValueMultiple: 1.31, totalValueIrr: 0.083 },
    promoteEquity: 8400000,
  },
  health: {
    portfolioRatio: 0.071, ttmLabel: 'TTM through Jun 2026', reporterCount: 18,
    rows: Array.from({ length: 6 }, (_, i) => ({ tenantName: i === 0 ? LONG_NAME : `Reporter ${i + 1}`, propertyName: 'Gateway Port Chester', ratio: 0.15 - i * 0.015, baseRent: 220000, recoveries: 60000, occupancyCost: 280000, ttmSales: 2400000 + i * 400000, band: (i < 2 ? 'high' : i < 4 ? 'watch' : 'healthy') as 'high' | 'watch' | 'healthy', hasRecoveries: i % 5 !== 4 })),
  },
  byProperty: [
    { propertyName: 'Gateway Port Chester', t12Noi: 9400000, noiMargin: 0.68, occupancyPct: 0.96, occupiedSf: 483000, totalSf: 503740, walt: 5.2, topTenant: LONG_NAME, topTenantPct: 0.084, pastDue: 868000, dscrText: '1.31x', dscrStatus: 'near', openWos: 12 },
    { propertyName: 'Magnolia Park Shopping Center', t12Noi: 6100000, noiMargin: 0.67, occupancyPct: 0.93, occupiedSf: 446000, totalSf: 480000, walt: 4.8, topTenant: 'Anchor Grocer', topTenantPct: 0.12, pastDue: 838000, dscrText: '—', dscrStatus: null, openWos: 9 },
  ],
  propertyDetails: [
    {
      propertyName: 'Gateway Port Chester', occupancyPct: 0.96, occupiedSf: 483000, totalSf: 503740,
      t12Noi: 9400000, t12Revenue: 13800000, t12Opex: 4400000, noiMargin: 0.68, walt: 5.2, pastDue: 868000, openWos: 12,
      noiTrend: Array.from({ length: 12 }, (_, i) => ({ year: 2026, month: i + 1, noi: 760000 + (i % 5) * 22000 })),
      rollover: [2026, 2027, 2028].map((year, i) => ({ year, sf: 45000 - i * 9000, count: 6 - i, pctOfTotal: 0.09 - i * 0.02 })),
      topTenants: [{ tenantName: LONG_NAME, propertyName: 'Gateway Port Chester', annualRent: 2178000, pctOfTotal: 0.084, leasedSf: 120327 }],
      dscr: [{ propertyName: 'Gateway Port Chester', loanLabel: 'NY Life $120M', dscr: 1.31, debtYield: 0.089, covenantType: 'dscr', headroom: 0.11, isNear: true, isBreach: false }],
      criticalDates: [{ propertyName: 'Gateway Port Chester', tenantName: 'Starbucks', dateType: 'option_notice', dueDate: '2026-11-30', daysUntil: 117, description: 'Second extension notice window opens' }],
      coTenancy: [],
      delinquency: [{ tenantName: 'Delinquent Tenant 2', propertyName: 'Gateway Port Chester', pastDue: 105000 }],
      health: [{ tenantName: 'Reporter 1', propertyName: 'Gateway Port Chester', ratio: 0.12, baseRent: 180000, recoveries: 40000, occupancyCost: 220000, ttmSales: 1900000, band: 'watch', hasRecoveries: true }],
      returns: { lp: { contributed: 50000000, distributed: 5826600, currentEquity: 51000000, totalValueMultiple: 1.14, totalValueIrr: 0.05 }, gp: { contributed: 5000000, distributed: 582660, currentEquity: 5400000, totalValueMultiple: 1.2, totalValueIrr: 0.06 }, promoteEquity: 2400000 },
    },
  ],
}

export const serviceAgreementInput: AgreementInput = {
  property: 'KME',
  day: '5th',
  month: 'August',
  year: '2026',
  vendorName: LONG_NAME,
  vendorBusiness: 'landscaping and grounds maintenance',
  termType: 'continuing',
  startDate: 'September 1, 2026',
  endDate: 'August 31, 2027',
  vendorAddress: ['4400 Vendor Way', 'Suite 210', 'Raleigh, NC 27604'],
  ownerSignName: 'Marc R. Wilkow',
  ownerSignTitle: 'President',
  vendorSignName: 'Jordan Vendor',
  vendorSignTitle: 'Owner',
  vendorEmail: 'signer@vendor.example.com',
}
