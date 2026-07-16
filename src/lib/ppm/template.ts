// PPM generator — canonical template model.
//
// One structured "data sheet" holds every deal-specific fact that appears in a
// Private Placement Memorandum. The document is assembled from:
//   - TEMPLATE sections: deterministic prose rendered from the data sheet
//     (verbatim house form with merge fields — no AI, no hallucination risk), and
//   - AI sections: narrative drafted by the ppm-draft edge fn in the house voice,
//     then reviewed/edited by the author. Every $ / % / multiple in an AI draft
//     is checked against the data sheet by verifyNumbers().
//
// The canonical form is the Chapel Hills East (1-21-24) / Silverado Ranch (2025)
// skeleton — the converged shape of every MJW PPM 2016-2025.

// ---------------------------------------------------------------------------
// Data sheet
// ---------------------------------------------------------------------------

export interface PpmTenant {
  name: string
  sf: number | null
  pctGla: number | null      // 0.214 = 21.4%
  pctRev: number | null
  rentPsf: number | null
  leaseType: string          // 'NNN'
  expiration: string         // 'Jan-26' or '1/31/2026'
  options: string            // 'Three 5-year'
  salesPsf: number | null
  healthRatio: number | null // 0.016 = 1.6%
  placerRank: string         // '#10 out of 19'
  groundLease: boolean
}

export interface PpmCoTenancy { tenant: string; requirement: string; conclusion: string }
export interface PpmTenantProfile { name: string; sf: number | null; creditRating: string; expiration: string; blurb: string }
export interface PpmValueAdd { title: string; body: string }
export interface PpmContact { name: string; phone: string; email: string }
export interface PpmWaterfallTier { split: string; until: string }
export interface PpmBudgetLine { item: string; amount: number | null }

export interface PpmDataSheet {
  // ---- Identity ----
  propertyName: string
  address: string
  city: string
  state: string            // full name, e.g. 'Colorado'
  msa: string              // e.g. 'Colorado Springs'
  propertyType: string     // 'Whole Foods Grocery-Anchored Power Center - Core Plus'
  dealStructure: 'jv_acquisition' | 'pref_equity_recap'

  // ---- Physical ----
  glaSf: number | null
  landAcres: number | null
  yearBuilt: string        // '1995 - 1997'
  occupancyPct: number | null   // 1.0 = 100%
  parkingSpaces: number | null
  parkingRatio: string     // '5.42 per 1,000 SF'

  // ---- Deal terms ----
  purchasePrice: number | null
  pricePsf: number | null
  goingInCap: number | null     // 0.0798 = 7.98%
  inPlaceNoi: number | null
  totalCapitalization: number | null

  // ---- JV / sponsor ----
  jvPartnerName: string         // 'MetLife Enhanced Core Property Holdings, LLC'
  jvPartnerShort: string        // 'MetLife'
  jvPartnerBlurb: string        // standing description paragraph for the partner
  jvPartnerPct: number | null   // 0.95
  mjwPct: number | null         // 0.05
  jvHistoryNote: string         // 'fifth joint venture between MJW and MetLife...'
  jvVehicleName: string         // 'Chapel Hills East Venture LLC'
  propertyOwnerLlc: string      // 'Chapel Hills East LLC'
  jvWaterfallTiers: PpmWaterfallTier[]

  // ---- Wilkow Investor Company ----
  investorCompanyName: string   // 'M & J Chapel Investors LLC'
  managerIncName: string        // 'M & J Chapel Manager Inc.'
  managerStockholders: string   // 'Marc R. Wilkow, Clifton J. Wilkow, Gregg J. Wilkow and Jordan Wilkow'
  classAUnits: number | null
  classAUnitPrice: number | null   // 1000
  classBUnits: number | null
  classBUnitPrice: number | null   // 10
  minSubscriptionUnits: number | null
  classAPrefIrr: number | null     // 0.10
  classAPrefEm: number | null      // 2.3
  classAExcessPct: number | null   // 0.70 (share of excess to Class A after pref)

  // ---- Equity stack ----
  totalEquity: number | null
  partnerEquity: number | null
  mjwEquity: number | null
  sponsorFee: number | null
  workingCapital: number | null
  investorCompanyTotal: number | null
  acquisitionBudget: PpmBudgetLine[]   // line items summing to totalCapitalization

  // ---- Financing ----
  lenderName: string
  loanAmount: number | null
  ltvPct: number | null          // 0.50
  interestRate: number | null    // 0.0595
  rateDescription: string        // '5.95% Fixed Interest Rate (10 Yr. UST + 205 bps)'
  loanTermYears: number | null
  ioDescription: string          // 'Interest Only during entire 10-Year Term'
  futureFunding: string          // 'No Future Fundings' or commitment description

