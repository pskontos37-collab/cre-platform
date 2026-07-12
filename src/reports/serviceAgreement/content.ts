// Service-agreement generator — canonical content model.
//
// ONE source of the agreement's words, rendered to BOTH the editable .docx and
// the send-ready PDF so the two outputs can never drift. The legal boilerplate
// is transcribed verbatim from the approved M&J Wilkow Word template (Sections
// 1-18); only the party identifiers (from config.ts) and the fill-in blanks
// (from the user's AgreementInput) vary.
//
// The blank-vs-filled term clauses mirror how the form is actually used: BOTH
// Section 3(a) (continuing) and 3(b) (single event) always appear; the user
// fills the one that applies and the other keeps its underscores — exactly like
// the executed examples in the file room.

import { PROPERTY_CONFIGS, type AgreementInput } from './config'

export interface Run { t: string; b?: boolean }
export interface Block {
  kind: 'title' | 'heading' | 'para'
  runs: Run[]
  indent?: number            // 0 top-level, 1 = (a)/(b), 2 = (i)/(ii)
  align?: 'left' | 'justify' | 'center'
}

export interface SignatureData {
  ownerEntity: string
  vendorName: string
  ownerChain: string[]
  ownerName: string
  ownerTitle: string
  vendorSignName: string
  vendorSignTitle: string
}

export interface AgreementContent {
  agreement: Block[]
  signature: SignatureData
  exhibitB: Block[]
  /** Suggested base filename (no extension), e.g. "Service-Agreement-KME-Baker-Roofing". */
  baseFilename: string
}

// ── run helpers ──────────────────────────────────────────────────────────────
const t = (text: string): Run => ({ t: text })
const b = (text: string): Run => ({ t: text, b: true })
const para = (indent: number, runs: Run[], align: Block['align'] = 'justify'): Block => ({ kind: 'para', runs, indent, align })
const DATE_BLANK = '____________________'

const nonEmpty = (s: string, fallback: string) => (s.trim() ? s.trim() : fallback)

