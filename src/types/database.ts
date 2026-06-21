// ── Enums ──────────────────────────────────────────────────────────────────

export type AssetType = 'retail' | 'office'
export type LeaseStatus = 'active' | 'expired' | 'pending' | 'terminated'
export type RecoveryMethod = 'nnn' | 'gross' | 'modified_gross' | 'base_year_stop' | 'expense_stop'
export type OptionType = 'renewal' | 'expansion' | 'contraction' | 'termination' | 'rofo' | 'rofr'
export type CoTenancyClauseType = 'anchor_dark' | 'occupancy_threshold' | 'named_tenant'
export type CoTenancyRemedy = 'rent_reduction' | 'percentage_rent_only' | 'termination_right'
export type CoTenancyFlagStatus = 'pending_review' | 'confirmed' | 'dismissed'
export type OperatingCategory =
  | 'base_rent'
  | 'percentage_rent'
  | 'cam_recovery'
  | 'other_income'
  | 'operating_expenses'
  | 'management_fee'
  | 'taxes'
  | 'insurance'
  | 'utilities'
  | 'repairs_maintenance'
  | 'capital_expenditure'
  | 'other_expense'
export type WaterfallTierType =
  | 'return_of_capital'
  | 'preferred_return'
  | 'gp_catchup'
  | 'promote_split'
export type CapitalAccountType = 'common_equity' | 'preferred_equity'
export type UserRole = 'admin' | 'asset_manager' | 'property_manager'
export type EntitlementScope = 'global' | 'portfolio' | 'property' | 'fund'
export type AuditAction = 'read' | 'create' | 'update' | 'delete' | 'login' | 'export' | 'ai_query'
export type DocType =
  | 'lease'
  | 'operating_statement'
  | 'rent_roll'
  | 'budget'
  | 'loan_agreement'
  | 'jv_agreement'
  | 'psa'
  | 'title'
  | 'estoppel'
  | 'inspection'
  | 'tax'
  | 'other'
export type InspectionType = 'routine' | 'capital' | 'environmental' | 'fire_life_safety' | 'other'
export type ConditionRating = 'excellent' | 'good' | 'fair' | 'poor'
export type CriticalDateType =
  | 'option_notice_deadline'
  | 'lease_expiration'
  | 'rent_commencement'
  | 'free_rent_end'
  | 'escalation'
  | 'loan_maturity'
  | 'tax_appeal_deadline'
  | 'inspection_due'
  | 'other'

// ── Group A: Portfolio & Properties ───────────────────────────────────────

export interface Portfolio {
  id: string
  name: string
  description: string | null
  created_at: string
}

