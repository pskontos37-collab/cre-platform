-- ============================================================
-- PHASE 3.5 — Drill-down + analytics layer over GL + invoices
-- Views: vendor spend, GL account-month rollup, duplicate-invoice flags
-- RPCs: account_invoices (leaf), gl_transactions (mid layer)
-- Chain: IS line (account_name) -> GL account-month -> invoices -> image
-- All re-runnable (create or replace). security_invoker => RLS applies to caller.
-- ============================================================

-- ── Vendor spend rollup (per property) ───────────────────────
create or replace view public.v_vendor_spend with (security_invoker = true) as
  select i.property_id,
         i.vendor_id,
         v.name                       as vendor,
         count(distinct i.id)         as invoice_count,
         sum(d.amount)                as total_spend,
         min(i.posting_date)          as first_invoice,
         max(i.posting_date)          as last_invoice
  from public.invoice_distributions d
  join public.invoices i on i.id = d.invoice_id
  left join public.vendors v on v.id = i.vendor_id
  group by i.property_id, i.vendor_id, v.name;

-- ── GL account x month rollup (trend + IS/invoice join target) ──
create or replace view public.v_gl_account_monthly with (security_invoker = true) as
  select property_id,
         entity_code,
         account_code,
         account_name,
         period_year,
         period_month,
         sum(debit)              as debit,
         sum(credit)             as credit,
         sum(debit) - sum(credit) as net,
         count(*)                as txn_count
  from public.gl_entries
  where not is_balance_forward
  group by property_id, entity_code, account_code, account_name, period_year, period_month;

-- ── Possible duplicate payments (same vendor + amount + invoice date) ──
-- Tighter than vendor+amount alone, which floods with legitimate recurring
-- identical charges (monthly mgmt fee, landscaping). Same DATE too => real signal.
drop view if exists public.v_possible_duplicate_invoices;
create view public.v_possible_duplicate_invoices with (security_invoker = true) as
  select i.property_id,
         i.vendor_id,
         v.name                     as vendor,
         i.invoice_total,
         i.invoice_date,
         count(*)                   as occurrences,
         array_agg(i.invoice_number order by i.invoice_number) as invoice_numbers,
         array_agg(i.id)            as invoice_ids
  from public.invoices i
  left join public.vendors v on v.id = i.vendor_id
  where i.invoice_total is not null and i.invoice_total <> 0 and i.invoice_date is not null
  group by i.property_id, i.vendor_id, v.name, i.invoice_total, i.invoice_date
  having count(distinct i.avid_invoice_id) > 1;

-- ── RPC: invoices behind a GL account (the drill-down leaf) ──
create or replace function public.account_invoices(
  p_property uuid,
  p_account_code text,
  p_year  int default null,
  p_month int default null
) returns table (
  invoice_id      uuid,
  vendor          text,
  invoice_number  text,
  invoice_date    date,
  posting_date    date,
  amount          numeric,
  gl_account_code text,
  gl_account_desc text,
  memo            text,
  image_url       text,
  invoice_url     text
) language sql stable security invoker as $$
  select i.id, v.name, i.invoice_number, i.invoice_date, i.posting_date,
         d.amount, d.gl_account_code, d.gl_account_desc, i.memo, i.image_url, i.invoice_url
  from public.invoice_distributions d
  join public.invoices i on i.id = d.invoice_id
  left join public.vendors v on v.id = i.vendor_id
  where d.property_id = p_property
    and d.gl_account_code = p_account_code
    and (p_year  is null or extract(year  from i.posting_date)::int = p_year)
    and (p_month is null or extract(month from i.posting_date)::int = p_month)
  order by i.posting_date desc nulls last, d.amount desc;
$$;

-- ── RPC: GL transactions for an account/period (the mid layer) ──
create or replace function public.gl_transactions(
  p_property uuid,
  p_account_code text,
  p_year  int default null,
  p_month int default null
) returns table (
  entry_date  date,
  period      text,
  source_code text,
  reference   text,
  description text,
  debit       numeric,
  credit      numeric,
  balance     numeric
) language sql stable security invoker as $$
  select entry_date, period, source_code, reference, description, debit, credit, balance
  from public.gl_entries
  where property_id = p_property
    and account_code = p_account_code
    and (p_year  is null or period_year  = p_year)
    and (p_month is null or period_month = p_month)
    and not is_balance_forward
  order by entry_date nulls last, id;
$$;