  // ---- Forecast (base case) ----
  holdYears: number | null
  exitCap: number | null
  projSalePrice: number | null
  projSalePsf: number | null
  projIrr: number | null
  avgCoc: number | null
  equityMultiple: number | null
  afterTaxIrr: number | null
  afterTaxCoc: number | null
  occupancyAtExit: number | null

  // ---- Upside case (optional) ----
  hasUpsideCase: boolean
  upsideHoldYears: number | null
  upsideExitCap: number | null
  upsideSalePrice: number | null
  upsideIrr: number | null
  upsideCoc: number | null
  upsideEm: number | null
  upsideAfterTaxIrr: number | null
  upsideAfterTaxCoc: number | null
  upsideNotes: string            // author bullets: what changes vs base

  // ---- Operating assumptions ----
  opexPsfYr1: number | null
  opexGrowthNote: string         // 'growing at 3% each year thereafter'
  retPsfYr1: number | null
  retNote: string                // reassessment story
  mgmtFeePct: number | null      // 0.04
  capexBudgetTotal: number | null
  capexBudgetLines: PpmBudgetLine[]
  structuralReservePsf: number | null
  auditReserveAnnual: number | null
  leasingAssumptionsNote: string // market leasing assumptions summary (Argus)
  historicalNoi: { year: string; income: number | null; expenses: number | null; noi: number | null }[]

  // ---- Tax section ----
  landBldgSplit: string          // '20%/80%'
  loanFeesAcqCosts: number | null
  stateTaxRate: number | null    // 0.0463
  stateTaxName: string           // 'Colorado'

  // ---- PCA / ESA ----
  pcaFirm: string
  pcaDate: string
  pcaImmediateRepairs: number | null
  pcaReserve12yr: number | null
  pcaPsfPerYear: number | null
  pcaKeyItems: string            // 'asphalt and concrete repairs ($450,000), ...'
  esaFirm: string
  esaDate: string
  esaFindings: string            // 'no evidence of RECs/CRECs/HRECs' or the exception story

  // ---- Property details block ----
  taxParcels: string
  zoningText: string
  accessText: string
  signageText: string
  siteImprovementsText: string
  foundationText: string
  facadeText: string
  roofsText: string
  utilitiesText: string          // 'Water & Sewer: X / Electric: Y / Gas: Z'
  floodZoneText: string

  // ---- Tenancy ----
  tenants: PpmTenant[]
  coTenancy: PpmCoTenancy[]
  tenantProfiles: PpmTenantProfile[]
  anchorStory: string            // author note: anchor narrative hooks for the AI

  // ---- Market ----
  marketOverviewNotes: string    // author/extracted bullets the AI expands
  submarketName: string
  marketVacancy: number | null
  submarketVacancy: number | null
  pop3mi: number | null
  pop5mi: number | null
  hhi3mi: number | null
  trafficCounts: string          // '58,900 vehicles per day at Academy & Briargate'
  salesCompsNote: string         // avg cap + avg psf + commentary source
  leaseCompsNote: string
  competingCentersNote: string

  // ---- Value-add ----
  valueAddInitiatives: PpmValueAdd[]

  // ---- Subscription mechanics ----
  subscriptionDeadline: string   // 'February 6, 2024'
  wireBeneficiary: string
  wireAccountNo: string
  wireBankName: string
  wireBankAddress: string
  wireRoutingNo: string
  achRoutingNo: string
  swiftCode: string
  contacts: PpmContact[]
  ppmDate: string                // date on the offering page
}

