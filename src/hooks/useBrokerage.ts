import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'

// Leasing-brokerage engagements (brokerage_agreements, migration 20240038)
// abstracted from the OPERATIONS\Brokerage & Leasing Agreements folders by
// scripts/extract_brokerage_agreements.ps1. One row per source document; the
// /brokerage panel groups rows into engagements (property x broker x tenant):
// the latest primary document governs, ancillary docs (indemnities,
// declarations, letters) and the paper trail fold underneath.

export type BrokerageLifecycle = 'expired' | 'expiring' | 'active' | 'evergreen' | 'terminated' | 'unknown'

export type AgreementType =
  | 'exclusive_leasing' | 'cooperating_broker' | 'commission' | 'amendment'
  | 'extension' | 'termination' | 'indemnity' | 'declaration' | 'letter' | 'other'

export interface BrokerageDoc {
  id: string
  propertyId: string
  propertyName: string
  broker: string
  agreementType: AgreementType
  tenant: string | null
  description: string | null
  agreementDate: string | null
  startDate: string | null
  endDate: string | null
  termSummary: string | null
  commissionSummary: string | null
  autoRenews: boolean | null
  cancelNoticeDays: number | null
  amends: string | null
  status: string
  notes: string | null
  docId: string | null
  docTitle: string | null
  filePath: string | null
}

export const BROKERAGE_EXPIRING_DAYS = 90

// Primary documents can govern an engagement; ancillary ones only ride along.
const PRIMARY: AgreementType[] = ['exclusive_leasing', 'cooperating_broker', 'commission', 'amendment', 'extension', 'other']

export const TYPE_LABEL: Record<AgreementType, string> = {
  exclusive_leasing:  'Exclusive Leasing',
  cooperating_broker: 'Cooperating Broker',
  commission:         'Commission Agreement',
  amendment:          'Amendment',
  extension:          'Extension',
  termination:        'Termination',
  indemnity:          'Indemnity',
  declaration:        'Licensing Declaration',
  letter:             'Letter',
  other:              'Agreement',
}

/** One broker relationship at one property (per tenant for tenant-specific deals). */
export interface Engagement {
  key: string
  propertyId: string
  propertyName: string
  broker: string
  tenant: string | null
  engagementLabel: string
  /** 'exclusive' = property-wide leasing appointment (the primary engagements);
   *  'commission' = tenant-specific commission agreement / deal letter. */
  category: EngagementCategory
  governing: BrokerageDoc
  lifecycle: BrokerageLifecycle
  /** end date the engagement actually ran to (latest across primaries) */
  endDate: string | null
  /** date the engagement sorts by (governing doc's date), for newest-first */
  sortDate: string
  /** full paper trail, newest first, excluding the governing doc */
  trail: BrokerageDoc[]
  terminated: BrokerageDoc | null
}

export type EngagementCategory = 'exclusive' | 'commission'

const docSortKey = (d: BrokerageDoc) => d.agreementDate ?? d.startDate ?? d.endDate ?? ''

// Tie-break when documents share a date: the substantive engagement document
// outranks side agreements (a same-day cooperation agreement must not steal
// the card from the exclusive it rides on).
const TYPE_RANK: Record<AgreementType, number> = {
  exclusive_leasing: 0, commission: 1, cooperating_broker: 2, amendment: 3,
  extension: 4, other: 5, termination: 6, indemnity: 7, declaration: 8, letter: 9,
}

