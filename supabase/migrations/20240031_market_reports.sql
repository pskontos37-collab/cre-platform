-- 20240031_market_reports.sql
-- Third-party market reports found on the public web (brokerage research,
-- cap-rate surveys, metro economic data) fetched on demand per property by
-- the market-reports edge function. One row per report link; a re-fetch
-- replaces the property's rows so the list always reflects the latest search.

create table if not exists public.market_reports (
  id uuid primary key default uuid_generate_v4(),
  property_id uuid not null references public.properties(id) on delete cascade,
  market text not null,                 -- e.g. "Raleigh, NC — retail"
  title text not null,
  publisher text,                       -- CBRE, JLL, Cushman & Wakefield, ...
  period text,                          -- e.g. "Q1 2026", "2026 Outlook"
  url text not null,
  summary text,
  report_type text,                     -- market_report | research_note | news | data_page
  fetched_at timestamptz not null default now(),
  unique (property_id, url)
);

alter table public.market_reports enable row level security;
create policy "market_reports_select" on public.market_reports
  for select using (public.can_access_property(property_id));
create policy "market_reports_write" on public.market_reports
  for all using (public.is_admin_or_am());

grant select, insert, update, delete on public.market_reports to authenticated;
