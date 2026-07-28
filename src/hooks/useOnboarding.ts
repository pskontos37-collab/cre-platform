import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { parseMriRentRoll, type Cell, type RentRollParse } from '../lib/rentRollParse'

// ── Property onboarding drafts (migration 20240132) ──────────────────────────
// Onboarding spans days, so the wizard's state is a row, not component state.
// Everything here is non-destructive: documents are registered with
// property_id NULL and the rent roll sits in the draft until
// complete_property_onboarding() creates the asset and adopts them.

export interface OnboardingIdentity {
  name?: string
  asset_type?: 'retail' | 'office' | 'mixed_use'
  portfolio_id?: string
  address?: string
  city?: string
  state?: string
  zip?: string
  total_sf?: string
  year_built?: string
  acquisition_date?: string
  acquisition_price?: string
  management_company?: string
  jv_partner?: string
  ownership_type?: string
}

export interface StagedRentRoll {
  period_year: number
  period_month: number
  source_file: string
  summary: RentRollParse['summary']
  rows: RentRollParse['rows']
  file_total_monthly?: number | null
  total_variance?: number | null
}

export interface OnboardingDraft {
  id: string
  status: 'draft' | 'complete' | 'abandoned'
  property_id: string | null
  working_name: string
  step: number
  identity: OnboardingIdentity
  route_keywords: string[]
  file_room_path: string | null
  doc_ids: string[]
  rr: StagedRentRoll | null
  notes: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface OnboardingDocRow {
  id: string
  title: string | null
  file_name: string | null
  doc_type: string
  doc_subtype: string | null
  file_size_bytes: number | null
}

/** The closing set a new asset needs on file. Advisory — none of it blocks go-live. */
export const REQUIRED_DOCS: { key: string; label: string; docType: string; hint: string }[] = [
  { key: 'pma',        label: 'Management agreement (PMA)', docType: 'other',          hint: 'Fee %, term, termination notice' },
  { key: 'loan',       label: 'Loan agreement / note',      docType: 'loan_agreement', hint: 'Drives DSCR and maturity events' },
  { key: 'jv',         label: 'JV / partnership agreement', docType: 'jv_agreement',   hint: 'Waterfall and promote structure' },
  { key: 'psa',        label: 'Purchase agreement (PSA)',   docType: 'psa',            hint: 'Basis and closing date' },
  { key: 'title',      label: 'Title / survey',             docType: 'title',          hint: 'Easements, REA references' },
  { key: 'appraisal',  label: 'Appraisal',                  docType: 'other',          hint: 'Current value' },
  { key: 'insurance',  label: 'Insurance program',          docType: 'other',          hint: 'COI tracking baseline' },
  { key: 'site_plan',  label: 'Site plan',                  docType: 'site_plan',      hint: 'Interactive site map' },
  { key: 'rea',        label: 'REA / declaration',          docType: 'other',          hint: 'If part of a larger center' },
]

export function useOnboardingDrafts() {
  const [data, setData] = useState<OnboardingDraft[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const { data: rows, error: e } = await supabase.from('property_onboarding')
        .select('*').order('updated_at', { ascending: false }).limit(50)
      if (e) throw new Error(e.message)
      setData((rows ?? []) as OnboardingDraft[])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refetch() }, [refetch])
  return { data, loading, error, refetch }
}

export async function createDraft(workingName: string): Promise<string> {
  const { data: auth } = await supabase.auth.getUser()
  const { data, error } = await supabase.from('property_onboarding').insert({
    working_name: workingName.trim() || 'Untitled property',
    identity: { name: workingName.trim() },
    created_by: auth?.user?.id ?? null,
  }).select('id').single()
  if (error || !data) throw new Error(error?.message ?? 'Could not create the draft')
  return data.id as string
}

export async function saveDraft(id: string, patch: Partial<OnboardingDraft>): Promise<void> {
  const { error } = await supabase.from('property_onboarding')
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteDraft(id: string): Promise<void> {
  const { error } = await supabase.from('property_onboarding').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

/** Documents staged against a draft (registered, property not yet assigned). */
export async function fetchDraftDocs(docIds: string[]): Promise<OnboardingDocRow[]> {
  if (!docIds.length) return []
  const { data, error } = await supabase.from('documents')
    .select('id, title, file_name, doc_type, doc_subtype, file_size_bytes')
    .in('id', docIds)
  if (error) throw new Error(error.message)
  return (data ?? []) as OnboardingDocRow[]
}

/**
 * Uploads a required document and registers it with property_id NULL — the
 * register's existing unassigned class. It adopts the property at go-live.
 */
export async function uploadOnboardingDoc(
  draftId: string, file: File, docType: string, subtype: string,
): Promise<string> {
  const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80)
  const uid = globalThis.crypto?.randomUUID?.() ?? String(Date.now())
  const path = `onboarding/${draftId}/${uid}-${safe}`
  const { error: upErr } = await supabase.storage.from('documents')
    .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false })
  if (upErr) throw new Error('Upload failed: ' + upErr.message)

  const { data: doc, error: dErr } = await supabase.from('documents').insert({
    title: file.name.replace(/\.[^.]+$/, ''),
    file_name: file.name,
    storage_path: path,
    doc_type: docType,
    doc_subtype: subtype,
    file_size_bytes: file.size,
    property_id: null,
    processing_status: 'pending',
    processing_note: `Filed by the onboarding wizard (draft ${draftId}); adopts its property at go-live.`,
  }).select('id').single()
  if (dErr || !doc) throw new Error('Registering the document failed: ' + (dErr?.message ?? ''))
  return doc.id as string
}

/** exceljs cell -> plain Cell (unwraps formula results, rich text, hyperlinks). */
function normCell(v: unknown): Cell {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('result' in o) return normCell(o.result)                        // formula
    if ('richText' in o && Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map(t => t.text ?? '').join('')
    }
    if ('text' in o) return String(o.text)                              // hyperlink
    return null
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  return null
}

/** Reads the first worksheet into a 1-based-column cell matrix. */
export async function readWorkbookMatrix(file: File): Promise<Cell[][]> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await file.arrayBuffer())
  const ws = wb.worksheets[0]
  if (!ws) throw new Error('That workbook has no worksheets.')
  const m: Cell[][] = []
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    // exceljs row.values is 1-based with an unused slot 0
    const vals = Array.isArray(row.values) ? (row.values as unknown[]) : []
    m[rowNumber - 1] = vals.slice(1).map(normCell)
  })
  for (let i = 0; i < m.length; i++) if (!m[i]) m[i] = []
  return m
}

/** Parse an MRI_CMROLL export in the browser (no PowerShell, no edge function). */
export async function parseRentRollFile(file: File): Promise<RentRollParse> {
  return parseMriRentRoll(await readWorkbookMatrix(file))
}

export interface GoLiveResult {
  property_id: string
  batch_id: string | null
  rent_roll_rows: number
  documents_attached: number
  keywords_added: string[]
}

/** The one irreversible step: creates the asset and adopts everything staged. */
export async function completeOnboarding(draftId: string, confirmName: string): Promise<GoLiveResult> {
  const { data, error } = await supabase.rpc('complete_property_onboarding', {
    p_draft: draftId, p_confirm_name: confirmName,
  })
  if (error) throw new Error(error.message)
  return data as GoLiveResult
}
