// Data layer for the PPM generator (/ppm).
//
// ppm_drafts rows carry the whole document state: the structured data sheet
// (every deal fact) + per-section narrative drafts. AI assist goes through the
// ppm-draft edge fn (draft one section / extract fields from pasted source text).

import { supabase } from '../lib/supabase'
import { useQuery } from './useQuery'
import { blankDataSheet, type PpmDataSheet } from '../lib/ppm/template'

export interface PpmSectionState {
  text: string
  mode: 'ai' | 'edited'
  generated_at?: string
  approved?: boolean
}

export interface PpmDraft {
  id: string
  deal_id: string | null
  name: string
  status: 'draft' | 'review' | 'final'
  data_sheet: PpmDataSheet
  sections: Record<string, PpmSectionState>
  created_by: string | null
  created_at: string
  updated_at: string
}

/** Merge a stored (possibly older-shaped) data sheet over a fresh blank one. */
export function hydrateDataSheet(raw: unknown): PpmDataSheet {
  const base = blankDataSheet()
  if (raw && typeof raw === 'object') Object.assign(base, raw as Partial<PpmDataSheet>)
  return base
}

export function usePpmDrafts() {
  return useQuery<PpmDraft[]>(async () => {
    const { data, error } = await supabase
      .from('ppm_drafts')
      .select('*')
      .order('updated_at', { ascending: false })
    if (error) {
      console.warn('[ppm] list unavailable:', error.message)
      return []
    }
    return (data ?? []).map(d => ({ ...d, data_sheet: hydrateDataSheet(d.data_sheet), sections: d.sections ?? {} })) as PpmDraft[]
  }, [])
}

export async function createPpmDraft(name: string, dealId: string | null, dataSheet: PpmDataSheet, createdBy: string | null): Promise<PpmDraft> {
  const { data, error } = await supabase
    .from('ppm_drafts')
    .insert({ name, deal_id: dealId, data_sheet: dataSheet, sections: {}, created_by: createdBy })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return { ...data, data_sheet: hydrateDataSheet(data.data_sheet), sections: data.sections ?? {} } as PpmDraft
}

export async function savePpmDraft(id: string, patch: Partial<Pick<PpmDraft, 'name' | 'status' | 'data_sheet' | 'sections' | 'deal_id'>>): Promise<void> {
  const { error } = await supabase
    .from('ppm_drafts')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deletePpmDraft(id: string): Promise<void> {
  const { error } = await supabase.from('ppm_drafts').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

/** Draft one AI section via the ppm-draft edge fn. */
export async function draftPpmSection(sectionKey: string, dataSheet: PpmDataSheet, notes?: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('ppm-draft', {
    body: { action: 'draft', sectionKey, dataSheet, notes: notes || undefined },
  })
  if (error) throw new Error(error.message)
  if ((data as any)?.error) throw new Error((data as any).error)
  return String((data as any)?.text ?? '')
}

/** Extract data-sheet fields from pasted source text via the ppm-draft edge fn. */
export async function extractPpmFields(text: string, focus?: string): Promise<Partial<PpmDataSheet>> {
  const { data, error } = await supabase.functions.invoke('ppm-draft', {
    body: { action: 'extract', text, focus: focus || undefined },
  })
  if (error) throw new Error(error.message)
  if ((data as any)?.error) throw new Error((data as any).error)
  return ((data as any)?.fields ?? {}) as Partial<PpmDataSheet>
}

/**
 * Prefill a data sheet from a pipeline deal (+ its latest OM extraction).
 * Fills identity/physical/deal-terms/returns from the pipeline deal, and pulls
 * the OM extraction (tenant roster, thesis bullets, submarket, occupancy, and
 * physical/pricing fallbacks). Everything not covered stays blank for the author.
 */
export async function dataSheetFromDeal(dealId: string): Promise<{ name: string; ds: PpmDataSheet }> {
  const ds = blankDataSheet()
  const { data: raw, error } = await supabase.from('pipeline_deals').select('*').eq('id', dealId).single()
  if (error || !raw) throw new Error('Deal not found')
  const deal = raw as any

  ds.propertyName = deal.name ?? ''
  ds.city = deal.city ?? ''
  ds.state = deal.state ?? ''
  ds.submarketName = deal.submarket ?? ''
  ds.glaSf = deal.gla_sf ?? null
  ds.yearBuilt = deal.year_built ? String(deal.year_built) : ''
  ds.purchasePrice = deal.ask_price ?? null
  ds.goingInCap = deal.going_in_cap ?? null
  ds.totalEquity = deal.equity_required ?? null
  ds.totalCapitalization = deal.total_capitalization ?? null
  ds.projIrr = deal.proj_irr ?? null
  ds.equityMultiple = deal.equity_multiple ?? null
  ds.avgCoc = deal.avg_coc ?? null
  ds.holdYears = deal.hold_years ?? null
  ds.exitCap = deal.exit_cap ?? null

  // Property type from asset_type + risk_profile (e.g. "Retail - Core Plus").
  const humanize = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  const typeParts = [deal.asset_type, deal.risk_profile].filter(Boolean).map((s: string) => humanize(s))
  if (typeParts.length) ds.propertyType = typeParts.join(' - ')

  // Thesis bullets already assembled on the deal by enrich_deals.ps1 (from the
  // OM key_points). Seed the "market overview notes (for AI)" so the narrative
  // sections have the deal's positioning to draw on.
  if (deal.thesis) ds.marketOverviewNotes = String(deal.thesis)

  // Latest OM extraction: tenant roster, thesis fallback, and physical/pricing
  // fallbacks when the deal's own columns are blank.
  const { data: om } = await supabase
    .from('om_intake').select('extracted')
    .eq('deal_id', dealId).order('created_at', { ascending: false }).limit(1)
  const ex = (om ?? [])[0]?.extracted as any
  if (ex) {
    if (ex.major_tenants?.length) {
      ds.tenants = ex.major_tenants.map((t: any) => ({
        name: t.name ?? '', sf: t.sf ?? null, pctGla: null, pctRev: null, rentPsf: t.rent_psf ?? null,
        leaseType: 'NNN', expiration: t.expiration ?? '', options: t.options ?? '',
        salesPsf: null, healthRatio: null, placerRank: '', groundLease: false,
      }))
    }
    if (ex.occupancy != null) ds.occupancyPct = ex.occupancy > 1 ? ex.occupancy / 100 : ex.occupancy
    if (!ds.submarketName && ex.submarket) ds.submarketName = ex.submarket
    if (!ds.glaSf && ex.gla_sf != null) ds.glaSf = ex.gla_sf
    if (!ds.yearBuilt && ex.year_built) ds.yearBuilt = String(ex.year_built)
    if (ds.purchasePrice == null && ex.asking_price != null) ds.purchasePrice = ex.asking_price
    if (ds.goingInCap == null && ex.in_place_cap != null) ds.goingInCap = ex.in_place_cap
    // Thesis fallback if the deal row had none.
    if (!ds.marketOverviewNotes && Array.isArray(ex.key_points) && ex.key_points.length) {
      ds.marketOverviewNotes = ex.key_points.map((k: string) => `- ${k}`).join('\n')
    }
  }

  if (ds.purchasePrice != null && ds.glaSf) ds.pricePsf = Math.round(ds.purchasePrice / ds.glaSf)
  if (ds.purchasePrice != null && ds.goingInCap != null) ds.inPlaceNoi = Math.round(ds.purchasePrice * ds.goingInCap)

  return { name: deal.name ?? 'New PPM', ds }
}
