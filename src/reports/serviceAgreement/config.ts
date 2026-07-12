// Service-agreement generator — property configuration.
//
// The M&J Wilkow standard Service Agreement is identical boilerplate across
// properties; only a handful of party identifiers change. This file captures
// those per-property values VERBATIM from the approved Word templates so the
// generator never re-types legal text differently than the source.
//
// Sources (K:\RETAIL\PROPERTY INFORMATION\Knightdale Marketplace):
//   Service Agreements\Service Agreement Templates\SERVICE.AGR FORM KM{E,W} ...docx
//   Insurance\BBK Midway Plantation (KM East) - Additional Insured.docx     (Exhibit B, East)
//   Insurance\BBK Midtown Commons (KM West) - Additional Insured.docx       (Exhibit B, West)
//
// NOTE (flagged to the user 2026-07-12): the KM EAST agreement BODY names the
// management agent as "Series RRR" (Sections 5c/6a of the East template), but
// the East insurance Exhibit B names it "Series SSS". Both are reproduced
// exactly as they appear in the source documents — reconcile the master
// template if that discrepancy is an error.

export type PropertyKey = 'KME' | 'KMW'

export interface ExhibitBConfig {
  centerName: string      // e.g. "BBK MIDWAY PLANTATION SHOPPING CENTER"
  ownerLine: string       // additional-insured line (1)
  mgmtLine: string        // additional-insured line (2)
  certificateHolder: string[]  // certificate-holder address block
}

export interface PropertyConfig {
  key: PropertyKey
  /** fka / former name used to match the row in the `properties` table. */
  propertiesFka: string
  label: string            // short UI label
  ownerEntity: string      // e.g. "BBK MIDWAY PLANTATION LLC"
  dba: string              // e.g. "Knightdale Marketplace East"
  propertyName: string     // e.g. "Midway Plantation Shopping Center"
  cityState: string        // e.g. "Knightdale, North Carolina"
  state: string            // e.g. "North Carolina"
  /** Management agent as it reads in the agreement body (Sections 5c/6a). */
  managementAgentBody: string
  mortgagee: string
  /** Owner's notice address block (Section 10). Fixed for all M&J deals. */
  ownerNoticeBlock: string[]
  /** Owner signature manager chain (above the By:/Name:/Title: lines). */
  ownerSignatureChain: string[]
  exhibitB: ExhibitBConfig
}

const OWNER_NOTICE_BLOCK = [
  'c/o M & J Wilkow Properties, LLC',
  '20 South Clark Street',
  'Suite 3000',
  'Chicago, Illinois 60603',
  'Attn: Marc R. Wilkow, President',
]

const OWNER_SIGNATURE_CHAIN = [
  'By: BBK Knightdale, LLC, its manager',
  'By: M & J Knightdale Investors LLC, its manager',
  'By: M & J Knightdale Manager Inc., its manager',
]

