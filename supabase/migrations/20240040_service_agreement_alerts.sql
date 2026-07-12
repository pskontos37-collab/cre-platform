-- 20240040_service_agreement_alerts.sql
-- Canonical server-side definition of "which service agreement governs, and is
-- it a renewal risk" — the single source of truth shared by the /services panel,
-- the dashboard widget, and the email digest edge function (no logic drift).
--
-- (1) service_agreement_alerts view: one row per property+vendor+category, the
--     LATEST contract governing (by end_date, then agreement/start), excluding
--     terminated/superseded, with days_until + is_expired computed. security_invoker
--     so an authenticated user only sees their entitled properties (RLS on the
--     underlying tables applies); the service role (edge function) sees all.
-- (2) service_agreement_alert_log: what the digest sent and when (dedupe + audit).

create or replace view public.service_agreement_alerts
with (security_invoker = true) as
with governing as (
  select distinct on (
      s.property_id,
      lower(regexp_replace(s.vendor, '[^a-zA-Z0-9]', '', 'g')),
      s.service_category
    ) s.*
  from public.service_agreements s
  where s.status not in ('terminated', 'superseded')
  order by
    s.property_id,
    lower(regexp_replace(s.vendor, '[^a-zA-Z0-9]', '', 'g')),
    s.service_category,
    coalesce(s.end_date, s.agreement_date, s.start_date) desc nulls last
)
select
  g.id,
  g.property_id,
  p.name           as property_name,
  g.vendor,
  g.service_category,
  g.end_date,
  g.auto_renews,
  g.annual_value,
  g.status,
  case when g.end_date is not null then (g.end_date - current_date) end as days_until,
  (g.end_date is not null and g.end_date < current_date)                as is_expired
from governing g
join public.properties p on p.id = g.property_id;

grant select on public.service_agreement_alerts to authenticated, service_role;

create table if not exists public.service_agreement_alert_log (
  id uuid primary key default uuid_generate_v4(),
  sent_at        timestamptz not null default now(),
  recipients     text[]      not null default '{}',
  horizon_days   int,
  expiring_count int,
  expired_count  int,
  agreement_ids  uuid[]      not null default '{}',
  test           boolean     not null default false,
  ok             boolean     not null default true,
  detail         text
);

alter table public.service_agreement_alert_log enable row level security;
create policy "sa_alert_log_read"  on public.service_agreement_alert_log
  for select using (public.is_admin_or_am());
create policy "sa_alert_log_write" on public.service_agreement_alert_log
  for all using (public.is_admin_or_am());
grant select, insert on public.service_agreement_alert_log to authenticated, service_role;

notify pgrst, 'reload schema';
