import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'

// Acquisition deal pipeline (v2, migration 20240063). Modeled on the firm's Deal
// Tracking Sheet: Investment Profile (risk × asset), Team, Submarket, an LP
// mandate book (capital_partners), a per-deal raise funnel (pipeline_deal_lps),
// and OM intake (om_intake + the om-extract edge function).
//
// All tables are gated to admin / asset_manager by RLS, so a manager sees every
// deal and every LP — embeds resolve cleanly.

// ── taxonomy ─────────────────────────────────────────────────────────────────
export type Stage =
  | 'tracking' | 'sourced' | 'screening' | 'underwriting' | 'loi' | 'under_contract'
  | 'dd' | 'ic_approval' | 'closing' | 'closed' | 'passed' | 'dead' | 'lost'

// Board columns collapse the firm's tiers into five working stages. 'tracking'
// (the Property-Tracking watchlist) is NOT a board column — surfaced separately.
export const BOARD_STAGES: Stage[] = ['sourced', 'underwriting', 'loi', 'under_contract', 'closed']
export const TERMINAL_STAGES: Stage[] = ['passed', 'dead', 'lost']
export const ALL_STAGES: Stage[] =
  ['tracking', 'sourced', 'screening', 'underwriting', 'loi', 'under_contract', 'dd', 'ic_approval', 'closing', 'closed', 'passed', 'dead', 'lost']

export const STAGE_LABEL: Record<Stage, string> = {
  tracking: 'Watchlist', sourced: 'Sourced / OM', screening: 'Screening', underwriting: 'Underwriting', loi: 'LOI',
  under_contract: 'Under Contract / DD', dd: 'Due diligence', ic_approval: 'IC approval',
  closing: 'Closing', closed: 'Closed', passed: 'Passed', dead: 'Dead', lost: 'Lost',
}
export const STAGE_HUE: Record<Stage, string> = {
  tracking: '#9AA7AD', sourced: '#8FA2AD', screening: '#7C9CB0', underwriting: '#6E93B4', loi: '#5385C4',
  under_contract: '#3E9C82', dd: '#4F80C0', ic_approval: '#4A7BB8', closing: '#3E9C82',
  closed: '#2E8B57', passed: '#B08968', dead: '#9A9A9A', lost: '#C06A5E',
}

/** A deal is in the active funnel when it's neither watchlist, closed, nor terminal. */
export const isActiveStage = (s: Stage): boolean => s !== 'tracking' && s !== 'closed' && !TERMINAL_STAGES.includes(s)
// Which board column a stage rolls into (screening→underwriting, dd/ic/closing→under_contract).
export const boardColumn = (s: Stage): Stage =>
  s === 'screening' ? 'underwriting'
  : (s === 'dd' || s === 'ic_approval' || s === 'closing') ? 'under_contract'
  : s
export const isTerminal = (s: Stage): boolean => TERMINAL_STAGES.includes(s)

// Default close probability per stage (drives the weighted pipeline).
export const STAGE_PROB: Record<Stage, number> = {
  tracking: 0, sourced: 0.08, screening: 0.15, underwriting: 0.25, loi: 0.5, under_contract: 0.75,
  dd: 0.8, ic_approval: 0.85, closing: 0.95, closed: 1, passed: 0, dead: 0, lost: 0,
}

export type RiskProfile = 'core' | 'core_plus' | 'value_add' | 'opportunistic'
export const RISK_ORDER: RiskProfile[] = ['core', 'core_plus', 'value_add', 'opportunistic']
export const RISK_LABEL: Record<RiskProfile, string> =
  { core: 'Core', core_plus: 'Core-Plus', value_add: 'Value-Add', opportunistic: 'Opportunistic' }
export const RISK_COLOR: Record<RiskProfile, string> =
  { core: '#2e8b57', core_plus: '#4f86c6', value_add: '#c79141', opportunistic: '#c0654e' }

export type AssetType = 'retail' | 'office' | 'mixed' | 'industrial'
export const ASSET_ORDER: AssetType[] = ['retail', 'office', 'mixed']
export const ASSET_LABEL: Record<AssetType, string> =
  { retail: 'Retail', office: 'Office', mixed: 'Mixed-Use', industrial: 'Industrial' }
export const ASSET_MONO: Record<AssetType, string> = { retail: 'R', office: 'O', mixed: 'M', industrial: 'I' }
export const ASSET_COLOR: Record<AssetType, string> =
  { retail: '#2e8b57', office: '#4f86c6', mixed: '#c79141', industrial: '#8a99a0' }

export interface TeamMember { id: string; initials: string; fullName: string; title: string | null; active: boolean }

/** The acquisitions team roster (deal_team_members) for the name pickers. */
export function useDealTeamMembers() {
  return useQuery<TeamMember[]>(async () => {
    const { data, error } = await supabase.from('deal_team_members')
      .select('id, initials, full_name, title, active').order('sort_order', { ascending: true })
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(m => ({
      id: m.id, initials: m.initials, fullName: m.full_name, title: m.title ?? null, active: m.active ?? true,
    }))
  }, [])
}

export type LpStatus = 'identified' | 'teaser_sent' | 'reviewing' | 'soft_circle' | 'committed' | 'passed'
export const LP_STATUS_ORDER: LpStatus[] = ['identified', 'teaser_sent', 'reviewing', 'soft_circle', 'committed', 'passed']
export const LP_STATUS_LABEL: Record<LpStatus, string> = {
  identified: 'Identified', teaser_sent: 'Teaser sent', reviewing: 'Reviewing',
  soft_circle: 'Soft-circled', committed: 'Committed', passed: 'Passed',
}
export const PARTNER_TIER_LABEL: Record<string, string> =
  { current: 'Current', tier1_prospect: 'Tier 1', tier2_prospect: 'Tier 2' }