export interface Property {
  id: string
  portfolio_id: string | null
  name: string
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  asset_type: AssetType
  total_sf: number | null
  year_built: number | null
  acquisition_date: string | null
  acquisition_price: number | null
  current_value: number | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface Unit {
  id: string
  property_id: string
  unit_number: string
  floor: string | null
  rentable_sf: number | null
  usable_sf: number | null
  unit_type: string | null
  is_anchor: boolean
  status: 'occupied' | 'vacant' | 'under_negotiation'
  created_at: string
  updated_at: string
}

// ── Group B: Tenants & Leases ──────────────────────────────────────────────

export interface Tenant {
  id: string
  name: string
  trade_name: string | null
  industry: string | null
  credit_rating: string | null
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface Lease {
  id: string
  property_id: string
  unit_id: string | null
  tenant_id: string
  document_id: string | null
  lease_type: 'retail' | 'office'
  status: LeaseStatus
  lease_number: string | null
  commencement_date: string | null
  expiration_date: string | null
  rent_commencement_date: string | null
  free_rent_months: number
  leased_sf: number | null
  recovery_method: RecoveryMethod | null
  base_year: number | null
  expense_stop_amount: number | null
  security_deposit: number | null
  ti_allowance: number | null
  ti_allowance_paid: number | null
  has_percentage_rent: boolean
  percentage_rent_rate: number | null
  natural_breakpoint: number | null
  artificial_breakpoint: number | null
  has_exclusives: boolean
  has_co_tenancy_clause: boolean
  has_radius_restriction: boolean
  radius_restriction_miles: number | null
  sublease_allowed: boolean | null
  assignment_allowed: boolean | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface LeaseRentSchedule {
  id: string
  lease_id: string
  effective_date: string
  annual_rent: number
  rent_per_sf: number | null
  escalation_type: string | null
  escalation_value: number | null
  created_at: string
}

export interface LeaseOption {
  id: string
  lease_id: string
  option_type: OptionType
  notice_days_required: number | null
  notice_deadline: string | null
  exercise_deadline: string | null
  term_if_exercised_months: number | null
  rent_at_exercise: string | null
  is_exercised: boolean
  notes: string | null
  created_at: string
}

export interface CoTenancyClause {
  id: string
  lease_id: string
  clause_type: CoTenancyClauseType
  anchor_tenant_id: string | null
  occupancy_threshold_pct: number | null
  named_tenant_id: string | null
  remedy: CoTenancyRemedy
  remedy_rent_pct: number | null
  cure_period_days: number | null
  is_triggered: boolean
  created_at: string
  updated_at: string
}

export interface CoTenancyFlag {
  id: string
  co_tenancy_clause_id: string
  property_id: string
  triggered_at: string
  trigger_reason: string
  remedy_description: string | null
  source_document_ids: string[] | null
  status: CoTenancyFlagStatus
  reviewed_by: string | null
  reviewed_at: string | null
  notes: string | null
}

export interface CriticalDate {
  id: string
  property_id: string
  lease_id: string | null
  loan_id: string | null
  date_type: CriticalDateType
  due_date: string
  description: string | null
  is_completed: boolean
  alert_days_before: number[] | null
  created_at: string
}

// ── Group C: Financials ────────────────────────────────────────────────────

export interface FinancialPeriod {
  id: string
  property_id: string
  period_start: string
  period_end: string
  period_type: 'monthly' | 'quarterly' | 'annual'
  is_budget: boolean
  source: 'manual' | 'import' | 'mri' | 'yardi'
  import_job_id: string | null
  created_at: string
}

export interface OperatingLineItem {
  id: string
  financial_period_id: string
  category: OperatingCategory
  line_name: string
  amount: number
  unit_id: string | null
  tenant_id: string | null
  notes: string | null
  created_at: string
}

export interface Loan {
  id: string
  property_id: string
  lender_name: string | null
  loan_amount: number | null
  outstanding_balance: number | null
  interest_rate: number | null
  rate_type: 'fixed' | 'floating'
  origination_date: string | null
  maturity_date: string | null
  amortization_years: number | null
  io_period_months: number | null
  annual_debt_service: number | null
  dscr_covenant: number | null
  ltv_covenant: number | null
  notes: string | null
  document_id: string | null
  created_at: string
  updated_at: string
}

export interface LoanCovenantCheck {
  id: string
  loan_id: string
  checked_at: string
  trailing_12_noi: number | null
  annual_debt_svc: number | null
  dscr_actual: number | null
  dscr_covenant: number | null
  headroom: number | null
  is_breach: boolean
  created_at: string
}

export interface ImportJob {
  id: string
  property_id: string
  created_by: string | null
  created_at: string
  file_name: string | null
  import_type: 'operating_statement' | 'rent_roll' | 'budget' | 'rent_schedule'
  status: 'pending' | 'mapping' | 'processing' | 'complete' | 'failed'
  column_mapping: Record<string, string> | null
  row_count: number | null
  error_log: unknown | null
}

// ── Group D: Capital Stack & Waterfall ────────────────────────────────────

export interface Fund {
  id: string
  name: string
  fund_type: string
  vintage_year: number | null
  target_return: number | null
  notes: string | null
  created_at: string
}

export interface Investor {
  id: string
  name: string
  entity_type: 'lp' | 'gp' | 'preferred_equity' | 'institutional'
  contact_info: Record<string, unknown> | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface Deal {
  id: string
  property_id: string
  fund_id: string | null
  name: string
  closing_date: string | null
  total_equity: number | null
  gp_equity: number | null
  lp_equity: number | null
  preferred_equity_amount: number | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface WaterfallTier {
  id: string
  deal_id: string
  tier_order: number
  tier_type: WaterfallTierType
  description: string | null
  hurdle_irr: number | null
  pref_rate: number | null
  lp_split_pct: number | null
  gp_split_pct: number | null
  is_cumulative: boolean
  is_pik: boolean
  created_at: string
}

export interface PreferredEquityPosition {
  id: string
  deal_id: string
  investor_id: string
  principal_amount: number
  preferred_rate: number
  is_pik: boolean
  accrued_return: number
  redemption_date: string | null
  is_redeemed: boolean
  priority_rank: number
  created_at: string
  updated_at: string
}

export interface CapitalAccount {
  id: string
  deal_id: string
  investor_id: string
  account_type: CapitalAccountType
  initial_contribution: number
  current_balance: number
  contributed_to_date: number
  distributed_to_date: number
  pref_accrued_to_date: number
  is_pref_redeemed: boolean
  opened_at: string
  closed_at: string | null
  created_at: string
  updated_at: string
}

export interface Distribution {
  id: string
  deal_id: string
  distribution_date: string
  total_available: number
  waterfall_snapshot: unknown | null
  created_at: string
}

export interface DistributionLineItem {
  id: string
  distribution_id: string
  capital_account_id: string
  waterfall_tier_id: string | null
  investor_id: string
  amount: number
  tier_type: WaterfallTierType | null
  notes: string | null
  created_at: string
}

// ── Group E: Documents & Inspections ──────────────────────────────────────

export interface Document {
  id: string
  property_id: string | null
  tenant_id: string | null
  loan_id: string | null
  doc_type: DocType
  title: string
  file_path: string | null
  file_name: string | null
  mime_type: string | null
  file_size_bytes: number | null
  version: number
  superseded_by: string | null
  upload_date: string | null
  uploaded_by: string | null
  is_indexed: boolean
  notes: string | null
  created_at: string
}

export interface Inspection {
  id: string
  property_id: string
  document_id: string | null
  inspected_by: string | null
  inspection_date: string
  inspection_type: InspectionType
  summary: string | null
  condition_rating: ConditionRating | null
  uploaded_by: string | null
  created_at: string
}

// ── Group F: Users & Access ────────────────────────────────────────────────

export interface User {
  id: string
  email: string
  full_name: string | null
  role: UserRole
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface Entitlement {
  id: string
  user_id: string
  scope: EntitlementScope
  portfolio_id: string | null
  property_id: string | null
  fund_id: string | null
  investor_id: string | null
  can_read: boolean
  can_write: boolean
  can_upload: boolean
  granted_by: string | null
  granted_at: string
}

export interface AuditLog {
  id: string
  user_id: string | null
  action: AuditAction
  entity_type: string | null
  entity_id: string | null
  property_id: string | null
  detail: unknown | null
  ip_address: string | null
  user_agent: string | null
  created_at: string
}
