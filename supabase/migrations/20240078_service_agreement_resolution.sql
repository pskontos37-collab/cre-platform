-- 20240078_service_agreement_resolution.sql
-- Manually dismiss a service agreement from renewal tracking: mark it
-- completed (one-time job finished), cancelled, or ignored. Cancelled and
-- ignored REQUIRE an audit note; completed is self-explanatory (who/when is
-- still recorded). Dedicated columns (not a `status` value) so the extraction
-- loader's merge-duplicates upserts (extract_service_agreements.ps1 -Load)
-- can never clobber a dismissal — the loader never sends these fields.
-- `status` ('terminated'/'superseded') stays loader/pipeline territory;
-- `resolution` is user territory.
--
-- Audit trail is two-layer:
--   (a) the row keeps resolution / resolution_reason / resolved_by(_name) /
--       resolved_at while resolved (reason NOT NULL-enforced by CHECK for
--       cancelled + ignored), and
--   (b) a scoped trigger writes every resolve/restore transition to audit_log
--       (old + new jsonb), so notes survive restores and re-resolves.
--       Scoped WHEN clause keeps loader re-runs out of the audit log.
--
-- The service_agreement_alerts view (widget + email digest source of truth)
-- computes the governing contract per relationship FIRST, then drops the
-- relationship when its governing row is resolved — filtering inside the
-- DISTINCT ON would instead promote a prior-year expired contract back into
-- the alerts, defeating the dismissal.

alter table public.service_agreements
  add column if not exists resolution text,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by uuid references public.users(id) on delete set null,
  add column if not exists resolved_by_name text,
  add column if not exists resolution_reason text;

alter table public.service_agreements
  drop constraint if exists service_agreements_resolution_valid;
alter table public.service_agreements
  add constraint service_agreements_resolution_valid
  check (resolution is null or resolution in ('completed', 'cancelled', 'ignored'));

-- resolution and resolved_at travel together
alter table public.service_agreements
  drop constraint if exists service_agreements_resolution_consistent;
alter table public.service_agreements
  add constraint service_agreements_resolution_consistent
  check ((resolution is null) = (resolved_at is null));

-- cancelled / ignored demand a non-empty audit note; completed does not
alter table public.service_agreements
  drop constraint if exists service_agreements_resolution_reason_required;
alter table public.service_agreements
  add constraint service_agreements_resolution_reason_required
  check (
    resolution is null
    or resolution = 'completed'
    or (resolution_reason is not null and length(btrim(resolution_reason)) > 0)
  );

drop trigger if exists audit_service_agreement_resolution on public.service_agreements;
create trigger audit_service_agreement_resolution
  after update on public.service_agreements
  for each row
  when (old.resolution is distinct from new.resolution
     or old.resolution_reason is distinct from new.resolution_reason)
  execute procedure public.log_mutation();

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
join public.properties p on p.id = g.property_id
where g.resolution is null;

grant select on public.service_agreement_alerts to authenticated, service_role;

notify pgrst, 'reload schema';
