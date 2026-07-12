// helpContent.ts — content for the in-app Help & Resources drawer.
//
// This is a DEVELOPER-MAINTAINED content module (bundled with the app; changes
// ship on the next deploy). It's the condensed, in-context layer of the M&J
// Wilkow Property Management wiki — the full library lives in wiki-portal/.
//
// To add an article: add a HelpArticle to HELP_ARTICLES with a `section` that
// matches a HELP_SECTIONS key, and write its `body` as an array of blocks.
// To surface it on a specific screen, add its id to PATH_SUGGESTIONS.

export type HelpBlock =
  | { t: 'h'; text: string }
  | { t: 'p'; text: string }
  | { t: 'steps'; items: string[] }
  | { t: 'list'; items: string[] }
  | { t: 'note'; text: string }
  // `key` is a storage object path in the `documents` bucket (signed at runtime).
  // `pdf` opens inline in a new tab; otherwise the file downloads. `file` sets
  // the download filename. A bare `href` still works for external links.
  | { t: 'docs'; items: { label: string; key?: string; pdf?: boolean; file?: string; href?: string }[] }
  | { t: 'contacts'; items: { role: string; name: string; detail: string }[] }

export interface HelpSection {
  key: string
  label: string
  desc: string
  /** simple stroke-path(s) for a 24x24 icon */
  icon: string
}

export interface HelpArticle {
  id: string
  section: string
  title: string
  /** space-separated keywords for search */
  tags: string
  updated?: string
  body: HelpBlock[]
}

// Shared OneDrive folder holding the M&J University session recordings/audio —
// too large for the document store, so recording/audio entries link here (the
// session sub-folders are preserved inside, so it's navigable). Swap this URL
// if the media ever moves to a SharePoint site.
export const MEDIA_FOLDER_URL = 'https://mjwilkow1-my.sharepoint.com/:f:/g/personal/pskontos_wilkow_com/IgDGK1osK_wJQrMst8GTpEJAASuIHqIkQsm3dnSKO_PsfKQ?e=rBpYyZ'

