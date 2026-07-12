// Inspection scorecard templates — transcribed verbatim from the 2026 firm
// workbooks (K:\...\POLICY MANUAL\16.0 Property Operations\16.3 Property
// Inspections). The blank-numbered rows in the office workbook are intentionally
// omitted here, so office item numbers are non-contiguous by design.
//
// Scoring (from the form's instructions): each line item gets an optional Y/N,
// a score of 1-5, and a detail note. The overall score is the average of scored
// items with N/A items removed. Anything scored 1, 2 or 5 must have a note.
//
// Keep this the single source of truth for both the /inspections composer and
// the generated PDF report. If the firm revises a form, bump FORM_VERSION and
// re-transcribe here (and republish the blank workbook via load_form_templates).

export const FORM_VERSION = '2026'

export type FormKind = 'retail' | 'office'

export interface TemplateItem {
  n: number
  label: string
}

export interface TemplateSection {
  title: string
  items: TemplateItem[]
}

export interface InspectionTemplate {
  kind: FormKind
  title: string
  version: string
  sections: TemplateSection[]
}

export const SCORE_LEGEND: { score: number; label: string }[] = [
  { score: 1, label: 'Poor conditions, does not meet standards' },
  { score: 2, label: 'Needs some improvement' },
  { score: 3, label: 'Meets expectations' },
  { score: 4, label: 'Exceeds expectations, generally in great condition' },
  { score: 5, label: 'Greatly exceeds expectations, perfect' },
]

export const INSTRUCTIONS =
  'Property inspections should be performed during all property site visits, with a goal of ' +
  '1x/quarter inspection. Each line item should receive a yes/no if applicable, as well as a ' +
  'score of 1-5. The overall score is the average of each scored item, with any N/A items removed. ' +
  'Anything receiving a 1, 2 or 5 should have notes in the detail section.'