// ── types ────────────────────────────────────────────────────────────────────
export interface DealLp {
  id: string
  partnerId: string
  partnerName: string
  status: LpStatus
  softAmount: number | null
  committedAmount: number | null
  notes: string | null
}

/** Editable acquisition-underwriting assumptions (decimals for rates), persisted
 *  on pipeline_deals.underwriting_model. Shared financing/exit fields + a simple
 *  (direct-cap) payload and an optional tenant-level (rent-roll) payload. */
export interface UnderwritingModel {
  purchasePrice: number
  acqCostsPct: number
  capexUpfront: number
  inPlaceNoi: number
  noiGrowthPct: number
  holdYears: number
  exitCapPct: number
  sellingCostsPct: number
  ltvPct: number
  loanRatePct: number
  amortYears: number
  // financing realism (v3.2)
  ioYears?: number            // interest-only years at the start
  loanFeePct?: number         // origination fee % of the loan
  refi?: UwRefi | null        // optional mid-hold cash-out refinance
  // tenant-level (v2) — present when mode === 'tenant'
  mode?: 'simple' | 'tenant'
  glaSf?: number
  leases?: UwLeaseLine[]
  rollover?: UwRollover
  opex?: UwOpex
}
export interface UwRefi { yearsFromClose: number; ltvPct: number; ratePct: number; amortYears: number; ioYears: number; costPct: number; capPct: number }
export interface UwLeaseLine { name: string; sf: number; baseRentPsf: number; annualBumpPct: number; termRemainingYears: number; recovery: 'nnn' | 'gross' | 'base_year'; proRataSharePct?: number; baseYearOpexPsf?: number; salesPsf?: number; pctRentRate?: number; breakpointPsf?: number }
export interface UwRollover { renewalProbPct: number; marketRentPsf: number; marketRentGrowthPct: number; downtimeMonths: number; tiNewPsf: number; tiRenewPsf: number; lcNewPsf: number; lcRenewPsf: number; freeRentMonthsNew: number; releaseTermYears?: number }
export interface UwOpex { recoverableOpexPsf: number; nonRecoverableOpexPsf: number; opexGrowthPct: number; generalVacancyPct: number; creditLossPct: number; capitalReservePsf: number; otherIncomePsf?: number; adminFeePct?: number; recoveryCapPct?: number; grossUpPct?: number; salesGrowthPct?: number }

export interface Deal {
  id: string
  name: string
  assetType: AssetType
  riskProfile: RiskProfile
  subType: string | null
  submarket: string | null
  team: string[]
  leadMemberId: string | null
  leadName: string | null
  leadInitials: string | null
  analystMemberId: string | null
  analystName: string | null
  analystInitials: string | null
  market: string | null
  city: string | null
  state: string | null
  address: string | null
  glaSf: number | null
  yearBuilt: number | null
  stage: Stage
  dealSource: 'marketed' | 'off_market' | null
  broker: string | null
  seller: string | null
  partner: string | null
  askPrice: number | null
  priceText: string | null
  goingInCap: number | null
  equityRequired: number | null
  totalCapitalization: number | null
  probability: number
  targetCloseDate: string | null
  bidText: string | null
  thesis: string | null
  projIrr: number | null
  equityMultiple: number | null
  avgCoc: number | null
  holdYears: number | null
  exitCap: number | null
  stabilizedYield: number | null
  underwritingModel: UnderwritingModel | null
  lostReason: string | null
  propertyId: string | null
  propertyName: string | null
  transactionId: string | null
  folderPath: string | null
  folderFiles: { name: string; dir: boolean }[] | null
  ddPropertyId: string | null
  createdAt: string
  updatedAt: string
  lps: DealLp[]
}

export interface CapitalPartner {
  id: string
  name: string
  tier: 'current' | 'tier1_prospect' | 'tier2_prospect'
  productTypes: string[]
  markets: string | null
  returnTarget: string | null
  leverage: string | null
  dealSize: string | null
  preferredHold: string | null
  feeStructure: string | null
  relationshipManager: string | null
  primaryContact: string | null
  notes: string | null
  active: boolean
}

export interface OmRow {
  id: string
  dealId: string | null
  requestor: string | null
  dealName: string
  city: string | null
  state: string | null
  offerDueDate: string | null
  dateRequested: string | null
  omReceived: boolean
  baseModel: 'none' | 'partial' | 'complete'
  spokeToBroker: boolean
  taxesUpdated: boolean
  comments: string | null
}

export interface OmExtraction {
  name?: string
  city?: string | null
  state?: string | null
  submarket?: string | null
  asset_type?: AssetType | null
  risk_profile?: RiskProfile | null
  sub_type?: string | null
  gla_sf?: number | null
  year_built?: number | null
  occupancy?: number | null
  asking_price?: number | null
  asking_guidance_text?: string | null
  in_place_cap?: number | null
  noi?: number | null
  major_tenants?: { name: string; sf: number | null; expiration: string | null }[]
  key_points?: string[]
  open_questions?: string[]
}

const num = (v: any): number | null => (v != null ? Number(v) : null)

