-- ============================================================
-- Windowed vendor spend for the Financials panel.
-- One RPC replaces the fixed v_vendor_spend / v_vendor_spend_ttm views for the
-- per-property widget: the caller passes a cutoff date (p_since) and gets AP
-- spend on/after it. NULL cutoff => since acquisition (all time). The frontend
-- computes the cutoff for 30/60/90-day, YTD, and TTM windows.
-- security invoker => RLS on invoices/invoice_distributions applies to the caller.
-- ============================================================

create or replace function public.vendor_spend_window(
  p_property uuid,
  p_since    date default null
) returns table (
  vendor         text,
  invoice_count  bigint,
  total_spend    numeric,
  first_invoice  date,
  last_invoice   date
) language sql stable security invoker as $$
  select v.name                 as vendor,
         count(distinct i.id)   as invoice_count,
         sum(d.amount)          as total_spend,
         min(i.posting_date)    as first_invoice,
         max(i.posting_date)    as last_invoice
  from public.invoice_distributions d
  join public.invoices i on i.id = d.invoice_id
  left join public.vendors v on v.id = i.vendor_id
  where d.property_id = p_property
    and (p_since is null or i.posting_date >= p_since)
  group by i.vendor_id, v.name
  order by total_spend desc nulls last;
$$;

grant execute on function public.vendor_spend_window(uuid, date) to authenticated;