const RETAIL: InspectionTemplate = {
  kind: 'retail',
  title: 'Retail Property Inspection Report',
  version: FORM_VERSION,
  sections: [
    {
      title: 'Signage',
      items: [
        { n: 1, label: 'Pylon Sign: Is sign fully functioning? Are there lights out? Are all tenant names current?' },
        { n: 2, label: 'Monument Signs: Are signs fully functioning? Are there lights out? Are all tenant names current?' },
        { n: 3, label: 'Tenant signage: Is tenant signage lit? Are storefronts compliant with storefront criteria protocol? Please note any signs that need repair in the detail column and provide photos.' },
        { n: 4, label: 'Directional Signs: Are signs fully functioning? Are there lights out? Are all tenant names current?' },
        { n: 5, label: 'Flags and Banners: Are flags and banners clean, free of tears?' },
        { n: 6, label: 'On-site marketing signage: Are signholders clean? Is signage current? Are there no empty holders?' },
        { n: 7, label: 'Handicap signs, stop signs and other traffic signs on property are vertical and in good condition.' },
        { n: 8, label: 'Directories are current and updated to reflect tenant roster.' },
      ],
    },
    {
      title: 'Parking Lots / Sidewalks',
      items: [
        { n: 9, label: 'Overall parking lot condition' },
        { n: 10, label: 'Parking lot is free of trash/debris' },
        { n: 11, label: 'Parking lot striping condition — Is lot in need of striping? What is the condition of curb lines and stop bars?' },
        { n: 12, label: 'Overall sidewalk condition' },
        { n: 13, label: 'Sidewalk is free of broken curbs.' },
        { n: 14, label: 'Sidewalk is free of weeds growing in cracks and joints, gum, cigarette butts, trash and other debris' },
        { n: 15, label: 'Sidewalk heaving/cracking' },
        { n: 16, label: 'Storm drains are free of debris. No sinkholes are present.' },
      ],
    },
    {
      title: 'Storefronts / Façade',
      items: [
        { n: 17, label: 'Building façade is clean and free of cracks/stains' },
        { n: 18, label: 'Building fascia is painted/skimcoated.' },
        { n: 19, label: 'Tenant storefronts are clean with no handwritten signage.' },
        { n: 20, label: 'Tenants do not have signage on sidewalks (except during special promotions/sidewalk sales)' },
        { n: 21, label: 'Sign bands are clean and do not have any traces of former tenant signage.' },
        { n: 22, label: 'Vacant storefronts are masked or have marketing signage.' },
      ],
    },
    {
      title: 'Landscaping',
      items: [
        { n: 23, label: 'Landscaping is in good condition.' },
        { n: 24, label: 'Planters are filled and provide color spots.' },
        { n: 25, label: 'Irrigation is fully functioning. If irrigation heads need replacement, please note in detail.' },
        { n: 26, label: 'Shrubs and trees pruned and healthy. No dead flowers, bushes or trees are present.' },
        { n: 27, label: 'Lawn appears well groomed and free of weeds.' },
        { n: 28, label: 'Monument/Pylon signs have landscaping surrounding them.' },
      ],
    },
    {
      title: 'Lighting',
      items: [
        { n: 29, label: 'Parking lot lights are fully illuminated. Please note any parking lot lights that need replacement in the detail column and provide photos.' },
        { n: 30, label: 'Wall and walkway lighting fully illuminated. Please note any lights needing replacement in the detail column and provide photos.' },
        { n: 31, label: 'Light timers are working and aligned with sunrise/sunset times.' },
      ],
    },
    {
      title: 'Common Areas',
      items: [
        { n: 32, label: 'Public restrooms are clean with all equipment fully functioning. Paper and soap dispensers are stocked. Floor and counters are free of water. Restroom log is in place and signed off on regularly.' },
        { n: 33, label: 'Trash receptacles are clean and painted. Trash is not overflowing and trash enclosures are in good repair and closed.' },
        { n: 34, label: 'Elevator working, clean and has current inspection report on file.' },
        { n: 35, label: 'Benches and customer trash/ash containers are in good repair.' },
        { n: 36, label: 'Pest control contract is current with recent inspection on file' },
        { n: 37, label: 'Janitorial, Maintenance and Security are in clean uniforms with shirts tucked in. Employees are visible on property during visit.' },
        { n: 38, label: 'Flooring and tile is clean and in good condition.' },
        { n: 39, label: 'Maintenance and/or Security vehicles are clean on the interior and exterior and have records of routine maintenance.' },
      ],
    },
    {
      title: 'Leasing',
      items: [
        { n: 40, label: 'Leasing signs are in vacant windows.' },
        { n: 41, label: 'Vacant spaces are show ready, clean with working lighting.' },
        { n: 42, label: 'Management is in possession of keys to vacant spaces.' },
        { n: 43, label: 'HVAC units are working. AC and heat are set to minimums to preserve energy.' },
      ],
    },
    {
      title: 'Back of House',
      items: [
        { n: 44, label: 'Asphalt is free of potholes.' },
        { n: 45, label: 'Trash compactors and open top containers are contained and not surrounded by debris' },
        { n: 46, label: 'Heat is working in all sprinkler rooms.' },
        { n: 47, label: 'All utility rooms are locked and all locks are in working order.' },
        { n: 48, label: 'Doors are in good condition, free of obstructions' },
        { n: 49, label: 'Buildings are free of graffiti.' },
        { n: 50, label: 'Sprinkler valve not chained/locked open.' },
      ],
    },
    {
      title: 'Office / Paperwork / Safety Audit',
      items: [
        { n: 51, label: 'Review of aging report shows all balances over 90 days are being addressed.' },
        { n: 52, label: 'All HR files are in locked cabinet.' },
        { n: 53, label: 'Is emergency procedures manual current and available in hard copy form in the management office?' },
        { n: 54, label: 'Review of insurance tracking. Insurance issues have been cured or are in the process of being cured since the last month’s report.' },
        { n: 55, label: 'Roof inspection log is current and details outcome of roof leak issues.' },
        { n: 56, label: 'OSHA Compliance: Is MSDS binder up to date and easily accessible in the maintenance shop? Are flammable liquids in a locked cabinet? Is the first aid kit accessible? Is Employee poster visible?' },
        { n: 57, label: 'Are fire sprinkler tests current and on file in accordance with fire code compliance? (Including backflow, alarm and sprinkler tests as required)' },
        { n: 58, label: 'CapEx projects are on track and properly documented. M&J Wilkow fees have been billed for completed work.' },
      ],
    },
  ],
}