const DEAL_SELECT =
  'id, name, asset_type, risk_profile, sub_type, submarket, team, market, city, state, address, ' +
  'gla_sf, year_built, stage, deal_source, broker, seller, partner, ask_price, price_text, ' +
  'going_in_cap, equity_required, total_capitalization, probability, target_close_date, bid_text, thesis, ' +
  'proj_irr, equity_multiple, avg_coc, hold_years, exit_cap, stabilized_yield, lost_reason, underwriting_model, ' +
  'lead_member_id, analyst_member_id, property_id, transaction_id, folder_path, folder_files, dd_property_id, created_at, updated_at, ' +
  'property:property_id(name), lead:lead_member_id(full_name, initials), analyst:analyst_member_id(full_name, initials), ' +
  'pipeline_deal_lps(id, partner_id, status, soft_amount, committed_amount, notes, capital_partners(name))'

function mapDeal(r: any): Deal {
  const lps: DealLp[] = ((r.pipeline_deal_lps ?? []) as any[]).map(l => ({
    id: l.id, partnerId: l.partner_id, partnerName: l.capital_partners?.name ?? '—',
    status: l.status, softAmount: num(l.soft_amount), committedAmount: num(l.committed_amount), notes: l.notes ?? null,
  })).sort((a, b) => LP_STATUS_ORDER.indexOf(b.status) - LP_STATUS_ORDER.indexOf(a.status))
  return {
    id: r.id, name: r.name, assetType: r.asset_type, riskProfile: r.risk_profile,
    subType: r.sub_type ?? null, submarket: r.submarket ?? null, team: r.team ?? [],
    leadMemberId: r.lead_member_id ?? null, leadName: r.lead?.full_name ?? null, leadInitials: r.lead?.initials ?? null,
    analystMemberId: r.analyst_member_id ?? null, analystName: r.analyst?.full_name ?? null, analystInitials: r.analyst?.initials ?? null,
    market: r.market ?? null, city: r.city ?? null, state: r.state ?? null, address: r.address ?? null,
    glaSf: num(r.gla_sf), yearBuilt: r.year_built ?? null, stage: r.stage,
    dealSource: r.deal_source ?? null, broker: r.broker ?? null, seller: r.seller ?? null, partner: r.partner ?? null,
    askPrice: num(r.ask_price), priceText: r.price_text ?? null, goingInCap: num(r.going_in_cap),
    equityRequired: num(r.equity_required), totalCapitalization: num(r.total_capitalization),
    probability: Number(r.probability ?? 0), targetCloseDate: r.target_close_date ?? null, bidText: r.bid_text ?? null,
    thesis: r.thesis ?? null, projIrr: num(r.proj_irr), equityMultiple: num(r.equity_multiple),
    avgCoc: num(r.avg_coc), holdYears: num(r.hold_years), exitCap: num(r.exit_cap), stabilizedYield: num(r.stabilized_yield),
    underwritingModel: (r.underwriting_model ?? null) as UnderwritingModel | null,
    lostReason: r.lost_reason ?? null, propertyId: r.property_id ?? null, propertyName: r.property?.name ?? null,
    transactionId: r.transaction_id ?? null, folderPath: r.folder_path ?? null, folderFiles: r.folder_files ?? null,
    ddPropertyId: r.dd_property_id ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at, lps,
  }
}

export function usePipeline() {
  return useQuery<Deal[]>(async () => {
    const { data, error } = await supabase
      .from('pipeline_deals').select(DEAL_SELECT)
      .order('updated_at', { ascending: false }).limit(1000)
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(mapDeal)
  }, [])
}

export function useCapitalPartners() {
  return useQuery<CapitalPartner[]>(async () => {
    const { data, error } = await supabase.from('capital_partners').select('*').order('name').limit(1000)
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(p => ({
      id: p.id, name: p.name, tier: p.tier, productTypes: p.product_types ?? [], markets: p.markets ?? null,
      returnTarget: p.return_target ?? null, leverage: p.leverage ?? null, dealSize: p.deal_size ?? null,
      preferredHold: p.preferred_hold ?? null, feeStructure: p.fee_structure ?? null,
      relationshipManager: p.relationship_manager ?? null, primaryContact: p.primary_contact ?? null,
      notes: p.notes ?? null, active: p.active ?? true,
    }))
  }, [])
}

export function useOmIntake() {
  return useQuery<OmRow[]>(async () => {
    const { data, error } = await supabase.from('om_intake')
      .select('id, deal_id, requestor, deal_name, city, state, offer_due_date, date_requested, om_received, base_model, spoke_to_broker, taxes_updated, comments')
      .order('date_requested', { ascending: false }).limit(1000)
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(r => ({
      id: r.id, dealId: r.deal_id ?? null, requestor: r.requestor ?? null, dealName: r.deal_name,
      city: r.city ?? null, state: r.state ?? null, offerDueDate: r.offer_due_date ?? null,
      dateRequested: r.date_requested ?? null, omReceived: !!r.om_received, baseModel: r.base_model ?? 'none',
      spokeToBroker: !!r.spoke_to_broker, taxesUpdated: !!r.taxes_updated, comments: r.comments ?? null,
    }))
  }, [])
}

// ── capital-partner mutations (the LP mandate book is team-maintained) ────────
export interface PartnerInput {
  name: string
  tier: 'current' | 'tier1_prospect' | 'tier2_prospect'
  productTypes: string[]
  markets?: string | null
  returnTarget?: string | null
  leverage?: string | null
  dealSize?: string | null
  preferredHold?: string | null
  feeStructure?: string | null
  relationshipManager?: string | null
  primaryContact?: string | null
  notes?: string | null
  active?: boolean
}

