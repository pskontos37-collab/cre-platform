-- ============================================================
-- GL account summary view — powers the Financials account browser.
-- One row per property/account with lifetime totals + activity span.
-- security_invoker => RLS of gl_entries applies to the caller.
-- ============================================================
create or replace view public.v_gl_account_summary with (security_invoker = true) as
  select property_id,
         entity_code,
         account_code,
         account_name,
         sum(debit)               as total_debit,
         sum(credit)              as total_credit,
         sum(debit) - sum(credit) as net,
         count(*)                 as txn_count,
         min(entry_date)          as first_date,
         max(entry_date)          as last_date
  from public.gl_entries
  where not is_balance_forward
  group by property_id, entity_code, account_code, account_name;
