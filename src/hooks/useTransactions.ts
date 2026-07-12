import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'

// Record of CLOSED transactions (transactions + children, migration 20240055).
// Design: docs/transactions-design.md. Principle: CURATE, don't retrieve — the
// linked doc set is explicit (transaction_documents), never a similarity guess.
//
// "Certainty on the materials" is delivered on three axes, all surfaced per doc:
//   authenticity  — fingerprint (file_size_bytes) vs what was linked; version drift
//   completeness  — source_manifest count vs ingested vs key (computed in the page)
//   accessibility — searchable (documents.is_indexed) vs viewable (storage object
//                   present + a signed URL). These genuinely differ here: the
//                   mirror runs ahead/behind and ~40% of docs are scanned.

export type TxnType = 'acquisition' | 'refinance' | 'recap' | 'disposition'
export type DebtEvent = 'assumed' | 'originated' | 'paid_off' | 'recapped' | null
export type VerificationStatus = 'unverified' | 'verified' | 'issues'
export type FigureBasis = 'preliminary' | 'final'

export interface TxnFigure {
  label: string
  value: number
  documentId: string | null
  pageNumber: number | null
  basis: FigureBasis
}

export interface TxnDoc {
  documentId: string
  role: string | null
  isKey: boolean
  sensitivity: 'normal' | 'restricted'
  linkedVersion: number | null
  title: string | null
  fileName: string | null
  filePath: string | null            // authoritative V:\ source path (provenance)
  storagePath: string | null
  signedUrl: string | null           // null => not viewable right now
  searchable: boolean                // documents.is_indexed
  viewable: boolean                  // storage object present + signed
  fingerprintDrift: boolean          // linked file_size_bytes no longer matches
  superseded: boolean                // a newer version exists (documents.superseded_by)
}

export interface Transaction {
  id: string
  type: TxnType
  debtEvent: DebtEvent
  closeDate: string
  counterparty: string | null
  loanId: string | null
  narrative: string | null
  verificationStatus: VerificationStatus
  verifiedAt: string | null
  sourceFolderPath: string | null
  sourceManifest: { files?: string[]; count?: number; scanned_at?: string } | null
  primaryPropertyId: string
  primaryPropertyName: string | null
  properties: { id: string; name: string; isPrimary: boolean }[]
  figures: TxnFigure[]
  docs: TxnDoc[]
}

export const TXN_TYPE_LABEL: Record<TxnType, string> = {
  acquisition: 'Acquisition',
  refinance:   'Refinance',
  recap:       'Recapitalization',
  disposition: 'Disposition',
}

export const DEBT_EVENT_LABEL: Record<string, string> = {
  assumed:    'loan assumed',
  originated: 'loan originated',
  paid_off:   'loan paid off',
  recapped:   'recapitalized',
}

export const FIGURE_LABEL: Record<string, string> = {
  contract_price:          'Contract price',
  gross_price:             'Gross price',
  net_cash_to_close:       'Net cash to close',
  net_proceeds:            'Net proceeds',
  total_basis:             'Total cost basis',
  assumed_loan_balance:    'Assumed loan balance',
  loan_amount:             'Loan amount',
  preferred_equity_amount: 'Preferred equity',
  payoff_amount:           'Payoff amount',
}

export const ROLE_LABEL: Record<string, string> = {
  settlement_statement:    'Settlement statement',
  closing_statement:       'Closing statement',
  psa:                     'Purchase & sale agreement',
  deed:                    'Deed',
  bill_of_sale:            'Bill of sale',
  ground_lease_assignment: 'Ground lease assignment',
  loan_agreement:          'Loan agreement',
  note:                    'Promissory note',
  mortgage:                'Mortgage / deed of trust',
  title_policy:            'Title policy',
  payoff_letter:           'Payoff letter',
  escrow_instructions:     'Escrow instructions',
  equity_agreement:        'Equity agreement',
  wire_instructions:       'Wire instructions',
}

export function figureLabel(k: string): string {
  return FIGURE_LABEL[k] ?? k.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())
}
export function roleLabel(k: string | null): string {
  if (!k) return 'Document'
  return ROLE_LABEL[k] ?? k.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())
}