export const HELP_SECTIONS: HelpSection[] = [
  { key: 'how-do-i',  label: 'How do I…?',               desc: 'Task-based index',            icon: 'M9.1 9a3 3 0 1 1 4 2.8c-.9.4-1.6 1-1.6 2.2M12 17h.01' },
  { key: 'policy',    label: 'Policy Manual',            desc: '20 sections, latest versions', icon: 'M4 4h11l5 5v11H4z M14 4v6h6' },
  { key: 'ebix',      label: 'Insurance & COI (EBIX)',   desc: 'COI how-tos & deficiencies',  icon: 'M12 3l7 3v6c0 4-3 6.5-7 8-4-1.5-7-4-7-8V6z' },
  { key: 'emergency', label: 'Emergency & Life Safety',  desc: 'ERP & property manuals',      icon: 'M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z' },
  { key: 'forms',     label: 'Forms & Templates',        desc: 'Every current form',          icon: 'M9 2h6l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z' },
  { key: 'contacts',  label: 'Key Contacts',             desc: 'Who to call for what',        icon: 'M4 4h16v16H4z M8 9h8 M8 13h5' },
  { key: 'glossary',  label: 'Glossary',                 desc: 'Acronyms decoded',            icon: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z' },
]

export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: 'coi-upload', section: 'ebix', title: 'Upload a COI into EBIX',
    tags: 'coi insurance certificate upload tenant vendor number ebix', updated: 'Jan 2026',
    body: [
      { t: 'steps', items: [
        'Log into your EBIX account.',
        'Type the Vendor Number (the account number on the deficiency report), select it, and hit Advanced Search.',
        'In the tenant profile, click Add → Upload Document.',
        'Enter your email, attach the COI, and choose "Upload a Certificate that DOES require Customer Service Analyst attention".',
        'Click Upload. You will get a confirmation email — you are all set.',
      ] },
      { t: 'note', text: 'Questions? Nancy Jarka — njarka@wilkow.com' },
    ],
  },
  {
    id: 'coi-deficient', section: 'ebix', title: 'Handle EBIX deficiencies',
    tags: 'coi deficiency expired workers comp chase tenant email insurance', updated: 'Jan 2026',
    body: [
      { t: 'p', text: 'After running a deficiency report: input any missing tenant emails, email each deficient tenant (templates in the full wiki), escalate to their insurer if there is no response, then submit the corrected COI to mjwilkow@ebix.com.' },
      { t: 'note', text: 'Deficiency disputes are phone-only: M&J Wilkow line (951) 492-4818. EBIX will not respond by email.' },
    ],
  },
  {
    id: 'coi-onboard', section: 'ebix', title: 'Onboard a new tenant in EBIX',
    tags: 'new tenant move-in notification form lease abstract insurance setup',
    body: [
      { t: 'p', text: 'Complete the Tenant Notification Form and email it together with the Lease Abstract to mjwilkow@ebix.com.' },
      { t: 'docs', items: [ { label: 'Tenant Notification Form', key: 'forms/help/tenant-notification-form.xls', file: 'M & J Wilkow Tenant Notification Form.xls' } ] },
    ],
  },
  {
    id: 'expense', section: 'policy', title: '2.0 Expense Reporting',
    tags: 'expense certify travel mileage car rental reimbursement policy', updated: '2025-01-01',
    body: [
      { t: 'p', text: 'The Travel & Expense policy, Certify setup, mileage rates, and car-rental protocol.' },
      { t: 'docs', items: [
        { label: '2025 Travel & Expense Policy (FINAL)', key: 'forms/help/travel-expense-policy-2025.pdf', pdf: true },
        { label: 'Certify — Missing Receipt Form', key: 'forms/help/certify-missing-receipt.pdf', pdf: true },
      ] },
    ],
  },
  {
    id: 'construction', section: 'policy', title: '14.0 Construction Management',
    tags: 'construction signage plan review approval policy', updated: '2026-02-09',
    body: [
      { t: 'p', text: 'The signage and construction plan review policy and process.' },
      { t: 'docs', items: [ { label: 'Signage & Construction Plans Review Policy (2.9.26)', key: 'forms/help/construction-plan-review-2026.docx', file: 'Signage & Construction Plans Review Policy - 2.9.26.docx' } ] },
    ],
  },
  {
    id: 'filing', section: 'policy', title: '10.0 Electronic Filing (V-Drive)',
    tags: 'filing v drive documents electronic procedure naming', updated: '2026-05-27',
    body: [
      { t: 'p', text: 'How to name and file documents on the V: drive. Read this before saving anything to a shared folder.' },
      { t: 'docs', items: [ { label: 'V-Drive Filing Procedure (5.27.26)', key: 'forms/help/v-drive-filing-2026.docx', file: 'V Drive Filing Procedure 5.27.26.docx' } ] },
    ],
  },
  {
    id: 'inspection', section: 'forms', title: 'Property Inspection Report (2026)',
    tags: 'inspection form property operations scorecard retail office', updated: 'Jun 2026',
    body: [
      { t: 'docs', items: [
        { label: 'Retail Property Inspection Report (2026)', key: 'forms/inspection/retail-property-inspection-2026.pdf', pdf: true },
        { label: 'Office Property Inspection Report (2026)', key: 'forms/inspection/office-property-inspection-2026.pdf', pdf: true },
      ] },
    ],
  },
  {
    id: 'checkreq', section: 'forms', title: 'Check Request & Bookkeeping Forms',
    tags: 'check request accounting bookkeeping payment refund write off form', updated: 'Apr 2026',
    body: [
      { t: 'docs', items: [
        { label: 'Check Request Form (4.28.26)', key: 'forms/help/check-request-2026.doc', file: 'Check Request Form - 4.28.26.doc' },
        { label: 'Tenant Refund Request (4.28.26)', key: 'forms/help/tenant-refund-2026.xlsx', file: 'Tenant Refund Request - 04.28.26.xlsx' },
        { label: 'Balance Write-Off Request (4.28.26)', key: 'forms/help/balance-writeoff-2026.xlsx', file: 'Balance Write Off Request - 04.28.26.xlsx' },
      ] },
    ],
  },
  {
    id: 'incident', section: 'emergency', title: 'Incident Reporting',
    tags: 'incident report injury claim insurance emergency risk',
    body: [
      { t: 'p', text: 'Report incidents the same business day. Notify Patrick Doyle at Draper & Kramer and cc your Asset Manager, Portfolio Manager, and VP-Retail.' },
      { t: 'contacts', items: [ { role: 'Incidents / claims', name: 'Patrick Doyle', detail: 'DoyleP@DraperandKramer.com · (312) 580-6503' } ] },
      { t: 'note', text: 'Parker Ranch Center and East Gate Square report to their own insurers.' },
    ],
  },
  {
    id: 'crisis', section: 'emergency', title: 'Crisis Response Guide',
    tags: 'crisis emergency fire active shooter weather evacuation 911 life safety',
    body: [
      { t: 'p', text: 'Call 911 first. Then notify your Portfolio Manager and VP–Retail. Each property’s emergency manual has its assembly points and utility shutoffs.' },
      { t: 'contacts', items: [
        { role: 'VP – Retail PM', name: 'Darcy Kennelly Rutzen', detail: '773.213.0837 (24 hr)' },
        { role: 'General Counsel', name: 'David Eisen', detail: '312.279.5971' },
      ] },
    ],
  },
  {
    id: 'contacts', section: 'contacts', title: 'Key Contacts',
    tags: 'contacts phone escalation media insurance who to call directory',
    body: [
      { t: 'contacts', items: [
        { role: 'VP – Retail Property Management', name: 'Darcy Kennelly Rutzen', detail: '773.213.0837 (24 hr) · drutzen@wilkow.com' },
        { role: 'General Counsel', name: 'David Eisen', detail: '312.279.5971 · deisen@wilkow.com' },
        { role: 'EBIX / COI', name: 'Nancy Jarka', detail: 'njarka@wilkow.com' },
        { role: 'Insurance limits', name: 'Melinda Balver (EBIX)', detail: 'Melinda.Balver@ebix.com · (770) 238-1236' },
        { role: 'Incidents', name: 'Patrick Doyle', detail: '(312) 580-6503' },
      ] },
    ],
  },
  {
    id: 'glossary', section: 'glossary', title: 'Glossary — the terms you’ll hear',
    tags: 'glossary acronym coi cam snda estoppel walt noi vendor number definitions',
    body: [
      { t: 'list', items: [
        'COI — Certificate of Insurance.',
        'CAM — Common Area Maintenance (shared operating costs reconciled to tenants).',
        'Vendor Number — a tenant’s EBIX account ID (MJ00000000).',
        'SNDA — Subordination, Non-Disturbance & Attornment.',
        'Estoppel — tenant’s certification of lease status for a sale/refinance.',
        'WALT — Weighted Average Lease Term.',
      ] },
    ],
  },
  {
    id: 'howdoi', section: 'how-do-i', title: 'How do I…? (task index)',
    tags: 'how do i task expense coi hire inspection loi time off help',
    body: [
      { t: 'list', items: [
        'File an expense report → 2.0 Expense Reporting',
        'Chase a deficient COI → Handle EBIX Deficiencies',
        'Get construction plans approved → 14.0 Construction Management',
        'Run my property inspection → Property Inspection Report',
        'Report an incident → Incident Reporting',
        'File a document correctly → 10.0 Electronic Filing',
      ] },
    ],
  },
]