export function buildContent(input: AgreementInput): AgreementContent {
  const cfg = PROPERTY_CONFIGS[input.property]
  const vendor = nonEmpty(input.vendorName, '____________________')
  const business = nonEmpty(input.vendorBusiness, '____________________')
  const day = nonEmpty(input.day, '____')
  const month = nonEmpty(input.month, '____________')
  const year = nonEmpty(input.year, '20____')
  const mgmt = cfg.managementAgentBody

  // Term clauses — fill the chosen one, leave the other's blanks.
  const aFilled = input.termType === 'continuing'
  const start = nonEmpty(input.startDate, DATE_BLANK)
  const end = nonEmpty(input.endDate, DATE_BLANK)
  const aStart = aFilled ? start : DATE_BLANK
  const aEnd = aFilled ? end : DATE_BLANK
  const bStart = aFilled ? DATE_BLANK : start
  const bEnd = aFilled ? DATE_BLANK : end

  const agreement: Block[] = [
    { kind: 'title', runs: [b('SERVICE AGREEMENT')], align: 'center' },

    para(0, [
      t('This Service Agreement (the “Agreement”) is made this '),
      t(day), t(' day of '), t(month), t(', '), t(year),
      t(', by and between '), t(vendor), t(' (the “Vendor”) and '),
      b(cfg.ownerEntity), t(', a Delaware limited liability company, d/b/a '),
      t(cfg.dba), t(' (the “Owner”).'),
    ]),

    { kind: 'heading', runs: [b('RECITALS:')], align: 'left' },
    para(1, [
      b('A. '),
      t(`Owner is the owner of the property known as ${cfg.propertyName}, ${cfg.cityState} (the “Property”), and`),
    ]),
    para(1, [
      b('B. '),
      t('Vendor is in the business of '), t(business), t(' contracted services.'),
    ]),

    { kind: 'heading', runs: [b('AGREEMENTS:')], align: 'left' },
    para(0, [t('NOW, THEREFORE, it is agreed as follows:')]),

    para(0, [
      b('1. Services. '),
      t('Vendor will perform services at the Property for Owner as follows: See attached Exhibit “A” for a description of the services to be provided (the “Services”). “See list of services set forth on the vendor proposal attached hereto as Exhibit “A” To the extent of a conflict between the provisions of this Agreement and the proposal attached hereto as Exhibit “A”, the provisions of this Agreement shall govern and control.”'),
    ]),

    para(0, [
      b('2. Compensation. '),
      t('For performing such Services Vendor will receive compensation of: See attached Exhibit A. Such compensation is payable within thirty (30) days after receipt by Owner of Vendor’s itemized invoice of Services performed and all appropriate waivers of liens.  All out-of-pocket expenses incurred by Vendor in performing Services hereunder shall be the sole responsibility of Vendor, and shall not be reimbursed by Owner.'),
    ]),

    para(0, [b('3. Contract Period/Term.')]),
    para(1, [
      t('(a)  This is an Agreement for continuing Services.  The Term of this Agreement shall commence on '),
      t(aStart), t(' and expire on '), t(aEnd),
      t(', except that either party hereto may terminate this Agreement on an earlier date: (i) at any time for any reason by giving the other party thirty (30) days prior written notice or (ii) upon the occurrence of a default as described in Section 9 hereof.  If an early termination shall occur as herein provided under clause (i) above, Vendor shall only be entitled to compensation earned up to the effective date of such termination.'),
    ]),
    para(1, [
      t('(b)  This is an Agreement for the performance of Services as a single event.  The Services are anticipated to commence on '),
      t(bStart), t(' and shall be completed in accordance with the terms of this Agreement on or before '),
      t(bEnd),
      t('.  Either party may terminate this Agreement by giving the other party thirty (30) days prior written notice and Vendor shall only be entitled to compensation earned up to the effective date of termination.'),
    ]),

    para(0, [
      b('4. Independent Contractor. '),
      t('In connection with the performance of the Services, Vendor shall at all times remain an independent contractor, and Vendor is not, and will not, become by reason of its performance hereunder an agent or employee of Owner, and no joint enterprise or partnership is intended by this Agreement.  Vendor, its agents and employees, and the agents and employees of its subcontractors, subsidiaries and affiliates shall not be or become agents or employees of Owner by virtue of this Agreement or any performance hereunder.'),
    ]),

    para(0, [b('5. Other Covenants of Vendor. '), t('Vendor shall:')]),
    para(1, [t('(a)  Furnish, at its sole cost and expense, all necessary labor, materials, tools, supplies, equipment, transportation, facilities and drawings and samples, to perform the Services described herein in a first class, expeditious and workmanlike manner, all in accordance with Owner’s specifications and regulations of authorities having jurisdiction over such activities; with minimum inconvenience to or interference with tenants and others, and to the full satisfaction of Owner and to keep the Property free and clear of all mechanics and materialmen liens in respect of the Services rendered pursuant hereto.')]),
    para(1, [t('(b)  Comply with all laws, ordinances, orders or requirements affecting the Services hereunder of any federal, state, county or municipal authority having jurisdiction thereof, including without limitation environmental laws, and to comply with the directives of the board of fire underwriters or other similar bodies.  Vendor shall obtain at its sole cost and expense all applicable permits and licenses.  Vendor shall at all times exercise due care to protect all portions of the Property and the persons present therein from potential damage or injury resulting from the rendering of the Services.')]),
    para(1, [
      t('(c)  Obtain at its sole cost and expense and maintain throughout the Term hereof the insurance described below, upon terms and conditions satisfactory to Owner and with insurance companies both authorized to do business in the state in which the Property is located and having an A.M. Best rating of A:X or better from Best’s Key Rating Guide, insuring Vendor and, to the extent indemnification is required pursuant to Section 6 hereof, add as “Additional Insureds,” Owner and Owner’s management agent (which is currently '),
      t(mgmt),
      t('), and where required by Owner, the mortgagee or ground lessor of Owner, and their respective employees, agents, successors and assigns, against claims, damages or losses which may arise out of, in connection with or result from the rendering of Services on the part of Vendor, which insurance policies shall be on an occurrence basis.'),
    ]),
    para(2, [t('(i)  Commercial General Liability insurance, including Premises/Operations, Bodily Injury, Personal Injury, Broad Form Property Damage, Contractual Liability, “XCU” (explosion, collapse and underground hazards), Independent Contractors, and Products/Completed Operations coverage for two years, which insurance shall apply separately to each contract, with limits of not less than $2,000,000 per occurrence and in the aggregate, combined single limit.  The Additional Insureds are to be named on a primary, non-contributory basis (with respect to any other insurance or self-insurance programs afforded to the Additional Insureds) to the extent a claim, damages or loss arises out of the rendering of Services on the part of Vendor.')]),
    para(2, [t('(ii)  Commercial Automobile Liability insurance, insuring all owned, non-owned, and hired automobiles, including the loading and unloading thereof, and for bodily injury, and property damage, with limits not less than $1,000,000 per accident and in the aggregate, combined single limit.  If there are no owned automobiles, non-owned and hired coverage may be included within the Commercial General Liability insurance policy.  The Additional Insureds shall be named on a primary, non-contributory basis to the extent a claim, damages or loss arises out of the rendering of Services on the part of Vendor.')]),
    para(2, [t('(iii)  Workmen’s Compensation and Employers Liability insurance (covering all employees of Vendor and its subcontractors) with the limit of the Employers liability to be not be less than $500,000.00 per each accident and disease and the worker’s compensation coverage limit to be in accordance with the statutes of the state in which the Property is located.  Such policy shall include a waiver of Subrogation in favor of the Additional Insureds.')]),
    para(2, [t('(iv)  Any other insurance required by federal, state or local laws.')]),
    para(1, [t('The foregoing insurance may be provided by a company wide blanket insurance policy or policies maintained by or on behalf of Vendor, provided that such policy(s) references the Property and the Additional Insureds, as required by this Agreement as additional insured parties, sets forth the minimum guaranteed coverage amounts, and is otherwise reasonably satisfactory to Owner.  No policy for Vendor’s insurance shall provide for a deductible amount which exceeds one thousand dollars ($1,000.00).  Each insurance policy shall provide for ten (10) days prior written notice to Owner of any material change, cancellation, or non-renewal, and shall contain a clause setting forth that such policy shall be primary with respect to any policies maintained by Owner or the other Additional Insureds and that any coverage carried by Owner or the other Additional Insureds shall be excess insurance.  The amount of any insurance company’s liability under the policies specified herein shall not be reduced by the existence of such other insurance.  Evidence of insurance coverage and limits required above shall in no way limit Vendor’s liabilities and responsibilities under this Agreement.  Any and all deductibles applicable to the required coverages shall be borne solely by Vendor.  Vendor shall, prior to the commencement of the Term, furnish to Owner evidence of insurance on a standard Accord ISO form CG 20 37 detailing the required coverages as being in force on the commencement date of the Term, and during the Term shall furnish renewal certificates thirty (30) days prior to the expiration of any of the policies of insurance.  Vendor shall self-insure, or insure at its own expense, all of its personal property.')]),

    para(0, [
      b('6. Indemnity/Release. '),
      t('(a) To the fullest extent permitted by law, Vendor shall defend (using attorneys acceptable to Owner), hold harmless and indemnify Owner, and Owner’s property manager (“Property Manager”), which is currently '),
      t(mgmt),
      t(', and the mortgagee or ground lessor of the Property, and their respective employees, agents, successors and assigns, (herein collectively referred to as the “Indemnified Parties”) from and against all claims, liens, actions, liabilities, damages, losses, costs and expenses, including attorney’s fees, (collectively “Claim(s)”) to the extent arising out of or resulting from the performance of or the failure to perform the Services by Vendor or any of its subcontractors, including any Claim that: (a) is attributable to bodily injury, sickness, disease or death, or to injury to, loss of or destruction to tangible property including the loss of use resulting therefrom or the failure of Vendor to comply with any law or governmental requirement, or (b) is caused in whole or in part by the acts or omissions of Vendor, any subcontractor, any materialman, or anyone, directly or indirectly, involved in performing such Services.  Such obligation shall not be construed to negate, abridge, or otherwise reduce any other right or obligation of indemnity which would otherwise exist as to any party or person described in this Section.  In addition, Vendor shall protect, defend (using attorneys acceptable to Owner), hold harmless, and indemnify the Indemnified Parties from and against all Claims arising out of or resulting from Vendor’s failure to purchase all insurance required by this Agreement or Vendor’s failure to require and obtain proper insurance from its subcontractors.'),
    ]),
    para(1, [t('(b)  To the fullest extent permitted by law, Vendor releases: Owner and Property Manager, and the mortgagee or ground lessor of the Property, and their respective employees, agents, successors and assigns (herein collectively referred to as the “Released Parties”) from, and waives all claims, liens, actions, liabilities, damages, losses, costs and expenses, including attorney’s fees, (collectively “Claim(s)”) to person or property arising out of or resulting from the performance of or the failure to perform the Services by Vendor or any of its subcontractors, including any Claim that: (a) is attributable to bodily injury, sickness, disease or death, or to injury to, loss of or destruction to tangible property including the loss of use resulting therefrom or the failure of Vendor to comply with any law or governmental requirement, or (b) is caused in whole or in part by the acts or omissions of Vendor or Vendor’s employees, subcontractors, materialmen, or agents, directly or indirectly, involved in performing such Services.  If any such damage, whether to Owner or to occupants of the Property, results from an act or omission to act on the part of Vendor or Vendor’s employees, subcontractors, materialmen or agents, Vendor shall be liable therefor and Owner may, at Owner’s option, repair such damage and Vendor shall, upon demand by Owner, reimburse Owner forthwith for the total cost of such repairs.')]),
    para(1, [t('(c)  The provisions of this Section 6 shall survive the expiration or earlier termination of this Agreement.  Property Manager and the mortgagee or ground lessor and their respective employees, agents, successors and assigns, are intended third-party beneficiaries of this Section 6.')]),

    para(0, [
      b('7. Warranties. '),
      t('Vendor warrants that: (a) the materials to be supplied pursuant to this Agreement shall be new, fit and sufficient for the purpose intended, (b) the materials shall be merchantable, of good quality, and free from defects, whether patent or latent, in material or workmanship, and (c) all Services performed under this Agreement shall be done in a good and workmanlike manner consistent with the operation of the Property as a first class property.  In the event of any defect in the materials supplied or Services performed hereunder, Vendor shall replace or repair, at its own cost or expense, the components of the Property damaged or otherwise necessary to cure the defect suffered.  This provision shall not limit any other rights Owner might have at law or in equity.  Vendor further warrants that Vendor shall have title to the materials supplied and that the materials shall be free and clear of all liens, encumbrances and security interests.  All warranties made in this Agreement, together with service warranties and guarantees, shall run to Owner and its successors, assigns, invitees and lessees.  The provisions of this Section 7 shall survive the expiration or earlier termination of this Agreement.'),
    ]),

    para(0, [
      b('8. Labor Disputes. '),
      t('In the event of labor disputes or difficulties, Vendor shall settle the same promptly in a manner fully satisfactory to Owner without interference with Owner’s operations on the Property.  In the event any such labor disputes or difficulties are not settled in a manner satisfactory to Owner, Owner has the right to terminate this Agreement immediately, and in the event of such termination, Vendor shall only be entitled to compensation earned up to the date of such termination.  In no event shall Owner incur any liability to Vendor as a result of such early termination.'),
    ]),

    para(0, [
      b('9. Default and Termination. '),
      t('A failure by either party to observe and perform any provision of this Agreement to be observed or performed by that party, if such failure continues for five (5) days after written notice thereof by the non-defaulting party to the defaulting party, shall constitute default of this Agreement.  In the event of any such default, then, in addition to any other remedies available to the non-defaulting party at law or in equity, the non-defaulting party shall have the option to terminate this Agreement and all rights of the defaulting party hereunder by giving five (5) days prior written notice of such termination.  If any early termination shall occur as herein provided, Vendor shall not be entitled to the compensation it would have earned after the effective date of such termination and in the event of a default on the part of Vendor, Vendor may be subject to a damages award.'),
    ]),

    para(0, [
      b('10. Notice. '),
      t('All notices, demands or other communications (“Notice(s)”) given pursuant to this Agreement shall be in writing, and shall be sent either by (i) United States Postal Service, postage prepaid, certified mail/return receipt requested; or (ii) by personal service to a representative of the receiving party or (iii) via nationally recognized overnight air courier service (with instructions to deliver the Notice on the next business day), addressed as described below.  Any such Notice shall be deemed given on the earliest of (i) on the date which is three (3) days after deposit in an official United States Postal Service receptacle if delivered via the United States Postal Service; (iii) on the first business day after deposit with an overnight air courier service with instructions to deliver on the next business day; or (iii) on the date of actual delivery.  If a party refuses to accept a Notice, the Notice will be deemed to have been delivered on the date tendered, but rejected.  If a Notice is sent via United States Postal Service or overnight courier service and that service has a labor strike or work stoppage or catastrophic event during the period that such Notice is in their possession then such Notice shall not be deemed received until actual delivery.  The addresses to which such Notices are to be sent are as follows:'),
    ]),
    para(1, [b('If to Owner:')]),
    ...cfg.ownerNoticeBlock.map(line => para(2, [t(line)], 'left')),
    para(1, [b('If to Vendor:')]),
    ...noticeLines(input.vendorAddress).map(line => para(2, [t(line)], 'left')),
    para(1, [t('Each party may from time to time change its address for receipt of Notices by sending a Notice to the other party specifying a new address.')]),

    para(0, [
      b('11. Assignability. '),
      t('This Agreement shall not be assigned, transferred, encumbered or otherwise alienated or disposed of, by operation of law or otherwise by Vendor.  This Agreement may be assigned by Owner.'),
    ]),
    para(0, [
      b('12. Binding Effect. '),
      t('The provisions of this Agreement shall be binding upon and inure to the benefit of the successors and permitted assigns of the parties.'),
    ]),
    para(0, [
      b('13. Modifications. '),
      t('There shall be no modification to this Agreement except pursuant to a written agreement executed by the parties hereto.'),
    ]),
    para(0, [
      b('14. Entire Agreement. '),
      t('This Agreement represents the entire and integrated agreement between the parties and supersedes all negotiations, arrangements, representations or agreements whether written or oral.  All previous agreements of the parties shall be null and void.'),
    ]),
    para(0, [
      b('15. Time. '),
      t('Time is of the essence under this Agreement.'),
    ]),
    para(0, [
      b('16. Disputes/Governing Law. '),
      t('In the event of any legal action brought by either party against the other (or an intended third-party beneficiary of this Agreement against a party) under this Agreement, the prevailing party shall be entitled to recover the reasonable fees and costs of its attorneys and court costs in such matter from the non-prevailing party.  This Agreement shall be governed by the laws of the state in which the Property is located, without regard to the choice of law rules under the laws of such state.  This Section 16 shall survive the expiration or earlier termination of this Agreement.'),
    ]),

    para(0, [
      b('17. OFAC Representations. '),
      t('Vendor advises Owner hereby that the purpose of this Section 17 is to provide to Owner information and assurances to enable Owner to comply with the law relating to Office of Foreign Assets Control of the U.S. Department of the Treasury (“OFAC”):'),
    ]),
    para(1, [t('(a)  Vendor represents, warrants and covenants to Owner, either that (i) Vendor is regulated by the SEC, FINRA, or the Federal Reserve (a “Regulated Entity”) or (ii) neither Vendor nor any person or entity that directly or indirectly (A) controls Vendor or (B) has an ownership interest in Vendor of twenty-five percent (25%) or more, appears on the list of Specially Designated Nationals and Blocked Persons (“OFAC List”) published by OFAC.  The term “controls” shall mean such party has the right or power to direct or cause the direction of the management and policies of the entity in question.')]),
    para(1, [t('(b)  If, in connection with this Agreement: there is one or more guarantors of Vendor’s obligations under this Agreement, then Vendor further represents, warrants and covenants either that (i) any such guarantor is a Regulated Entity or (ii) neither guarantor nor any person or entity that directly or indirectly (A) controls such guarantor or (B) has an ownership interest in such guarantor of twenty-five percent (25%) or more, appears on the OFAC List.')]),
    para(1, [t('(c)  Vendor covenants that during the Term to provide to Owner, within five (5) days of written request, written information or certifications reasonably requested by Owner including without limitation, organizational structural charts and organizational documents which Owner may deem to be necessary (“Vendor OFAC Information”) in order for Owner to confirm Vendor’s continuing compliance with the provisions of this Section 17. Vendor represents and warrants that the Vendor OFAC Information it has provided or to be provided to Owner in connection with the execution of this Agreement is true and complete.')]),

    para(0, [
      b('18. Liability of Owner. '),
      t('The liability of Owner under this Agreement shall be limited to Owner’s right, title and interest in the Property and any judgments rendered against Owner shall be satisfied solely out of the issues, avails, rents, profits or net proceeds of sale or refinancing of its right, title and interest in the Property which have been received by Owner subsequent to such judgment.  No personal judgment shall lie against Owner upon extinguishment of its right, title and interest in the Property and any judgment so rendered shall not give rise to any right of execution or levy against Owner’s assets other than the Property and the issues, avails, rents, profits or net proceeds from the sale or refinancing thereof.  The provisions hereof shall inure to the successors and assigns of Owner and Vendor.  The foregoing provisions are not designed to relieve Owner from the performance of any of Owner’s obligations under this Agreement, but only to limit the personal liability of Owner in case of recovery of a judgment against Owner.'),
    ]),

    para(0, [t('The parties have executed this Agreement as of the date first above written.')]),
  ]

  const signature: SignatureData = {
    ownerEntity: cfg.ownerEntity,
    vendorName: (input.vendorName || '').toUpperCase(),
    ownerChain: cfg.ownerSignatureChain,
    ownerName: input.ownerSignName,
    ownerTitle: input.ownerSignTitle,
    vendorSignName: input.vendorSignName,
    vendorSignTitle: input.vendorSignTitle,
  }

  const eb = cfg.exhibitB
  const exhibitB: Block[] = [
    { kind: 'title', runs: [b('EXHIBIT B')], align: 'center' },
    { kind: 'heading', runs: [b(`INSURANCE REQUIREMENTS FOR ${eb.centerName}`)], align: 'center' },
    para(0, [t('Prior to commencement of services, contractor shall provide a certificate of insurance evidencing the existence of the insurance coverages set forth below, with the following named as additional insureds under the policies set forth under items 2 and 3:')]),
    para(1, [t('(1)  '), t(eb.ownerLine)]),
    para(1, [t('(2)  '), t(eb.mgmtLine)]),
    para(1, [t('(3)  MetLife Real Estate Lending, LLC and its successors, assigns, affiliates, partners and participants, as mortgagee.')]),
    para(0, [t('The additional insured shall be named using an endorsement form at lease as broad as the most recent edition of Additional Insured-Owners, Lessors or Contractors Form B (CG2010). The certificate of insurance should identify the property location, disclose the nature of the work to be performed and evidence the following insurance coverages:')]),
    { kind: 'heading', runs: [b('COVERAGE')], align: 'center' },
    para(1, [t('1)  Worker’s Compensation and Employers Liability (covering all employees of the insured and any Subcontractors.  Such policy shall include a waiver of subrogation in favor of the Additional Insureds.)')]),
    para(1, [t('2)  Commercial Automobile Liability Policy (covering all owned, hired and non-owned vehicles, including the loading and unloading thereof, bodily injury and property damage.)')]),
    para(1, [t('3)  Commercial General Liability Policy (including Premises/Operations, Bodily Injury, Independent Contractors, Contractual Liability, Broad Form Property Damage, and Personal Injury coverages.)')]),
    { kind: 'heading', runs: [b('LIMITS')], align: 'center' },
    para(0, [t('Limit for Employer’s Liability - not less than $500,000 per each Accident or Illness; and Limit for Worker’s Compensation - Limits per Statutory Requirements - State of North Carolina')]),
    para(0, [t('$2,000,000 Aggregate and Combined Single Limit, Per Accident')]),
    para(0, [t('$2,000,000 Aggregate and Combined Single Limit, Per Occurrence')]),
    para(0, [t('The Additional Insureds shall be named on a primary, non-contributory basis. The insurance companies carrying such coverages must be licensed to do business in the state of North Carolina and should carry an A.M. Best’s rating of A:X or better from Best’s Key Rating Guide. The certificate should supply us with a thirty (30) day notice of non-renewal, cancellation or material change. Any deductible under the Tenant’s liability insurance policy shall not exceed $10,000.00.')]),
    { kind: 'heading', runs: [b('Certificate Holder:')], align: 'left' },
    ...eb.certificateHolder.map(line => para(0, [t(line)], 'left')),
  ]

  const slug = (s: string) => s.replace(/[^\w]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  const baseFilename = `Service-Agreement-${cfg.key}-${slug(input.vendorName || 'Vendor') || 'Vendor'}`

  return { agreement, signature, exhibitB, baseFilename }
}

// Section 10 vendor notice: keep the 4 underscore lines when nothing is typed,
// so the printed form still has a fill-in space (matches the blank template).
function noticeLines(addr: string[]): string[] {
  const filled = (addr ?? []).map(s => (s ?? '').trim())
  const any = filled.some(Boolean)
  if (!any) return ['____________________________________', '____________________________________', '____________________________________', '____________________________________']
  return filled.slice(0, 4).map(s => s || ' ')
}