const SELECT =
  'id, type, debt_event, close_date, counterparty, loan_id, narrative, ' +
  'verification_status, verified_at, source_folder_path, source_manifest, primary_property_id, ' +
  'primary_property:primary_property_id(id, name), ' +
  'transaction_properties(property_id, is_primary, properties(id, name)), ' +
  'transaction_figures(label, value, document_id, page_number, basis, sort_order), ' +
  'transaction_documents(document_id, role, is_key, sensitivity, linked_version, fingerprint, ' +
    'documents(id, title, file_name, file_path, storage_path, is_indexed, file_size_bytes, version, superseded_by))'

/** All transactions the user can see (RLS-scoped). Signs every linked doc once. */
export function useTransactions() {
  return useQuery<Transaction[]>(async () => {
    const { data, error } = await supabase
      .from('transactions')
      .select(SELECT)
      .is('superseded_by', null)            // show current, not restated, rows
      .order('close_date', { ascending: false })
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as any[]

    // Sign every linked storage object in one batch → drives the "viewable" badge.
    const paths = Array.from(new Set(
      rows.flatMap(r => (r.transaction_documents ?? []))
        .map((td: any) => td.documents?.storage_path)
        .filter((p: any): p is string => typeof p === 'string' && p.length > 0),
    ))
    const signed = new Map<string, string>()
    if (paths.length) {
      const { data: s } = await supabase.storage.from('documents').createSignedUrls(paths, 3600)
      for (const it of s ?? []) if (it.path && it.signedUrl) signed.set(it.path, it.signedUrl)
    }

    return rows.map(r => {
      const docs: TxnDoc[] = ((r.transaction_documents ?? []) as any[]).map(td => {
        const d = td.documents ?? {}
        const storagePath: string | null = d.storage_path ?? null
        const signedUrl = storagePath ? (signed.get(storagePath) ?? null) : null
        const linkedSize = td.fingerprint?.file_size_bytes ?? null
        return {
          documentId:       td.document_id,
          role:             td.role ?? null,
          isKey:            !!td.is_key,
          sensitivity:      td.sensitivity ?? 'normal',
          linkedVersion:    td.linked_version ?? null,
          title:            d.title ?? null,
          fileName:         d.file_name ?? null,
          filePath:         d.file_path ?? null,
          storagePath,
          signedUrl,
          searchable:       !!d.is_indexed,
          viewable:         !!signedUrl,
          fingerprintDrift: linkedSize != null && d.file_size_bytes != null && Number(linkedSize) !== Number(d.file_size_bytes),
          superseded:       d.superseded_by != null,
        }
      }).sort((a, b) => Number(b.isKey) - Number(a.isKey) || roleLabel(a.role).localeCompare(roleLabel(b.role)))

      const figures: TxnFigure[] = ((r.transaction_figures ?? []) as any[])
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map(f => ({
          label:      f.label,
          value:      Number(f.value),
          documentId: f.document_id ?? null,
          pageNumber: f.page_number ?? null,
          basis:      f.basis,
        }))

      const properties = ((r.transaction_properties ?? []) as any[]).map(tp => ({
        id:        tp.property_id,
        name:      tp.properties?.name ?? '—',
        isPrimary: !!tp.is_primary,
      }))

      return {
        id:                  r.id,
        type:                r.type,
        debtEvent:           r.debt_event ?? null,
        closeDate:           r.close_date,
        counterparty:        r.counterparty ?? null,
        loanId:              r.loan_id ?? null,
        narrative:           r.narrative ?? null,
        verificationStatus:  r.verification_status,
        verifiedAt:          r.verified_at ?? null,
        sourceFolderPath:    r.source_folder_path ?? null,
        sourceManifest:      r.source_manifest ?? null,
        primaryPropertyId:   r.primary_property_id,
        primaryPropertyName: r.primary_property?.name ?? null,
        properties,
        figures,
        docs,
      } as Transaction
    })
  }, [])
}

/** Doc-set completeness for one transaction (the third certainty axis). */
export function docCompleteness(t: Transaction) {
  const manifestCount = t.sourceManifest?.count ?? null
  const linked = t.docs.length
  const key = t.docs.filter(d => d.isKey).length
  const viewable = t.docs.filter(d => d.viewable).length
  return { manifestCount, linked, key, viewable }
}