function partnerRow(p: PartnerInput): Record<string, unknown> {
  return {
    name: p.name.trim(), tier: p.tier, product_types: p.productTypes,
    markets: p.markets?.trim() || null, return_target: p.returnTarget?.trim() || null,
    leverage: p.leverage?.trim() || null, deal_size: p.dealSize?.trim() || null,
    preferred_hold: p.preferredHold?.trim() || null, fee_structure: p.feeStructure?.trim() || null,
    relationship_manager: p.relationshipManager?.trim() || null, primary_contact: p.primaryContact?.trim() || null,
    notes: p.notes?.trim() || null, active: p.active ?? true,
  }
}

export async function createPartner(p: PartnerInput): Promise<void> {
  const { error } = await supabase.from('capital_partners').insert(partnerRow(p))
  if (error) throw new Error(error.message)
}

export async function updatePartner(id: string, p: PartnerInput): Promise<void> {
  const { error } = await supabase.from('capital_partners')
    .update({ ...partnerRow(p), updated_at: new Date().toISOString() }).eq('id', id)
  if (error) throw new Error(error.message)
}

/** Deleting a partner cascades its rows out of every deal's LP funnel. */
export async function deletePartner(id: string): Promise<void> {
  const { error } = await supabase.from('capital_partners').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// ── mutations ────────────────────────────────────────────────────────────────
export interface NewDeal {
  name: string
  assetType: AssetType
  riskProfile?: RiskProfile
  subType?: string | null
  submarket?: string | null
  team?: string[]
  leadMemberId?: string | null
  analystMemberId?: string | null
  market?: string | null
  city?: string | null
  state?: string | null
  dealSource?: 'marketed' | 'off_market' | null
  broker?: string | null
  seller?: string | null
  partner?: string | null
  glaSf?: number | null
  yearBuilt?: number | null
  askPrice?: number | null
  priceText?: string | null
  goingInCap?: number | null
  equityRequired?: number | null
  targetCloseDate?: string | null
  bidText?: string | null
  thesis?: string | null
  stage?: Stage
}

export async function createDeal(d: NewDeal, createdBy: string | null): Promise<string> {
  const stage = d.stage ?? 'sourced'
  const { data, error } = await supabase.from('pipeline_deals').insert({
    name: d.name.trim(), asset_type: d.assetType, risk_profile: d.riskProfile ?? 'value_add',
    sub_type: d.subType?.trim() || null, submarket: d.submarket?.trim() || null, team: d.team ?? [],
    lead_member_id: d.leadMemberId || null, analyst_member_id: d.analystMemberId || null,
    market: d.market?.trim() || null, city: d.city?.trim() || null, state: d.state?.trim() || null,
    deal_source: d.dealSource || null, broker: d.broker?.trim() || null, seller: d.seller?.trim() || null,
    partner: d.partner?.trim() || null, gla_sf: d.glaSf ?? null, year_built: d.yearBuilt ?? null,
    ask_price: d.askPrice ?? null, price_text: d.priceText?.trim() || null, going_in_cap: d.goingInCap ?? null,
    equity_required: d.equityRequired ?? null, target_close_date: d.targetCloseDate || null,
    bid_text: d.bidText?.trim() || null, thesis: d.thesis?.trim() || null,
    stage, probability: STAGE_PROB[stage], created_by: createdBy,
  }).select('id').single()
  if (error) throw new Error(error.message)
  return (data as any).id
}

export interface DealPatch {
  name?: string; assetType?: AssetType; riskProfile?: RiskProfile; subType?: string | null
  submarket?: string | null; team?: string[]; leadMemberId?: string | null; analystMemberId?: string | null
  market?: string | null; city?: string | null; state?: string | null
  address?: string | null; glaSf?: number | null; yearBuilt?: number | null; stage?: Stage
  dealSource?: 'marketed' | 'off_market' | null; broker?: string | null; seller?: string | null; partner?: string | null
  askPrice?: number | null; priceText?: string | null; goingInCap?: number | null; equityRequired?: number | null
  totalCapitalization?: number | null; probability?: number; targetCloseDate?: string | null; bidText?: string | null
  thesis?: string | null; projIrr?: number | null; equityMultiple?: number | null; avgCoc?: number | null
  holdYears?: number | null; exitCap?: number | null; stabilizedYield?: number | null; lostReason?: string | null
}

export async function updateDeal(id: string, patch: DealPatch): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  const map: Record<string, string> = {
    name: 'name', assetType: 'asset_type', riskProfile: 'risk_profile', subType: 'sub_type', submarket: 'submarket',
    team: 'team', leadMemberId: 'lead_member_id', analystMemberId: 'analyst_member_id',
    market: 'market', city: 'city', state: 'state', address: 'address', glaSf: 'gla_sf',
    yearBuilt: 'year_built', dealSource: 'deal_source', broker: 'broker', seller: 'seller', partner: 'partner',
    askPrice: 'ask_price', priceText: 'price_text', goingInCap: 'going_in_cap', equityRequired: 'equity_required',
    totalCapitalization: 'total_capitalization', targetCloseDate: 'target_close_date', bidText: 'bid_text',
    thesis: 'thesis', projIrr: 'proj_irr', equityMultiple: 'equity_multiple', avgCoc: 'avg_coc',
    holdYears: 'hold_years', exitCap: 'exit_cap', stabilizedYield: 'stabilized_yield', lostReason: 'lost_reason',
  }
  for (const [k, col] of Object.entries(map)) {
    if ((patch as any)[k] === undefined) continue
    let v = (patch as any)[k]
    if (typeof v === 'string') v = v.trim() || null
    row[col] = v
  }
  if (patch.stage !== undefined) {
    row.stage = patch.stage
    if (patch.probability === undefined) row.probability = STAGE_PROB[patch.stage]
  }
  if (patch.probability !== undefined) row.probability = patch.probability
  const { error } = await supabase.from('pipeline_deals').update(row).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteDeal(id: string): Promise<void> {
  const { error } = await supabase.from('pipeline_deals').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

/** Persist the underwriting model + write its computed returns to the deal's
 *  metric columns (board / meeting deck / IC memo / analytics read these). Does
 *  NOT touch sheet-owned ask_price or going_in_cap — those stay from the weekly
 *  book sync. */
export async function saveUnderwriting(
  dealId: string,
  model: UnderwritingModel,
  computed: {
    projIrr: number | null; equityMultiple: number | null; avgCoc: number | null
    exitCap: number | null; holdYears: number | null; stabilizedYield: number | null
    equityRequired: number | null; totalCapitalization: number | null
  },
): Promise<void> {
  const { error } = await supabase.from('pipeline_deals').update({
    underwriting_model: model,
    proj_irr: computed.projIrr, equity_multiple: computed.equityMultiple, avg_coc: computed.avgCoc,
    exit_cap: computed.exitCap, hold_years: computed.holdYears, stabilized_yield: computed.stabilizedYield,
    equity_required: computed.equityRequired, total_capitalization: computed.totalCapitalization,
    updated_at: new Date().toISOString(),
  }).eq('id', dealId)
  if (error) throw new Error(error.message)
}

export async function closeDeal(
  dealId: string,
  opts: { closeDate?: string | null; finalPrice?: number | null; portfolioId?: string | null } = {},
): Promise<{ propertyId: string; transactionId: string }> {
  const { data, error } = await supabase.rpc('close_pipeline_deal', {
    p_deal_id: dealId, p_close_date: opts.closeDate || null,
    p_final_price: opts.finalPrice ?? null, p_portfolio_id: opts.portfolioId || null,
  })
  if (error) throw new Error(error.message)
  const r = (data ?? {}) as any
  return { propertyId: r.property_id, transactionId: r.transaction_id }
}

export async function addDealLp(dealId: string, partnerId: string): Promise<void> {
  const { error } = await supabase.from('pipeline_deal_lps')
    .insert({ deal_id: dealId, partner_id: partnerId, status: 'identified' })
  if (error) throw new Error(error.message)
}
export interface DealLpPatch { status?: LpStatus; softAmount?: number | null; committedAmount?: number | null; notes?: string | null }
export async function updateDealLp(id: string, patch: DealLpPatch): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.status !== undefined) row.status = patch.status
  if (patch.softAmount !== undefined) row.soft_amount = patch.softAmount ?? null
  if (patch.committedAmount !== undefined) row.committed_amount = patch.committedAmount ?? null
  if (patch.notes !== undefined) row.notes = patch.notes?.trim() || null
  const { error } = await supabase.from('pipeline_deal_lps').update(row).eq('id', id)
  if (error) throw new Error(error.message)
}
export async function removeDealLp(id: string): Promise<void> {
  const { error } = await supabase.from('pipeline_deal_lps').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// ── OM intake ────────────────────────────────────────────────────────────────
export interface OmPatch {
  omReceived?: boolean; baseModel?: 'none' | 'partial' | 'complete'
  spokeToBroker?: boolean; taxesUpdated?: boolean; comments?: string | null
}
export async function updateOmRow(id: string, patch: OmPatch): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.omReceived !== undefined) row.om_received = patch.omReceived
  if (patch.baseModel !== undefined) row.base_model = patch.baseModel
  if (patch.spokeToBroker !== undefined) row.spoke_to_broker = patch.spokeToBroker
  if (patch.taxesUpdated !== undefined) row.taxes_updated = patch.taxesUpdated
  if (patch.comments !== undefined) row.comments = patch.comments?.trim() || null
  const { error } = await supabase.from('om_intake').update(row).eq('id', id)
  if (error) throw new Error(error.message)
}

