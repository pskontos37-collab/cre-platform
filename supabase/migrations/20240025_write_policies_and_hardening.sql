-- 20240025_write_policies_and_hardening.sql
-- Follow-ups from the 2026-07-03 functional audit.

-- 1) critical_dates: ManagementPage "Add to calendar" INSERTs (and future
--    complete/edit actions) were rejected — RLS enabled with a SELECT-only
--    policy. Matches the ma_write / mad_write pattern.
drop policy if exists "critical_dates_write" on public.critical_dates;
create policy "critical_dates_write" on public.critical_dates
  for insert with check (public.is_admin_or_am());
drop policy if exists "critical_dates_update" on public.critical_dates;
create policy "critical_dates_update" on public.critical_dates
  for update using (public.is_admin_or_am());

-- 2) co_tenancy_flags: the widget's Confirm/Dismiss buttons UPDATE status but
--    only a SELECT policy existed — updates silently matched 0 rows.
drop policy if exists "co_tenancy_flags_update" on public.co_tenancy_flags;
create policy "co_tenancy_flags_update" on public.co_tenancy_flags
  for update using (public.is_admin_or_am());

-- 3) account_invoices: add a unique ORDER BY tiebreaker (i.id) so PostgREST
--    .range() pagination can never duplicate/skip rows on
--    (posting_date, amount) ties. gl_transactions already ends with ", id".
create or replace function public.account_invoices(
  p_property uuid, p_account_code text,
  p_year integer default null, p_month integer default null
)
returns table(
  invoice_id uuid, vendor text, invoice_number text, invoice_date date,
  posting_date date, amount numeric, gl_account_code text, gl_account_desc text,
  memo text, image_url text, invoice_url text
)
language sql stable
as $function$
  select i.id, v.name, i.invoice_number, i.invoice_date, i.posting_date,
         d.amount, d.gl_account_code, d.gl_account_desc, i.memo, i.image_url, i.invoice_url
  from public.invoice_distributions d
  join public.invoices i on i.id = d.invoice_id
  left join public.vendors v on v.id = i.vendor_id
  where d.property_id = p_property
    and d.gl_account_code = p_account_code
    and (p_year  is null or extract(year  from i.posting_date)::int = p_year)
    and (p_month is null or extract(month from i.posting_date)::int = p_month)
  order by i.posting_date desc nulls last, d.amount desc, i.id;
$function$;

-- 4) GL P&L views are definer views (bypass base-table RLS); the anon role
--    could read the entire portfolio's monthly P&L without logging in, and
--    held inert write grants. Internal financial tool — anon gets nothing.
revoke all on public.v_gl_pnl_monthly  from anon;
revoke all on public.v_gl_pnl_category from anon;
revoke insert, update, delete, truncate, references, trigger on public.v_gl_pnl_monthly  from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.v_gl_pnl_category from authenticated;
revoke all on public.v_vendor_spend from anon;
revoke all on public.v_gl_account_summary from anon;
revoke all on public.v_possible_duplicate_invoices from anon;

-- 5) Data correction (waterfall model): the three Layer-2 syndication deals
--    seeded REAL investor IRR preferences as tier_type='preferred_return',
--    which the engine no-ops without priority capital — GP promote was
--    overstated 2-12x. An IRR pref is exactly a hurdled promote tier that
--    pays LP 100% until the hurdle IRR is met, which the solver handles.
update public.waterfall_tiers
set tier_type = 'promote_split', lp_split_pct = 1.0, gp_split_pct = 0.0
where id in (
  'd0c30c59-9a88-4037-a827-1ff94c7c40c3',  -- Gateway L2: Class A/C 16% IRR pref
  'd66aa3a1-752c-45da-b5b4-f7f74fdc2030',  -- Knightdale L2: Class A 12% IRR pref
  '517105d0-62ec-4bda-bb02-bc84eb43d8d8'   -- Magnolia L2: Class A 10% IRR pref
);