export function buildEngagements(docs: BrokerageDoc[], todayIso: string, horizonIso: string): Engagement[] {
  // broker key: lowercased alphanumerics; fold longer keys onto a shorter
  // prefix within the same property+tenant partition ("CBRE Raleigh" -> "CBRE",
  // "CBRE, Inc." -> "CBRE") so one firm's paper stays in one engagement.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(incorporated|inc|llc|lp)$/, '')
  const partitions = new Map<string, Set<string>>()
  for (const d of docs) {
    const part = `${d.propertyId}|${(d.tenant ?? '').toLowerCase()}`
    const set = partitions.get(part) ?? new Set<string>()
    set.add(norm(d.broker))
    partitions.set(part, set)
  }
  const brokerKey = (d: BrokerageDoc) => {
    const part = `${d.propertyId}|${(d.tenant ?? '').toLowerCase()}`
    const me = norm(d.broker)
    let best = me
    for (const other of partitions.get(part) ?? []) {
      if (other.length < best.length && me.startsWith(other)) best = other
    }
    return best
  }

  const groups = new Map<string, BrokerageDoc[]>()
  for (const d of docs) {
    const key = `${d.propertyId}|${(d.tenant ?? '').toLowerCase()}|${brokerKey(d)}`
    const list = groups.get(key) ?? []
    list.push(d)
    groups.set(key, list)
  }

  const out: Engagement[] = []
  for (const [key, list] of groups) {
    const newestFirst = [...list].sort((a, b) =>
      docSortKey(b).localeCompare(docSortKey(a)) || TYPE_RANK[a.agreementType] - TYPE_RANK[b.agreementType])
    const primaries = newestFirst.filter(d => PRIMARY.includes(d.agreementType))
    const termination = newestFirst.find(d => d.agreementType === 'termination' || d.status === 'terminated') ?? null
    // A manual status='active' override (set by the loader for brokers ownership
    // has confirmed are the current leasing agents) wins over the date logic —
    // these engagements continue on holdover past their last filed term.
    const manualActive = list.some(d => d.status === 'active')

    // the governing doc: latest primary (amendments carry the new expiration);
    // groups that are ancillary-only (rare) fall back to the newest doc.
    const governing = primaries[0] ?? newestFirst[0]
    const endDate = primaries.reduce<string | null>(
      (acc, d) => (d.endDate && (!acc || d.endDate > acc) ? d.endDate : acc), null)

    let lifecycle: BrokerageLifecycle
    if (manualActive) lifecycle = 'active'
    else if (termination) lifecycle = 'terminated'
    else if (endDate) lifecycle = endDate < todayIso ? 'expired' : endDate <= horizonIso ? 'expiring' : 'active'
    else if (governing.autoRenews) lifecycle = 'evergreen'
    else lifecycle = 'unknown'

    // label from the engagement's root document (oldest primary; substantive
    // type wins a same-day tie)
    const root = [...primaries].sort((a, b) =>
      docSortKey(a).localeCompare(docSortKey(b)) || TYPE_RANK[a.agreementType] - TYPE_RANK[b.agreementType])[0] ?? governing
    const engagementLabel = TYPE_LABEL[root.agreementType] ?? 'Agreement'

    // Category: a property-wide exclusive/cooperating leasing appointment is an
    // "exclusive" (the primary engagements); anything tenant-specific or rooted
    // in a commission agreement is a "commission".
    const rootType = root.agreementType
    const category: EngagementCategory =
      !governing.tenant && (rootType === 'exclusive_leasing' || rootType === 'cooperating_broker')
        ? 'exclusive' : 'commission'

    out.push({
      key,
      propertyId: governing.propertyId,
      propertyName: governing.propertyName,
      broker: root.broker,
      tenant: governing.tenant,
      engagementLabel,
      category,
      governing,
      lifecycle,
      endDate,
      sortDate: docSortKey(governing),
      trail: newestFirst.filter(d => d.id !== governing.id),
      terminated: termination,
    })
  }
  return out
}

export function useBrokerage(propertyIds: string[], propertyNames: Record<string, string>) {
  return useQuery<BrokerageDoc[]>(async () => {
    if (!propertyIds.length) return []

    const { data, error } = await supabase
      .from('brokerage_agreements')
      .select('id, property_id, broker, agreement_type, tenant, description, agreement_date, start_date, end_date, term_summary, commission_summary, auto_renews, cancel_notice_days, amends, status, notes, document_id, file_path, documents(title, file_path)')
      .in('property_id', propertyIds)
      .order('agreement_date', { ascending: false })
    if (error) throw new Error(error.message)

    return ((data ?? []) as any[]).map(r => ({
      id:                r.id,
      propertyId:        r.property_id,
      propertyName:      propertyNames[r.property_id] ?? '—',
      broker:            r.broker,
      agreementType:     r.agreement_type,
      tenant:            r.tenant,
      description:       r.description,
      agreementDate:     r.agreement_date,
      startDate:         r.start_date,
      endDate:           r.end_date,
      termSummary:       r.term_summary,
      commissionSummary: r.commission_summary,
      autoRenews:        r.auto_renews,
      cancelNoticeDays:  r.cancel_notice_days,
      amends:            r.amends,
      status:            r.status,
      notes:             r.notes,
      docId:             r.document_id,
      docTitle:          r.documents?.title ?? null,
      filePath:          r.file_path ?? r.documents?.file_path ?? null,
    }))
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}