/** Run the om-extract edge function over an uploaded PDF, pasted text, or a corpus document. */
export async function extractOm(input: { storagePath?: string; documentId?: string; text?: string; dealName?: string }): Promise<OmExtraction> {
  const { data, error } = await supabase.functions.invoke('om-extract', {
    body: { storagePath: input.storagePath, documentId: input.documentId, text: input.text, deal_name: input.dealName },
  })
  if (error) throw new Error(error.message)
  if ((data as any)?.error) throw new Error((data as any).error)
  return ((data as any)?.extraction ?? {}) as OmExtraction
}

// ── per-deal documents (pipeline_deal_documents, migration 20240065) ─────────
export interface DealDocRole { key: string; label: string; docType: string }
export const DEAL_DOC_ROLES: DealDocRole[] = [
  { key: 'om',                  label: 'Offering Memorandum',       docType: 'other' },
  { key: 'site_plan',           label: 'Site Plan',                 docType: 'site_plan' },
  { key: 'teaser',              label: 'Teaser',                    docType: 'other' },
  { key: 'rent_roll',           label: 'Rent Roll',                 docType: 'rent_roll' },
  { key: 'operating_statement', label: 'T-12 / Operating Statement', docType: 'operating_statement' },
  { key: 'financials',          label: 'Financials / Model',        docType: 'other' },
  { key: 'debt',                label: 'Debt',                      docType: 'other' },
  { key: 'loi',                 label: 'LOI',                       docType: 'other' },
  { key: 'psa',                 label: 'PSA & Amendments',          docType: 'psa' },
  { key: 'title',               label: 'Title / Survey',            docType: 'title' },
  { key: 'environmental',       label: 'Environmental (Phase I)',   docType: 'other' },
  { key: 'estoppel',            label: 'Estoppels',                 docType: 'estoppel' },
  { key: 'service_contract',    label: 'Service Contracts',         docType: 'other' },
  { key: 'other',               label: 'Other',                     docType: 'other' },
]
export const dealDocRoleLabel = (k: string | null): string =>
  DEAL_DOC_ROLES.find(r => r.key === k)?.label ?? 'Document'

