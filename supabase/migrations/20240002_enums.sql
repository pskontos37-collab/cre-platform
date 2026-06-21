create type asset_type as enum ('retail', 'office');
create type lease_status as enum ('active', 'expired', 'pending', 'terminated');
create type recovery_method as enum ('nnn', 'gross', 'modified_gross', 'base_year_stop', 'expense_stop');
create type unit_status as enum ('occupied', 'vacant', 'under_negotiation');
create type option_type as enum ('renewal', 'expansion', 'contraction', 'termination', 'rofo', 'rofr');
create type co_tenancy_clause_type as enum ('anchor_dark', 'occupancy_threshold', 'named_tenant');
create type co_tenancy_remedy as enum ('rent_reduction', 'percentage_rent_only', 'termination_right');
create type co_tenancy_flag_status as enum ('pending_review', 'confirmed', 'dismissed');
create type period_type as enum ('monthly', 'quarterly', 'annual');
create type financial_source as enum ('manual', 'import', 'mri', 'yardi');
create type operating_category as enum (
  'base_rent', 'percentage_rent', 'cam_recovery', 'other_income',
  'operating_expenses', 'management_fee', 'taxes', 'insurance',
  'utilities', 'repairs_maintenance', 'capital_expenditure', 'other_expense'
);
create type rate_type as enum ('fixed', 'floating');
create type import_type as enum ('operating_statement', 'rent_roll', 'budget', 'rent_schedule');
create type import_status as enum ('pending', 'mapping', 'processing', 'complete', 'failed');
create type waterfall_tier_type as enum (
  'return_of_capital', 'preferred_return', 'gp_catchup', 'promote_split'
);
create type capital_account_type as enum ('common_equity', 'preferred_equity');
create type investor_entity_type as enum ('lp', 'gp', 'preferred_equity', 'institutional');
create type doc_type as enum (
  'lease', 'operating_statement', 'rent_roll', 'budget',
  'loan_agreement', 'jv_agreement', 'psa', 'title',
  'estoppel', 'inspection', 'tax', 'other'
);
create type inspection_type as enum ('routine', 'capital', 'environmental', 'fire_life_safety', 'other');
create type condition_rating as enum ('excellent', 'good', 'fair', 'poor');
create type critical_date_type as enum (
  'option_notice_deadline', 'lease_expiration', 'rent_commencement',
  'free_rent_end', 'escalation', 'loan_maturity', 'tax_appeal_deadline', 'inspection_due', 'other'
);
create type user_role as enum ('admin', 'asset_manager', 'property_manager');
create type entitlement_scope as enum ('global', 'portfolio', 'property', 'fund');
create type audit_action as enum ('read', 'create', 'update', 'delete', 'login', 'export', 'ai_query');