export const PROPERTY_CONFIGS: Record<PropertyKey, PropertyConfig> = {
  KME: {
    key: 'KME',
    propertiesFka: 'Midway Plantation',
    label: 'Knightdale Marketplace East (Midway Plantation)',
    ownerEntity: 'BBK MIDWAY PLANTATION LLC',
    dba: 'Knightdale Marketplace East',
    propertyName: 'Midway Plantation Shopping Center',
    cityState: 'Knightdale, North Carolina',
    state: 'North Carolina',
    managementAgentBody: 'M & J Wilkow Properties, LLC, Series RRR',
    mortgagee: 'MetLife Real Estate Lending, LLC',
    ownerNoticeBlock: OWNER_NOTICE_BLOCK,
    ownerSignatureChain: OWNER_SIGNATURE_CHAIN,
    exhibitB: {
      centerName: 'BBK MIDWAY PLANTATION SHOPPING CENTER',
      ownerLine: 'BBK Midway Plantation LLC d/b/a Knightdale Marketplace East, as owner;',
      mgmtLine: 'M & J Wilkow Properties, LLC, Series SSS, as management agent; and,',
      certificateHolder: [
        'BBK Midway Plantation, LLC.',
        'c/o M&J Wilkow Properties, LLC.',
        '20 South Clark Street #3000',
        'Chicago IL 60603',
      ],
    },
  },
  KMW: {
    key: 'KMW',
    propertiesFka: 'Midtown Commons',
    label: 'Knightdale Marketplace West (Midtown Commons)',
    ownerEntity: 'BBK MIDTOWN COMMONS LLC',
    dba: 'Knightdale Marketplace West',
    propertyName: 'Midtown Commons Shopping Center',
    cityState: 'Knightdale, North Carolina',
    state: 'North Carolina',
    managementAgentBody: 'M & J Wilkow Properties, LLC, Series RRR',
    mortgagee: 'MetLife Real Estate Lending, LLC',
    ownerNoticeBlock: OWNER_NOTICE_BLOCK,
    ownerSignatureChain: OWNER_SIGNATURE_CHAIN,
    exhibitB: {
      centerName: 'BBK MIDTOWN COMMONS SHOPPING CENTER',
      ownerLine: 'BBK Midtown Commons LLC d/b/a Knightdale Marketplace West, as owner;',
      mgmtLine: 'M & J Wilkow Properties, LLC, Series RRR, as management agent and,',
      certificateHolder: [
        'BBK Midtown Commons, LLC.',
        'c/o M&J Wilkow Properties, LLC.',
        '20 South Clark Street #3000',
        'Chicago IL 60603',
      ],
    },
  },
}

export type TermType = 'continuing' | 'single'

export interface AgreementInput {
  property: PropertyKey
  // "made this ___ day of ___, ___"
  day: string            // e.g. "22nd"
  month: string          // e.g. "May"
  year: string           // e.g. "2024"
  vendorName: string     // legal vendor name, as in the recital + Vendor signature
  vendorBusiness: string // "in the business of ___ contracted services"
  termType: TermType
  // continuing: start = commence, end = expire; single: start = commence, end = complete-by
  startDate: string
  endDate: string
  vendorAddress: string[]   // Section 10 notice block (up to 4 lines)
  ownerSignName: string
  ownerSignTitle: string
  vendorSignName: string
  vendorSignTitle: string
  vendorEmail: string       // for the "email for signature" step
}

const slug = (s: string) => s.replace(/[^\w]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
const orBlank = (s: string, fallback = '____') => (s.trim() ? s.trim() : fallback)

/**
 * Lightweight preview strings + suggested filename for the builder UI — pure,
 * no heavy deps, so the main bundle needn't pull in the full clause text (that
 * lives in content.ts, imported only by the dynamically-loaded renderers).
 * The renderers derive the same values from content.ts independently.
 */
export function buildContentBase(input: AgreementInput): { baseFilename: string; recitalPreview: string; termPreview: string } {
  const cfg = PROPERTY_CONFIGS[input.property]
  const recitalPreview =
    `This Service Agreement is made this ${orBlank(input.day)} day of ${orBlank(input.month, '____________')}, ${orBlank(input.year, '20____')}, ` +
    `by and between ${orBlank(input.vendorName, '____________________')} (the “Vendor”) and ${cfg.ownerEntity}, ` +
    `a Delaware limited liability company, d/b/a ${cfg.dba} (the “Owner”).`
  const start = orBlank(input.startDate, '____________________')
  const end = orBlank(input.endDate, '____________________')
  const termPreview = input.termType === 'continuing'
    ? `Continuing services (§3(a)) — commences ${start}, expires ${end}.`
    : `Single event (§3(b)) — anticipated start ${start}, completed on or before ${end}.`
  const baseFilename = `Service-Agreement-${cfg.key}-${slug(input.vendorName || 'Vendor') || 'Vendor'}`
  return { baseFilename, recitalPreview, termPreview }
}

export function blankInput(property: PropertyKey): AgreementInput {
  return {
    property,
    day: '', month: '', year: '',
    vendorName: '', vendorBusiness: '',
    termType: 'continuing',
    startDate: '', endDate: '',
    vendorAddress: ['', '', '', ''],
    ownerSignName: '', ownerSignTitle: '',
    vendorSignName: '', vendorSignTitle: '',
    vendorEmail: '',
  }
}