const OFFICE: InspectionTemplate = {
  kind: 'office',
  title: 'Office Property Inspection Report',
  version: FORM_VERSION,
  sections: [
    {
      title: 'Signage',
      items: [
        { n: 1, label: 'Lobby Sign: Are there lights out?' },
        { n: 2, label: 'Monument Signs: Are signs fully functioning? Are there lights out? Are all tenant names current?' },
        { n: 3, label: 'Tenant signage: Are office fronts compliant with building standard protocol? Please note any signs that need repair in the detail column and provide photos.' },
        { n: 4, label: 'Directional Signs: Are all tenant names current?' },
        { n: 5, label: 'Exterior Signage: Are there lights out?' },
        { n: 6, label: 'On-site marketing signage: Are signholders clean? Is signage current? Are there no empty holders?' },
        { n: 7, label: 'Handicap signs, stop signs and other traffic signs on property are vertical and in good condition.' },
        { n: 8, label: 'Directories are current and updated to reflect tenant roster.' },
      ],
    },
    {
      title: 'Parking Garage / Sidewalks',
      items: [
        { n: 9, label: 'Overall parking garage condition — Are there identifiable water leaks, potholes, etc.' },
        { n: 10, label: 'Parking garage is free of trash/debris' },
        { n: 11, label: 'Parking garage striping condition — Is garage in need of striping?' },
        { n: 12, label: 'Overall sidewalk condition' },
        { n: 13, label: 'Sidewalk is free of broken curbs.' },
        { n: 14, label: 'Sidewalk is free of weeds growing in cracks and joints, gum, cigarette butts, trash and other debris' },
        { n: 15, label: 'Sidewalk heaving/cracking' },
      ],
    },
    {
      title: 'Exterior / Façade',
      items: [
        { n: 17, label: 'Building façade at ground level is clean and free of cracks/stains/graffiti' },
        { n: 18, label: 'Plaza is free of debris and furniture is in good condition' },
        { n: 19, label: 'Windows are free of cracks' },
        { n: 20, label: 'Tenants do not have signage on sidewalks/plazas (except during special promotions)' },
      ],
    },
    {
      title: 'Landscaping',
      items: [
        { n: 23, label: 'Landscaping is in good condition.' },
        { n: 24, label: 'Planters are filled and provide color spots.' },
        { n: 25, label: 'Irrigation is fully functioning. If irrigation heads need replacement, please note in detail.' },
        { n: 26, label: 'Shrubs and trees pruned and healthy. No dead flowers, bushes or trees are present.' },
        { n: 27, label: 'Lawn appears well groomed and free of weeds.' },
        { n: 28, label: 'Monument/Pylon signs have landscaping surrounding them.' },
      ],
    },
    {
      title: 'Lighting',
      items: [
        { n: 29, label: 'Parking garage lights are fully illuminated. Please note any parking garage lights that need replacement in the detail column and provide photos.' },
        { n: 30, label: 'Corridor and stairwell lighting fully illuminated. Please note any lights needing replacement in the detail column and provide photos.' },
        { n: 31, label: 'Light timers are working and aligned with sunrise/sunset times.' },
      ],
    },
    {
      title: 'Common Areas',
      items: [
        { n: 32, label: 'Public restrooms are clean with all equipment fully functioning. Paper and soap dispensers are stocked. Floor and counters are free of water.' },
        { n: 33, label: 'Trash receptacles are clean and in good condition. Trash is not overflowing and trash enclosures are in good repair and closed.' },
        { n: 34, label: 'Elevator working, clean and has current inspection report on file.' },
        { n: 35, label: 'Benches and customer trash containers are in good condition.' },
        { n: 36, label: 'Pest control contract is current with recent inspection on file' },
        { n: 37, label: 'Janitorial, Maintenance and Security are in clean uniforms. Employees are visible on property during visit.' },
        { n: 38, label: 'Flooring and tile is clean and in good condition.' },
        { n: 39, label: 'Building shuttle is clean on the interior and exterior and have records of routine maintenance.' },
      ],
    },
    {
      title: 'Leasing',
      items: [
        { n: 41, label: 'Vacant spaces are show ready, clean with working lighting.' },
        { n: 42, label: 'Management is in possession of keys to vacant spaces.' },
        { n: 43, label: 'HVAC units are working. AC and heat are set to minimums to preserve energy.' },
      ],
    },
    {
      title: 'Back of House',
      items: [
        { n: 46, label: 'Heat is working in fire pump room.' },
        { n: 47, label: 'All utility rooms are locked and all locks are in working order.' },
        { n: 48, label: 'Doors are in good condition, free of obstructions' },
        { n: 49, label: 'Records of routine maintenance on dry pipe system' },
        { n: 50, label: 'Sprinkler valve not chained/locked open.' },
      ],
    },
    {
      title: 'Office / Paperwork / Safety Audit',
      items: [
        { n: 51, label: 'Review of aging report shows all balances over 90 days are being addressed.' },
        { n: 53, label: 'Is emergency procedures manual current and available in hard copy form in the management office?' },
        { n: 54, label: 'Review of tenant insurance tracking. Insurance issues have been cured or are in the process of being cured since the last month’s report.' },
        { n: 55, label: 'Review of contract audit form. Routine service contracts and vendor COIs are current' },
        { n: 56, label: 'OSHA Compliance: Is MSDS binder up to date and easily accessible in the maintenance shop? Are flammable liquids in a locked cabinet? Is the first aid kit accessible? Is Employee poster visible?' },
        { n: 57, label: 'Are fire sprinkler tests current and on file in accordance with fire code compliance? (Including backflow, alarm and sprinkler tests as required)' },
        { n: 58, label: 'CapEx projects are on track and properly documented. M&J Wilkow fees have been billed for completed work.' },
      ],
    },
  ],
}

export const TEMPLATES: Record<FormKind, InspectionTemplate> = { retail: RETAIL, office: OFFICE }

export function templateFor(kind: FormKind): InspectionTemplate {
  return TEMPLATES[kind]
}

export function totalItems(kind: FormKind): number {
  return TEMPLATES[kind].sections.reduce((n, s) => n + s.items.length, 0)
}