export interface DealDoc {
  linkId: string
  documentId: string
  role: string | null
  title: string | null
  fileName: string | null
  storagePath: string | null
  signedUrl: string | null
  fileSizeBytes: number | null
  createdAt: string
}

export function useDealDocuments(dealId: string | null) {
  return useQuery<DealDoc[]>(async () => {
    if (!dealId) return []
    const { data, error } = await supabase.from('pipeline_deal_documents')
      .select('id, role, created_at, document_id, documents(title, file_name, storage_path, file_size_bytes)')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    // hide the deck's pre-rendered site-plan JPEGs from the Documents tab
    const rows = ((data ?? []) as any[]).filter(r => r.role !== 'site_plan_img')
    const paths = Array.from(new Set(rows.map(r => r.documents?.storage_path).filter((p: any): p is string => !!p)))
    const signed = new Map<string, string>()
    if (paths.length) {
      const { data: s } = await supabase.storage.from('documents').createSignedUrls(paths, 3600)
      for (const it of s ?? []) if (it.path && it.signedUrl) signed.set(it.path, it.signedUrl)
    }
    return rows.map(r => {
      const d = r.documents ?? {}
      const sp: string | null = d.storage_path ?? null
      return {
        linkId: r.id, documentId: r.document_id, role: r.role ?? null,
        title: d.title ?? null, fileName: d.file_name ?? null, storagePath: sp,
        signedUrl: sp ? (signed.get(sp) ?? null) : null,
        fileSizeBytes: d.file_size_bytes != null ? Number(d.file_size_bytes) : null,
        createdAt: r.created_at,
      } as DealDoc
    })
  }, [dealId])
}

/** Upload a document to a deal: stores under pipeline/<dealId>/<role>/, files a
 *  documents row, and links it to the deal. */
export async function uploadDealDocument(dealId: string, file: File, role: string, createdBy: string | null): Promise<void> {
  const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80)
  const uid = (globalThis.crypto?.randomUUID?.() ?? String(Date.now()))
  const path = `pipeline/${dealId}/${role}/${uid}-${safe}`
  const { error: upErr } = await supabase.storage.from('documents')
    .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false })
  if (upErr) throw new Error('Upload failed: ' + upErr.message)
  const docType = DEAL_DOC_ROLES.find(r => r.key === role)?.docType ?? 'other'
  const { data: doc, error: dErr } = await supabase.from('documents').insert({
    title: file.name.replace(/\.[^.]+$/, ''), file_name: file.name, storage_path: path,
    doc_type: docType, file_size_bytes: file.size, property_id: null,
  }).select('id').single()
  if (dErr || !doc) throw new Error('Filing the document row failed: ' + (dErr?.message ?? ''))
  const { error: lErr } = await supabase.from('pipeline_deal_documents')
    .insert({ deal_id: dealId, document_id: (doc as any).id, role, created_by: createdBy })
  if (lErr) throw new Error('Linking the document failed: ' + lErr.message)
}

/** Unlink + delete a deal document (removes the storage object best-effort). */
export async function removeDealDocument(d: DealDoc): Promise<void> {
  const { error } = await supabase.from('pipeline_deal_documents').delete().eq('id', d.linkId)
  if (error) throw new Error(error.message)
  // best-effort cleanup of the underlying document row + storage object
  await supabase.from('documents').delete().eq('id', d.documentId)
  if (d.storagePath) await supabase.storage.from('documents').remove([d.storagePath])
}

// ── deal discussion thread (pipeline_deal_comments, migration 20240066) ──────
export interface DealComment {
  id: string
  dealId: string
  lpId: string | null
  authorId: string | null
  body: string
  createdAt: string
  editedAt: string | null
}

export function useDealComments(dealId: string | null) {
  return useQuery<DealComment[]>(async () => {
    if (!dealId) return []
    const { data, error } = await supabase.from('pipeline_deal_comments')
      .select('id, deal_id, lp_id, author_id, body, created_at, edited_at')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: true })
      .limit(1000)
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(r => ({
      id: r.id, dealId: r.deal_id, lpId: r.lp_id ?? null, authorId: r.author_id ?? null,
      body: r.body, createdAt: r.created_at, editedAt: r.edited_at ?? null,
    }))
  }, [dealId])
}