export function blankDataSheet(): PpmDataSheet {
  return {
    propertyName: '', address: '', city: '', state: '', msa: '', propertyType: '',
    dealStructure: 'jv_acquisition',
    glaSf: null, landAcres: null, yearBuilt: '', occupancyPct: null, parkingSpaces: null, parkingRatio: '',
    purchasePrice: null, pricePsf: null, goingInCap: null, inPlaceNoi: null, totalCapitalization: null,
    jvPartnerName: '', jvPartnerShort: '', jvPartnerBlurb: '', jvPartnerPct: null, mjwPct: null,
    jvHistoryNote: '', jvVehicleName: '', propertyOwnerLlc: '', jvWaterfallTiers: [],
    investorCompanyName: '', managerIncName: '',
    managerStockholders: 'Marc R. Wilkow, Clifton J. Wilkow, Gregg J. Wilkow and Jordan Wilkow',
    classAUnits: null, classAUnitPrice: 1000, classBUnits: 100, classBUnitPrice: 10,
    minSubscriptionUnits: null, classAPrefIrr: null, classAPrefEm: null, classAExcessPct: 0.70,
    totalEquity: null, partnerEquity: null, mjwEquity: null, sponsorFee: null, workingCapital: null,
    investorCompanyTotal: null, acquisitionBudget: [],
    lenderName: '', loanAmount: null, ltvPct: null, interestRate: null, rateDescription: '',
    loanTermYears: null, ioDescription: '', futureFunding: '',
    holdYears: null, exitCap: null, projSalePrice: null, projSalePsf: null, projIrr: null,
    avgCoc: null, equityMultiple: null, afterTaxIrr: null, afterTaxCoc: null, occupancyAtExit: null,
    hasUpsideCase: false, upsideHoldYears: null, upsideExitCap: null, upsideSalePrice: null,
    upsideIrr: null, upsideCoc: null, upsideEm: null, upsideAfterTaxIrr: null, upsideAfterTaxCoc: null,
    upsideNotes: '',
    opexPsfYr1: null, opexGrowthNote: 'growing at 3% each year thereafter', retPsfYr1: null, retNote: '',
    mgmtFeePct: null, capexBudgetTotal: null, capexBudgetLines: [], structuralReservePsf: 0.20,
    auditReserveAnnual: null, leasingAssumptionsNote: '', historicalNoi: [],
    landBldgSplit: '', loanFeesAcqCosts: null, stateTaxRate: null, stateTaxName: '',
    pcaFirm: 'Partner Engineering and Science, Inc.', pcaDate: '', pcaImmediateRepairs: null,
    pcaReserve12yr: null, pcaPsfPerYear: null, pcaKeyItems: '',
    esaFirm: 'Partner Engineering and Science, Inc.', esaDate: '', esaFindings: '',
    taxParcels: '', zoningText: '', accessText: '', signageText: '', siteImprovementsText: '',
    foundationText: '', facadeText: '', roofsText: '', utilitiesText: '', floodZoneText: '',
    tenants: [], coTenancy: [], tenantProfiles: [], anchorStory: '',
    marketOverviewNotes: '', submarketName: '', marketVacancy: null, submarketVacancy: null,
    pop3mi: null, pop5mi: null, hhi3mi: null, trafficCounts: '',
    salesCompsNote: '', leaseCompsNote: '', competingCentersNote: '',
    valueAddInitiatives: [],
    subscriptionDeadline: '', wireBeneficiary: '', wireAccountNo: '',
    wireBankName: '', wireBankAddress: '', wireRoutingNo: '', achRoutingNo: '', swiftCode: '',
    contacts: [
      { name: 'Marc Wilkow', phone: '312.279.5963', email: 'mwilkow@wilkow.com' },
      { name: 'Gregg Wilkow', phone: '312.279.5965', email: 'gwilkow@wilkow.com' },
    ],
    ppmDate: '',
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export const fmtMoney = (n: number | null | undefined, blank = '$________'): string =>
  n == null ? blank : '$' + Math.round(n).toLocaleString('en-US')

export const fmtNum = (n: number | null | undefined, blank = '____'): string =>
  n == null ? blank : Math.round(n).toLocaleString('en-US')

export const fmtPct = (n: number | null | undefined, dp = 1, blank = '__%'): string =>
  n == null ? blank : (n * 100).toFixed(dp).replace(/\.0+$/, '') + '%'

export const fmtMult = (n: number | null | undefined, blank = '___x'): string =>
  n == null ? blank : n.toFixed(2).replace(/0$/, '') + 'x'

export const fmtPsf = (n: number | null | undefined): string =>
  n == null ? '$___/sf' : '$' + Math.round(n).toLocaleString('en-US') + '/sf'

// ---------------------------------------------------------------------------
// Section registry
// ---------------------------------------------------------------------------

export interface SectionDef {
  key: string
  title: string
  mode: 'ai' | 'template'
  /** For AI sections: what the draft must cover (also shown as a hint in the UI). */
  hint?: string
  /** For template sections: deterministic prose from the data sheet. Paragraphs separated by \n\n. */
  render?: (ds: PpmDataSheet) => string
}

const p = (...paras: (string | false | undefined)[]) => paras.filter(Boolean).join('\n\n')

// ---- Template renderers (verbatim house form + merge fields) --------------

function renderPca(ds: PpmDataSheet): string {
  return p(
    `A Property Condition Assessment ("PCA") was prepared by ${ds.pcaFirm || '____'} on ${ds.pcaDate || '____'} - a copy of the "Quick Look" Project Summary and Estimate of Projected Costs for the Property is attached hereto as an Exhibit. A copy of the entire report will be made available to prospective Class A Unit investors upon request. The purpose of this assessment is to describe the primary systems and components of the Property, to identify conspicuous defects or material deferred maintenance, and to present an opinion of costs to remedy observed conditions. In addition, this report identifies systems or components that are anticipated to reach the end of their expected useful life during the specified evaluation term and includes an opinion of cost for future capital replacements.`,
    `The PCA for ${ds.propertyName || 'the Property'} estimates that immediate and short-term repair items total ${fmtMoney(ds.pcaImmediateRepairs)} and replacement capex reserves over the twelve-year examination period will total ${fmtMoney(ds.pcaReserve12yr)} (uninflated). Exclusive of the immediate need items, this averages out to approximately $${ds.pcaPsfPerYear == null ? '____' : ds.pcaPsfPerYear.toFixed(2)}/sf per year.${ds.pcaKeyItems ? ` It is worth noting that a majority of the capital needs described in this report are affiliated with ${ds.pcaKeyItems}.` : ''} The estimated costs listed in the reports are generally viewed to be within the typical range expected for buildings of this type, age, and use. It should be noted that the totals above include only work typically associated with landlord obligations and are only intended to reflect maintenance of the Property at a level comparable to its current state.`,
  )
}

function renderEsa(ds: PpmDataSheet): string {
  return p(
    `A Phase I Environmental Site Assessment was prepared by ${ds.esaFirm || '____'} on ${ds.esaDate || '____'} - a copy of the Findings and Conclusions Summary is attached hereto as an Exhibit - a copy of the entire report will be made available to prospective Class A Unit investors upon request. This assessment was performed in conformance with the scope and limitations as detailed in the ASTM Practice E1527 Standard Practice for Environmental Site Assessments: Phase I Environmental Site Assessment Process. This assessment included a site reconnaissance as well as research and interviews with representatives of the public, property ownership, site manager, and regulatory agencies.`,
    ds.esaFindings
      ? `In summary, the Phase I ESA for ${ds.propertyName || 'the Property'} ${ds.esaFindings}`
      : `In summary, the Phase I ESA for ${ds.propertyName || 'the Property'} identified no evidence of active Recognized Environmental Conditions (RECs), Controlled Recognized Environmental Conditions (CRECs), or Historical Recognized Environmental Conditions (HRECs). Based on the conclusions of this assessment, ${ds.esaFirm || 'the consultant'} recommended no further investigation of the Property at this time.`,
  )
}

function renderPropertyDetails(ds: PpmDataSheet): string {
  const row = (label: string, val: string) => (val ? `${label}:\t${val}` : `${label}:\t____`)
  return [
    row('Address', [ds.address, [ds.city, ds.state].filter(Boolean).join(', ')].filter(Boolean).join('\n\t')),
    row('Year Built', ds.yearBuilt),
    row('Tax Parcel ID', ds.taxParcels),
    row('Zoning', ds.zoningText),
    row('Land Area', ds.landAcres == null ? '' : `${ds.landAcres} acres`),
    row('GLA', ds.glaSf == null ? '' : `${fmtNum(ds.glaSf)} square feet`),
    row('Occupancy', ds.occupancyPct == null ? '' : fmtPct(ds.occupancyPct, 1)),
    row('Parking', ds.parkingSpaces == null ? '' : `${fmtNum(ds.parkingSpaces)} spaces (${ds.parkingRatio || '____'})`),
    row('Access', ds.accessText),
    row('Signage', ds.signageText),
    row('Site Improvements', ds.siteImprovementsText),
    row('Foundation/Substructure', ds.foundationText),
    row('Facade', ds.facadeText),
    row('Roofs', ds.roofsText),
    row('Utilities', ds.utilitiesText),
    row('Flood Zone', ds.floodZoneText),
  ].join('\n\n')
}

function renderTenantProfiles(ds: PpmDataSheet): string {
  if (!ds.tenantProfiles.length) return '(Add tenant profiles on the data sheet - one standing blurb per major tenant.)'
  return ds.tenantProfiles.map(tp => p(
    `${tp.name}\nRentable Area: ${tp.sf == null ? '____' : fmtNum(tp.sf)} square feet${tp.creditRating ? `\nCredit Rating: ${tp.creditRating}` : ''}\nLease Expiration: ${tp.expiration || '____'}`,
    tp.blurb,
  )).join('\n\n')
}

function renderTaxSection(ds: PpmDataSheet): string {
  return p(
    `Attached hereto is the After-Tax Cash Flow Forecast for the Base Case, which has been prepared based on the assumptions indicated herein, as well as the tax-related assumptions delineated below. If these assumptions are realized, the projected after-tax average, annual cash flow yield (excluding projected sale proceeds) is ${fmtPct(ds.afterTaxCoc)} and the projected after-tax internal rate of return is ${fmtPct(ds.afterTaxIrr)}.`,
    ds.hasUpsideCase && `Attached hereto is the After-Tax Cash Flow Forecast for the Upside Case. If those assumptions are realized, the projected after-tax average, annual cash flow yield (excluding projected sale proceeds) is ${fmtPct(ds.upsideAfterTaxCoc)} and the projected after-tax internal rate of return is ${fmtPct(ds.upsideAfterTaxIrr)}.`,
    `In connection with the preparation of the After-Tax Cash Flow Forecast, we have made the following tax-sensitive assumptions:`,
    `Depreciation and Amortization\n\nLand/Building - ${ds.landBldgSplit || '____'} split\nLoan Fees/Acquisition Costs - ${fmtMoney(ds.loanFeesAcqCosts)}\nLeasing Commissions - Assumed an average renewal of 6 years`,
    `Tax Rates\n\nFederal - 37%\nFederal - LTCG - 20% and 25% Depreciation Recapture\nState - ${fmtPct(ds.stateTaxRate, 2)} (${ds.stateTaxName || ds.state || '____'})`,
    `For a more extensive discussion of tax-related considerations, prospective investors are urged to review the Tax Considerations exhibit. Prospective investors are urged to consult their tax advisor regarding the tax implications of this investment for their personal financial situation.`,
  )
}

function renderCapitalStructure(ds: PpmDataSheet): string {
  const budget = ds.acquisitionBudget.length
    ? ds.acquisitionBudget.map(b => `\t${b.item}\t${fmtMoney(b.amount)}`).join('\n')
    : `\tPurchase Price\t${fmtMoney(ds.purchasePrice)}\n\t(itemize loan fees, closing costs, legal, contingency on the data sheet)`
  return p(
    `The Acquisition Budget reflects: (i) a total capitalization of ${fmtMoney(ds.totalCapitalization)}; (ii) the funding of a new mortgage loan in the principal amount of approximately ${fmtMoney(ds.loanAmount)}; and (iii) an equity capital requirement of ${fmtMoney(ds.totalEquity)}.`,
    `A.\tAcquisition Budget - The Acquisition Budget of ${fmtMoney(ds.totalCapitalization)} is comprised of the following line items:\n\n${budget}\n\t   Total Acquisition Costs\t${fmtMoney(ds.totalCapitalization)}`,
    `B.\tAcquisition Sources - The ${fmtMoney(ds.totalCapitalization)} Acquisition Budget will be funded through equity and debt sources according to the following:\n\n\t${ds.jvPartnerShort || 'Partner'} Equity\t${fmtMoney(ds.partnerEquity)}\n\tWilkow Investor Company\t${fmtMoney(ds.mjwEquity)}\n\tFirst Mortgage Debt\t${fmtMoney(ds.loanAmount)}\n\t  Total Acquisition Sources\t${fmtMoney(ds.totalCapitalization)}`,
    `C.\tMortgage Loan - A new first mortgage financing (the "Mortgage Loan") will be provided by ${ds.lenderName || '____'} in the maximum principal amount of approximately ${fmtMoney(ds.loanAmount)} (${fmtPct(ds.ltvPct, 0)} Loan-to-Value based on the purchase price). The Mortgage Loan will be for a term of ${ds.loanTermYears == null ? '____' : ds.loanTermYears} years. The interest rate applicable to the Mortgage Loan has been locked at ${fmtPct(ds.interestRate, 2)} per annum. ${ds.ioDescription || ''} Copies of the loan documents relating to the Mortgage Loan will be made available to prospective Class A Unit investors upon request.`,
    `D.\tEquity Capital - The Operating Company will be funded with equity capital in the amount of approximately ${fmtMoney(ds.totalEquity)} - ${fmtPct(ds.jvPartnerPct, 0)} of which (${fmtMoney(ds.partnerEquity)}) will be funded by ${ds.jvPartnerShort || 'the Partner'} and ${fmtPct(ds.mjwPct, 0)} of which (${fmtMoney(ds.mjwEquity)}) will be funded by the Wilkow Investor Company. To meet its allocable equity capital funding requirement to the Operating Company, as well as cover: (i) a sponsor fee payable to M & J Wilkow ("MJW") in the amount of ${fmtMoney(ds.sponsorFee)}; and (ii) a contingency expense and working capital account for the Wilkow Investor Company of approximately ${fmtMoney(ds.workingCapital)} - the Wilkow Investor Company's capital requirement will be ${fmtMoney(ds.investorCompanyTotal)}. The non-member manager of the Wilkow Investor Company will be ${ds.managerIncName || '____'}, a newly organized Delaware corporation, the direct or indirect (through a trust) stockholders of which are ${ds.managerStockholders}.`,
  )
}

function renderJvStructure(ds: PpmDataSheet): string {
  const tiers = ds.jvWaterfallTiers.length
    ? ds.jvWaterfallTiers.map(t => `\tThe split shall be ${t.split} until such time as ${t.until}.`).join('\n\n')
    : '\t(Add the JV promote tiers on the data sheet.)'
  return p(
    `The Property will be owned by a newly formed single purpose Delaware limited liability company called ${ds.propertyOwnerLlc || '____'}, which will be wholly owned by ${ds.jvVehicleName || '____'} (the "Joint Venture"), also a single purpose Delaware limited liability company. As more fully outlined in the Joint Venture Term Sheet attached hereto as an Exhibit, the Joint Venture will be owned ${fmtPct(ds.jvPartnerPct, 0)} by ${ds.jvPartnerShort || 'the Partner'} and ${fmtPct(ds.mjwPct, 0)} by the Wilkow Investor Company. Day-to-day operating matters will be the responsibility of the Wilkow Investor Company in its capacity as the Managing Member. All major decisions, such as the right to sell or refinance the Property, shall require the approval of ${ds.jvPartnerShort || 'the Partner'} and the Wilkow Investor Company. A copy of the Joint Venture's Operating Agreement will be made available to prospective investors upon request.`,
    ds.jvPartnerBlurb,
    `Distributions of all cash flow shall first be made, on a pari passu basis, to each party in proportion to such party's ownership interest, i.e. ${fmtPct(ds.jvPartnerPct, 0)} to ${ds.jvPartnerShort || 'the Partner'} and ${fmtPct(ds.mjwPct, 0)} to the Wilkow Investor Company. If the first hurdle is met, a disproportionate allocation of excess cash will be made according to the following achievement levels:\n\n${tiers}`,
  )
}

function renderInvestorCompany(ds: PpmDataSheet): string {
  const excess = ds.classAExcessPct
  return p(
    `The Wilkow Investor Company will issue ${fmtNum(ds.classAUnits)} Class A Units to selected accredited investors at the rate of ${fmtMoney(ds.classAUnitPrice)} per unit. Certain parties affiliated with MJW will receive an allocation, in the aggregate, of ${fmtNum(ds.classBUnits)} Class B Units, at the rate of ${fmtMoney(ds.classBUnitPrice)} per unit, which will be subordinate to the Class A Units as explained below.`,
    `The Class A Units Preference: All cash proceeds representing either operating cash flow or capital event proceeds shall be distributed exclusively to the members owning Class A Units until such members have received the lesser of: (i) a ${fmtPct(ds.classAPrefIrr)} IRR on their investment, or (ii) an equity multiple of ${fmtMult(ds.classAPrefEm)} (the "Class A Preference"). After the Class A Preference is achieved, excess proceeds shall be split ${fmtPct(excess, 0)} to the Class A Members and ${excess == null ? '__%' : fmtPct(1 - excess, 0)} to the Class B Members.`,
    `Accordingly, the Class B Units will be entitled to the following:\n\nOperating Cash Flow:\tNone\n\nSale/Refinancing Proceeds:\t${excess == null ? '__%' : fmtPct(1 - excess, 0)} of excess proceeds after Class A members have achieved the Class A Preference`,
    `"Base Case" Projected Yields: If the assumptions underpinning the "Base Case" Financial Forecast are realized, the projection suggests: (i) a levered pre-tax Internal Rate of Return ("IRR") of approximately ${fmtPct(ds.projIrr)} (after-tax approximately ${fmtPct(ds.afterTaxIrr)}); (ii) an average cash on cash annual return of ${fmtPct(ds.avgCoc)} (after-tax excluding projected sale proceeds approximately ${fmtPct(ds.afterTaxCoc)}); and (iii) an equity multiple of approximately ${fmtMult(ds.equityMultiple)} - to the Class A unit members over an assumed ${ds.holdYears ?? '____'}-year holding period.`,
    ds.hasUpsideCase && `"Upside Case" Projected Yields: If the assumptions underpinning the "Upside Case" Financial Forecast are realized, the projection suggests: (i) a levered pre-tax Internal Rate of Return ("IRR") of approximately ${fmtPct(ds.upsideIrr)} (after-tax approximately ${fmtPct(ds.upsideAfterTaxIrr)}); (ii) an average cash on cash annual return of ${fmtPct(ds.upsideCoc)} (after-tax excluding projected sale proceeds approximately ${fmtPct(ds.upsideAfterTaxCoc)}); and (iii) an equity multiple of approximately ${fmtMult(ds.upsideEm)} - to the Class A unit members over an assumed ${ds.upsideHoldYears ?? '____'}-year holding period.`,
    `A copy of the Wilkow Investor Company's Operating Agreement is attached hereto as an Exhibit.`,
  )
}

function renderCompensation(ds: PpmDataSheet): string {
  return p(
    `If the acquisition of the Property is completed, affiliates of MJW will be compensated for services rendered through the closing, and to be rendered in the future, as follows:`,
    `A.\tAt the Operating Company level, affiliates of M & J Wilkow will be entitled to the following: (i) an annual property net management fee equal to ${fmtPct(ds.mgmtFeePct, 2)} of annual gross revenue generated by the Property; (ii) a market commission for lease extensions (unless the same is a result of the tenant's exercise of an option to extend based on prescribed rental terms); (iii) a construction supervision fee payable from time to time equal to no more than five percent (5%) of the construction cost; and (iv) a one-time fee (in lieu of an acquisition fee) that will reimburse M & J Wilkow for ${fmtPct(ds.jvPartnerPct, 0)} of due diligence costs incurred to date.`,
    `B.\tAt the Wilkow Investor Company level, affiliates of M & J Wilkow will be entitled to the following: (i) a Sponsor Fee in the amount of ${fmtMoney(ds.sponsorFee)}; (ii) an Investment Advisor's fee of $500 per annum; and (iii) the subordinated Class B Units described above.`,
  )
}

function renderSubscription(ds: PpmDataSheet): string {
  const contacts = ds.contacts.filter(c => c.name)
    .map(c => `${c.name} at ${[c.phone, c.email].filter(Boolean).join(' or ')}`).join('; ')
  return p(
    `Prospective accredited investors who wish to subscribe for Class A Units in the Wilkow Investor Company should: (i) review the applicable Subscription Book, which consists of a Subscription Agreement and a Signature Page for the Wilkow Investor Company's Operating Agreement; (ii) complete and sign the accompanying applicable Subscription Agreement; (iii) complete and sign the accompanying applicable Signature Page for the Wilkow Investor Company's Operating Agreement; (iv) return these documents to M & J Wilkow's office on or prior to ${ds.subscriptionDeadline || '____'}; and (v) transfer funds in the amount of the subscription to ${ds.wireBeneficiary || ds.investorCompanyName || '____'} in the amount of ${fmtMoney(ds.classAUnitPrice)} times the number of Class A Units requested on or prior to ${ds.subscriptionDeadline || '____'}, using the following transfer instructions:`,
    `Beneficiary Name:\t${ds.wireBeneficiary || ds.investorCompanyName || '____'}\nBeneficiary Account No.:\t${ds.wireAccountNo || '____'}\nBank Name:\t${ds.wireBankName || '____'}\nBank Address:\t${ds.wireBankAddress || '____'}\nWire Routing No.:\t${ds.wireRoutingNo || '____'}\nACH Routing No.:\t${ds.achRoutingNo || '____'}\nSWIFT Code:*\t${ds.swiftCode || '____'}\n\n*Used only for wires initiated outside of the U.S.`,
    `Prospective investors and their advisors should feel free to contact ${contacts || '____'}, with any questions they may have concerning this investment opportunity. As usual, in the event of an over-subscription, it is necessary for MJW to reserve the right to reduce or reject a requested subscription, and please bear in mind that this investment opportunity is only available to prospective investors who can represent that they are "accredited investors," as defined in the Subscription Agreements.`,
  )
}

// ---- Registry --------------------------------------------------------------

export const PPM_SECTIONS: SectionDef[] = [
  {
    key: 'exec_summary', title: 'EXECUTIVE SUMMARY', mode: 'ai',
    hint: 'Opening transaction paragraph (entities, JV partner, "presents selected accredited investors..."), partner credibility paragraph, property overview, Wilkow Investor Company raise + Class A/B waterfall, and Projected Yields and Assumptions (base + upside if present).',
  },
  {
    key: 'transaction_highlights', title: 'TRANSACTION HIGHLIGHTS', mode: 'ai',
    hint: 'Bolded lead-in subsections: Dominant Regional Location / Strong Market Fundamentals & Favorable Demographics / Diversified Tenant Mix / Attractive Current Yields / Attractive Cost Basis / Potential Value-Add Initiatives (from the data-sheet initiatives).',
  },
  {
    key: 'market_analysis', title: 'MARKET ANALYSIS', mode: 'ai',
    hint: 'MSA overview, submarket overview, retail market overview, relevant sales comps commentary, competing centers, relevant lease comps commentary. Grounded in the market stats + comps notes on the data sheet.',
  },
  {
    key: 'property_description', title: 'PROPERTY DESCRIPTION', mode: 'ai',
    hint: '2-3 paragraph physical/narrative description: location, buildings, tenant placement, trade area. The PCA/ESA/Property Details blocks that follow are auto-generated.',
  },
  { key: 'pca', title: 'PROPERTY CONDITIONS REPORT', mode: 'template', render: renderPca },
  { key: 'esa', title: 'ENVIRONMENTAL SITE ASSESSMENT', mode: 'template', render: renderEsa },
  { key: 'property_details', title: 'PROPERTY DETAILS', mode: 'template', render: renderPropertyDetails },
  {
    key: 'tenancy', title: 'TENANCY', mode: 'ai',
    hint: 'Tenant-mix overview naming notable tenants + SF, anchor performance story (sales, health ratios, Placer rankings), leasing momentum/renewal history, and a co-tenancy lead-in. The roster table and per-tenant co-tenancy blocks are auto-generated from the data sheet.',
  },
  { key: 'tenant_profiles', title: 'PROFILES OF MAJOR TENANTS', mode: 'template', render: renderTenantProfiles },
  {
    key: 'financial_analysis', title: 'FINANCIAL ANALYSIS', mode: 'ai',
    hint: 'Forecast summary (hold, exit cap, sale price, IRR/CoC/EM), loan terms paragraph, going-in cap + NOI paragraph, per-anchor renewal/mark-to-market assumptions, PCA-derived capex paragraph, additional underwriting assumptions (opex/RET/mgmt fee/reserves), historical NOI commentary, and the Upside Case subsection if present.',
  },
  { key: 'tax_section', title: 'TAX SECTION', mode: 'template', render: renderTaxSection },
  {
    key: 'risks', title: 'POTENTIAL PROPERTY SPECIFIC RISKS & RISK MITIGANTS', mode: 'ai',
    hint: 'Lettered A-H subsections, each Risks: / Potential Risk Mitigants:. Standard set: Retail Industry in Transition; Exclusives/Co-Tenancy/Go-Dark; Rollover Exposure; Future Competition; Unanticipated Capital Expenditures; Interest Rate Risk; DSCR/LTV Cash Flow Sweep; Absence of Sales Reports. Tailor each mitigant to THIS deal’s data.',
  },
  { key: 'capital_structure', title: 'CAPITAL STRUCTURE', mode: 'template', render: renderCapitalStructure },
  { key: 'jv_structure', title: 'THE JOINT VENTURE', mode: 'template', render: renderJvStructure },
  { key: 'investor_company', title: 'WILKOW INVESTOR COMPANY', mode: 'template', render: renderInvestorCompany },
  { key: 'compensation', title: 'COMPENSATION TO M & J WILKOW AND AFFILIATES', mode: 'template', render: renderCompensation },
  { key: 'subscription', title: 'SUBSCRIPTION INSTRUCTIONS', mode: 'template', render: renderSubscription },
]

export const sectionByKey = (key: string): SectionDef | undefined => PPM_SECTIONS.find(s => s.key === key)

// ---------------------------------------------------------------------------
// Number verification — every $ / % / multiple in an AI draft must exist in
// the data sheet (formatted any way). Returns the tokens that DON'T.
// ---------------------------------------------------------------------------

function collectNumbers(v: unknown, out: Set<string>): void {
  if (v == null) return
  if (typeof v === 'number' && isFinite(v)) {
    out.add(normNum(String(v)))
    // percent stored as decimal -> also allow its x100 rendering (0.0798 -> 7.98)
    if (Math.abs(v) < 1.0000001) out.add(normNum((v * 100).toFixed(4)))
    return
  }
  if (typeof v === 'string') {
    for (const m of v.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(normNum(m[0]))
    return
  }
  if (Array.isArray(v)) { v.forEach(x => collectNumbers(x, out)); return }
  if (typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(x => collectNumbers(x, out))
}

/** strip commas + trailing zeros so '2.30' === '2.3' and '51,286,066' === '51286066' */
function normNum(s: string): string {
  const n = Number(s.replace(/,/g, ''))
  return isFinite(n) ? String(n) : s
}

export interface NumberCheck { token: string; ok: boolean }

/**
 * Scan an AI draft for risk-bearing numeric tokens ($ amounts, percentages,
 * equity multiples) and flag any that do not appear anywhere in the data sheet.
 * Bare integers (years, counts) are deliberately not flagged.
 */
export function verifyNumbers(text: string, ds: PpmDataSheet): NumberCheck[] {
  const known = new Set<string>()
  collectNumbers(ds, known)
  const seen = new Map<string, boolean>()
  const tokens = text.matchAll(/\$\s?[\d,]+(?:\.\d+)?(?:\s?million|\s?billion|M\b|B\b)?|[\d,]+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?x\b/gi)
  for (const m of tokens) {
    const raw = m[0]
    if (seen.has(raw)) continue
    let numPart = raw.replace(/[$%x\s]/gi, '').replace(/million|billion|M$|B$/i, '')
    let val = Number(numPart.replace(/,/g, ''))
    if (/million|M$/i.test(raw)) val *= 1_000_000
    if (/billion|B$/i.test(raw)) val *= 1_000_000_000
    const ok = known.has(String(val)) || known.has(normNum(numPart))
    seen.set(raw, ok)
  }
  return [...seen.entries()].map(([token, ok]) => ({ token, ok }))
}