// Which articles to surface first, per app route. Longest matching prefix wins.
const PATH_SUGGESTIONS: { prefix: string; ids: string[] }[] = [
  { prefix: '/receivables', ids: ['coi-deficient', 'coi-upload', 'checkreq'] },
  { prefix: '/financials',  ids: ['expense', 'checkreq', 'glossary'] },
  { prefix: '/documents',   ids: ['filing', 'inspection', 'coi-onboard'] },
  { prefix: '/abstracts',   ids: ['filing', 'glossary'] },
  { prefix: '/waterfall',   ids: ['glossary', 'expense'] },
  { prefix: '/management',  ids: ['glossary', 'incident'] },
  { prefix: '/properties',  ids: ['inspection', 'incident', 'crisis'] },
  { prefix: '/tasks',       ids: ['howdoi', 'inspection'] },
]
const DEFAULT_SUGGESTIONS = ['howdoi', 'coi-upload', 'inspection']

const byId = new Map(HELP_ARTICLES.map(a => [a.id, a]))
const sectionByKey = new Map(HELP_SECTIONS.map(s => [s.key, s]))

export function getArticle(id: string): HelpArticle | undefined { return byId.get(id) }
export function getSection(key: string): HelpSection | undefined { return sectionByKey.get(key) }
export function articlesInSection(key: string): HelpArticle[] {
  return HELP_ARTICLES.filter(a => a.section === key)
}
export function searchArticles(q: string): HelpArticle[] {
  const t = q.trim().toLowerCase()
  if (!t) return []
  return HELP_ARTICLES.filter(a => {
    const label = sectionByKey.get(a.section)?.label ?? ''
    return (a.title + ' ' + a.tags + ' ' + label).toLowerCase().includes(t)
  })
}
export function suggestionsForPath(pathname: string): HelpArticle[] {
  let best: string[] | null = null
  let bestLen = -1
  for (const row of PATH_SUGGESTIONS) {
    if (pathname.startsWith(row.prefix) && row.prefix.length > bestLen) {
      best = row.ids; bestLen = row.prefix.length
    }
  }
  return (best ?? DEFAULT_SUGGESTIONS).map(id => byId.get(id)).filter((a): a is HelpArticle => !!a)
}