export async function addDealComment(dealId: string, body: string, authorId: string | null, lpId?: string | null): Promise<void> {
  const { error } = await supabase.from('pipeline_deal_comments')
    .insert({ deal_id: dealId, body: body.trim(), author_id: authorId, lp_id: lpId || null })
  if (error) throw new Error(error.message)
}
export async function updateDealComment(id: string, body: string): Promise<void> {
  const { error } = await supabase.from('pipeline_deal_comments')
    .update({ body: body.trim(), edited_at: new Date().toISOString() }).eq('id', id)
  if (error) throw new Error(error.message)
}
export async function deleteDealComment(id: string): Promise<void> {
  const { error } = await supabase.from('pipeline_deal_comments').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// ── one-click Diligence bridge ───────────────────────────────────────────────
/**
 * Open (or create) the deal's due-diligence workspace: a shell property
 * (is_pipeline=true, hidden from AUM) linked via pipeline_deals.dd_property_id.
 * Returns the shell property id — navigate to /diligence?deal=<id>.
 */
export async function openDiligence(deal: Deal): Promise<string> {
  if (deal.ddPropertyId) return deal.ddPropertyId
  const assetType = deal.assetType === 'office' ? 'office' : 'retail'
  const { data: prop, error } = await supabase.from('properties')
    .insert({
      name: deal.name, asset_type: assetType, is_pipeline: true, ownership_type: 'owned',
      city: deal.city, state: deal.state, total_sf: deal.glaSf,
      notes: `DD shell — opened from pipeline deal ${deal.name}`,
    }).select('id').single()
  if (error) throw new Error(error.message)
  const ddId = (prop as any).id as string
  const { error: linkErr } = await supabase.from('pipeline_deals')
    .update({ dd_property_id: ddId, updated_at: new Date().toISOString() }).eq('id', deal.id)
  if (linkErr) throw new Error(linkErr.message)
  return ddId
}

/** Unlink a deal from its diligence workspace (clear dd_property_id). The shell property is left intact. */
export async function unlinkDiligence(dealId: string): Promise<void> {
  const { error } = await supabase.from('pipeline_deals')
    .update({ dd_property_id: null, updated_at: new Date().toISOString() }).eq('id', dealId)
  if (error) throw new Error(error.message)
}

/**
 * Feed a mirrored deal document into the DD workspace: downloads the stored PDF
 * and runs it through doc-inbox (store + extract + index against the shell), so
 * lease abstraction can see it. Returns nothing; throws on failure.
 */
export async function sendDocToDiligence(doc: DealDoc, ddPropertyId: string): Promise<void> {
  if (!doc.signedUrl) throw new Error('Document is not currently viewable')
  const resp = await fetch(doc.signedUrl)
  if (!resp.ok) throw new Error('Could not download the stored copy')
  const buf = new Uint8Array(await resp.arrayBuffer())
  let bin = ''
  for (let j = 0; j < buf.length; j += 0x8000) bin += String.fromCharCode(...buf.subarray(j, j + 0x8000))
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/doc-inbox`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session?.access_token ?? ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: ddPropertyId, file_name: doc.fileName ?? 'document.pdf', pdf_base64: btoa(bin) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || (json as any).error) throw new Error((json as any).error ?? `doc-inbox failed (${res.status})`)
}

export interface IcMemoNarrative {
  headline?: string
  executive_summary?: string
  business_plan?: string
  rationale?: { title: string; body: string }[]
  swot?: { strengths?: string[]; weaknesses?: string[]; opportunities?: string[]; threats?: string[] }
  risks?: { risk: string; mitigant: string }[]
  recommendation?: string
  ask?: string
  major_tenants?: { name: string; sf: number | null; expiration: string | null }[]
}

/** Draft the IC review memo narrative for a deal (ic-memo edge fn). */
export async function generateIcMemo(dealId: string): Promise<IcMemoNarrative> {
  const { data, error } = await supabase.functions.invoke('ic-memo', { body: { dealId } })
  if (error) throw new Error(error.message)
  if ((data as any)?.error) throw new Error((data as any).error)
  return ((data as any)?.memo ?? {}) as IcMemoNarrative
}

export interface UploadedOm { storagePath: string; documentId: string | null; title: string }

/**
 * Upload an OM PDF to the `documents` bucket (pipeline/ prefix) and best-effort
 * file a `documents` row so the OM is retained + linkable. Returns the storage
 * path to hand to extractOm({ storagePath }).
 */
export async function uploadOmPdf(file: File, createdBy: string | null): Promise<UploadedOm> {
  const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80)
  const uid = (globalThis.crypto?.randomUUID?.() ?? String(Date.now()))
  const path = `pipeline/om/${uid}-${safe}`
  const { error: upErr } = await supabase.storage.from('documents')
    .upload(path, file, { contentType: file.type || 'application/pdf', upsert: false })
  if (upErr) throw new Error('Upload failed: ' + upErr.message)

  const title = 'OM — ' + file.name.replace(/\.pdf$/i, '')
  let documentId: string | null = null
  // documents_insert RLS allows admin/AM to file a null-property doc; best-effort.
  const { data: doc } = await supabase.from('documents').insert({
    title, file_name: file.name, storage_path: path, doc_type: 'other',
    file_size_bytes: file.size, property_id: null,
  }).select('id').single()
  if (doc) documentId = (doc as any).id
  return { storagePath: path, documentId, title }
}

/** Create a deal (sourced) from an OM extraction + record the intake row. */
export async function createDealFromExtraction(
  ex: OmExtraction, createdBy: string | null,
  source?: { documentId?: string | null },
): Promise<string> {
  const thesis = (ex.key_points ?? []).slice(0, 4).map(k => '• ' + k).join('\n') || null
  const dealId = await createDeal({
    name: ex.name || 'Untitled OM deal',
    assetType: (ex.asset_type as AssetType) || 'retail',
    riskProfile: (ex.risk_profile as RiskProfile) || 'value_add',
    subType: ex.sub_type ?? null, submarket: ex.submarket ?? null,
    market: [ex.city, ex.state].filter(Boolean).join(', ') || null,
    city: ex.city ?? null, state: ex.state ?? null,
    glaSf: ex.gla_sf ?? null, yearBuilt: ex.year_built ?? null,
    askPrice: ex.asking_price ?? null, priceText: ex.asking_guidance_text ?? null,
    goingInCap: ex.in_place_cap ?? null, thesis, stage: 'sourced',
  }, createdBy)
  await supabase.from('om_intake').insert({
    deal_id: dealId, deal_name: ex.name || 'Untitled OM deal', city: ex.city ?? null, state: ex.state ?? null,
    om_received: true, base_model: 'none', extracted: ex,
    source_document_id: source?.documentId ?? null, created_by: createdBy,
  })
  // Surface the uploaded OM in the deal's Documents tab too (role 'om').
  if (source?.documentId) {
    await supabase.from('pipeline_deal_documents')
      .insert({ deal_id: dealId, document_id: source.documentId, role: 'om', created_by: createdBy })
  }
  return dealId
}

// ── meeting-deck extras (site plans + OM-extracted tenancy) ──────────────────
export interface DeckTenant { name: string; sf: number | null; expiration: string | null }
export interface DeckExtras {
  /** one site-plan PDF per deal, signed for rendering */
  sitePlans: { dealId: string; url: string; title: string | null }[]
  tenants: Record<string, DeckTenant[]>
  occupancy: Record<string, number | null>
}

/**
 * Gather the assets the meeting deck embeds but that don't live on the deal
 * record: the linked site-plan PDF (signed) and the OM-extracted tenant roster +
 * occupancy (stored on om_intake.extracted by scripts/enrich_deals.ps1).
 */
export async function fetchDeckExtras(dealIds: string[]): Promise<DeckExtras> {
  const out: DeckExtras = { sitePlans: [], tenants: {}, occupancy: {} }
  if (!dealIds.length) return out

  // ── site plans: the pre-rendered JPEG (scripts/render_site_plans.ps1) so the
  //    deck embeds an image directly — client-side pdf.js can't rasterize the
  //    vector-dense OM site-plan PDFs fast enough (>15s each on the main thread). ──
  const { data: sp } = await supabase.from('pipeline_deal_documents')
    .select('deal_id, role, documents(title, storage_path, file_size_bytes)')
    .in('deal_id', dealIds).eq('role', 'site_plan_img')
  const byDeal = new Map<string, any>()
  for (const r of (sp ?? []) as any[]) {
    if (!r.documents?.storage_path) continue
    const prev = byDeal.get(r.deal_id)
    if (!prev || (r.documents.file_size_bytes ?? 0) < (prev.documents.file_size_bytes ?? Infinity)) byDeal.set(r.deal_id, r)
  }
  const paths = [...byDeal.values()].map(r => r.documents.storage_path)
  const signed = new Map<string, string>()
  if (paths.length) {
    const { data: s } = await supabase.storage.from('documents').createSignedUrls(paths, 3600)
    for (const it of s ?? []) if (it.path && it.signedUrl) signed.set(it.path, it.signedUrl)
  }
  for (const [dealId, r] of byDeal) {
    const url = signed.get(r.documents.storage_path)
    if (url) out.sitePlans.push({ dealId, url, title: r.documents.title ?? null })
  }

  // ── tenants + occupancy from om_intake.extracted ──
  const { data: om } = await supabase.from('om_intake').select('deal_id, extracted').in('deal_id', dealIds)
  for (const r of (om ?? []) as any[]) {
    const ex = r.extracted
    if (!r.deal_id || !ex) continue
    if (Array.isArray(ex.major_tenants) && ex.major_tenants.length) {
      const roster: DeckTenant[] = ex.major_tenants.map((t: any) => ({ name: String(t.name ?? '—'), sf: t.sf != null ? Number(t.sf) : null, expiration: t.expiration ?? null }))
      // keep the richest roster if multiple om_intake rows exist for the deal
      if (!out.tenants[r.deal_id] || roster.length > out.tenants[r.deal_id].length) out.tenants[r.deal_id] = roster
    }
    if (ex.occupancy != null && out.occupancy[r.deal_id] == null) out.occupancy[r.deal_id] = Number(ex.occupancy)
  }
  return out
}

// ── metrics ──────────────────────────────────────────────────────────────────
export interface PipelineMetrics {
  activeCount: number; activeVolume: number; weighted: number; activeSf: number
  committed: number; soft: number; closedCount: number; closedVolume: number
}
export function pipelineMetrics(deals: Deal[]): PipelineMetrics {
  let activeCount = 0, activeVolume = 0, weighted = 0, activeSf = 0, committed = 0, soft = 0, closedCount = 0, closedVolume = 0
  for (const d of deals) {
    if (d.stage === 'closed') { closedCount++; closedVolume += d.askPrice ?? 0; continue }
    if (!isActiveStage(d.stage)) continue   // excludes watchlist + terminal
    activeCount++; activeVolume += d.askPrice ?? 0; weighted += (d.askPrice ?? 0) * d.probability; activeSf += d.glaSf ?? 0
    for (const l of d.lps) { committed += l.committedAmount ?? 0; soft += l.softAmount ?? 0 }
  }
  return { activeCount, activeVolume, weighted, activeSf, committed, soft, closedCount, closedVolume }
}
