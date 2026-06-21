-- ============================================================
-- INDEXES for common query patterns
-- ============================================================

create index idx_properties_portfolio_id   on properties(portfolio_id);
create index idx_properties_asset_type     on properties(asset_type);
create index idx_units_property_id         on units(property_id);
create index idx_leases_property_id        on leases(property_id);
create index idx_leases_tenant_id          on leases(tenant_id);
create index idx_leases_expiration_date    on leases(expiration_date);
create index idx_leases_status             on leases(status);
create index idx_critical_dates_property_id on critical_dates(property_id);
create index idx_critical_dates_due_date   on critical_dates(due_date);
create index idx_critical_dates_completed  on critical_dates(is_completed);
create index idx_financial_periods_prop_id on financial_periods(property_id);
create index idx_financial_periods_start   on financial_periods(period_start);
create index idx_oli_financial_period_id   on operating_line_items(financial_period_id);
create index idx_oli_category              on operating_line_items(category);
create index idx_loans_property_id         on loans(property_id);
create index idx_loans_maturity_date       on loans(maturity_date);
create index idx_deals_property_id         on deals(property_id);
create index idx_waterfall_tiers_deal_id   on waterfall_tiers(deal_id, tier_order);
create index idx_capital_accounts_deal_id  on capital_accounts(deal_id);
create index idx_documents_property_id     on documents(property_id);
create index idx_documents_doc_type        on documents(doc_type);
create index idx_documents_is_indexed      on documents(is_indexed);
create index idx_document_chunks_doc_id    on document_chunks(document_id);
-- Vector similarity index — uncomment after loading first batch of embeddings:
-- create index idx_document_chunks_embedding on document_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index idx_entitlements_user_id      on entitlements(user_id);
create index idx_entitlements_property_id  on entitlements(property_id);
create index idx_audit_log_user_id         on audit_log(user_id);
create index idx_audit_log_created_at      on audit_log(created_at desc);
create index idx_audit_log_entity          on audit_log(entity_type, entity_id);
