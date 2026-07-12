-- 20240075_insurance_coi.sql
-- Certificate of Insurance (COI) tracker. Built to REPLACE Ebix/CertFocus:
-- own the requirement-matching, verification, collection outreach, and audit
-- trail in-house across tenants, service vendors, and TI/construction contractors.
--
-- Party model is DENORMALIZED (party_type + party_name), like tenant_contacts /
-- lease_abstracts, because not every insured party has a structured row:
--   'tenant'     -> optional tenant_id / lease_id
--   'vendor'     -> optional service_agreement_id
--   'contractor' -> TI / construction; usually no structured row (name only)
--
-- Requirement sources:
--   tenant     = the lease insurance article (structured limits pulled by the
--                extended lease abstractor)
--   vendor/TI  = per-property "Exhibit B Insurance Requirements" (owner + M&J
--                Wilkow mgmt agent + lender as additional insureds; CG 20 10;
--                primary & non-contributory; $2M CGL; WC + $500K EL; A.M. Best
--                A:X; 30-day notice; deductible <= $10K).
--
-- Shared truth: the coi_compliance view (governing cert per party + deficiency
-- computation) is the single definition used by the /insurance page, dashboard
-- widget, and the digest edge function — mirrors service_agreement_alerts so no
-- logic drift.

-- ---------------------------------------------------------------------------
-- (1) Requirement templates. One parent per scope + child coverage lines.
-- ---------------------------------------------------------------------------
create table if not exists public.insurance_requirements (
  id                       uuid primary key default uuid_generate_v4(),
  property_id              uuid not null references public.properties(id) on delete cascade,
  -- who this requirement set applies to
  party_type               text not null
                             check (party_type in ('tenant','vendor','contractor')),
  -- scope: a property-wide default, or an override for one specific party
  scope                    text not null default 'property_default'
                             check (scope in ('property_default','lease','contract','party')),
  lease_id                 uuid references public.leases(id) on delete cascade,
  service_agreement_id     uuid references public.service_agreements(id) on delete cascade,
  party_name               text,   -- for 'party' scope with no structured row
  -- endorsement / structural requirements
  additional_insureds      text[] not null default '{}',   -- required AI entities (owner, mgr, lender)
  additional_insured_form  text,   -- e.g. 'CG 20 10' / 'CG 20 11' / 'CG 20 37'
  requires_primary_noncontrib boolean not null default true,
  requires_waiver_subrogation boolean not null default true,
  min_am_best_rating       text,   -- e.g. 'A:X'
  cancellation_notice_days int  default 30,
  max_deductible           numeric,
  max_sir                  numeric,   -- max allowed self-insured retention
  certificate_holder       text,   -- required exact cert-holder block
  source                   text not null default 'manual'
                             check (source in ('manual','ai_extraction','exhibit_import','ebix_import')),
  source_doc_ids           uuid[],
  source_section           text,   -- lease section / exhibit cited
  notes                    text,
  active                   boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index if not exists insurance_requirements_prop on public.insurance_requirements(property_id);
create index if not exists insurance_requirements_lease on public.insurance_requirements(lease_id);
create index if not exists insurance_requirements_svc on public.insurance_requirements(service_agreement_id);

-- Required coverage lines (one per coverage type in the requirement set).
create table if not exists public.insurance_requirement_coverages (
  id                uuid primary key default uuid_generate_v4(),
  requirement_id    uuid not null references public.insurance_requirements(id) on delete cascade,
  coverage_type     text not null
                      check (coverage_type in (
                        'cgl','auto','umbrella_excess','workers_comp','employers_liability',
                        'property','business_interruption','liquor','pollution','professional_eo',
                        'builders_risk','garagekeepers','crime','cyber','other')),
  min_each_occurrence numeric,
  min_aggregate       numeric,
  min_other           numeric,   -- e.g. EL per-accident, umbrella limit
  required            boolean not null default true,
  notes               text,
  created_at          timestamptz not null default now()
);
create index if not exists insurance_req_cov_req on public.insurance_requirement_coverages(requirement_id);

-- ---------------------------------------------------------------------------
-- (2) Received certificates + their coverage lines.
-- ---------------------------------------------------------------------------
create table if not exists public.coi_certificates (
  id                   uuid primary key default uuid_generate_v4(),
  property_id          uuid not null references public.properties(id) on delete cascade,
  party_type           text not null check (party_type in ('tenant','vendor','contractor')),
  party_name           text not null,
  tenant_id            uuid references public.tenants(id) on delete set null,
  lease_id             uuid references public.leases(id) on delete set null,
  service_agreement_id uuid references public.service_agreements(id) on delete set null,
  requirement_id       uuid references public.insurance_requirements(id) on delete set null,
  document_id          uuid references public.documents(id) on delete set null,
  ebix_vendor_num      text,   -- Ebix 'MJ0000####' id for reconciliation during cutover
  -- certificate face
  cert_type            text default 'acord25'
                         check (cert_type in ('acord25','acord28','evidence_property','other')),
  insured_name         text,
  insured_address      text,
  producer_name        text,   -- broker / agent
  producer_email       text,
  producer_phone       text,
  effective_date       date,
  expiration_date      date,   -- earliest expiration across policies (drives lifecycle)
  -- verification (whether the cert actually satisfies the structural requirements)
  additional_insured_ok  boolean,
  waiver_subrogation_ok  boolean,
  primary_noncontrib_ok  boolean,
  certificate_holder_ok  boolean,
  am_best_rating         text,
  am_best_ok             boolean,
  -- compliance rollup (recomputed by coi-extract / match RPC; view mirrors it)
  status               text not null default 'pending'
                         check (status in ('compliant','deficient','expiring','expired','missing','pending')),
  deficiencies         jsonb not null default '[]'::jsonb,  -- [{code,label,detail}]
  source               text not null default 'ai_extraction'
                         check (source in ('ai_extraction','email_inbound','ebix_import','manual')),
  raw_extract          jsonb,   -- full coi-extract payload for audit / re-match
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists coi_certificates_prop on public.coi_certificates(property_id);
create index if not exists coi_certificates_party on public.coi_certificates(property_id, party_type, party_name);
create index if not exists coi_certificates_exp on public.coi_certificates(expiration_date);
create index if not exists coi_certificates_ebix on public.coi_certificates(ebix_vendor_num);

create table if not exists public.coi_coverages (
  id                uuid primary key default uuid_generate_v4(),
  certificate_id    uuid not null references public.coi_certificates(id) on delete cascade,
  coverage_type     text not null,
  carrier           text,
  am_best_rating    text,
  policy_number     text,
  effective_date    date,
  expiration_date   date,
  each_occurrence   numeric,
  aggregate         numeric,
  other_limits      jsonb,      -- named limits (EL per-accident, umbrella, med-exp, etc.)
  additional_insured boolean,
  waiver_subrogation boolean,
  primary_noncontrib boolean,
  created_at        timestamptz not null default now()
);
create index if not exists coi_coverages_cert on public.coi_coverages(certificate_id);

-- ---------------------------------------------------------------------------
-- (3) Collection workflow — the outbound chase + paper trail (replaces the
--     Ebix outreach). One row per request thread per party.
-- ---------------------------------------------------------------------------
create table if not exists public.coi_requests (
  id                uuid primary key default uuid_generate_v4(),
  property_id       uuid not null references public.properties(id) on delete cascade,
  certificate_id    uuid references public.coi_certificates(id) on delete set null,
  party_type        text not null check (party_type in ('tenant','vendor','contractor')),
  party_name        text not null,
  reason            text not null default 'missing'
                      check (reason in ('missing','expiring','expired','deficient','renewal')),
  recipients        text[] not null default '{}',   -- tenant/vendor + broker emails
  requested_at      timestamptz,
  last_reminder_at  timestamptz,
  next_reminder_at  timestamptz,
  reminder_count    int not null default 0,
  response_state    text not null default 'open'
                      check (response_state in ('open','responded','resolved','escalated','closed')),
  notes             text,
  created_by        uuid references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists coi_requests_prop on public.coi_requests(property_id);
create index if not exists coi_requests_next on public.coi_requests(next_reminder_at)
  where response_state = 'open';

-- ---------------------------------------------------------------------------
-- (4) Governing-compliance view — one row per property+party, the LATEST
--     certificate (by expiration), with lifecycle + expiry math. Mirrors
--     service_agreement_alerts. security_invoker so RLS on the base tables
--     scopes authenticated users; the service role (digest fn) sees all.
-- ---------------------------------------------------------------------------
create or replace view public.coi_compliance
with (security_invoker = true) as
with governing as (
  select distinct on (
      c.property_id,
      c.party_type,
      lower(regexp_replace(c.party_name, '[^a-zA-Z0-9]', '', 'g'))
    ) c.*
  from public.coi_certificates c
  order by
    c.property_id,
    c.party_type,
    lower(regexp_replace(c.party_name, '[^a-zA-Z0-9]', '', 'g')),
    c.expiration_date desc nulls last,
    c.created_at desc
)
select
  g.id,
  g.property_id,
  p.name           as property_name,
  g.party_type,
  g.party_name,
  g.expiration_date,
  g.am_best_rating,
  g.deficiencies,
  jsonb_array_length(g.deficiencies) as deficiency_count,
  case when g.expiration_date is not null then (g.expiration_date - current_date) end as days_until,
  (g.expiration_date is not null and g.expiration_date < current_date) as is_expired,
  -- effective lifecycle status, expiry overriding a stale 'compliant'
  case
    when g.status = 'missing' then 'missing'
    when g.expiration_date is not null and g.expiration_date < current_date then 'expired'
    when g.status = 'deficient' then 'deficient'
    when g.expiration_date is not null and (g.expiration_date - current_date) <= 60 then 'expiring'
    else g.status
  end as effective_status
from governing g
join public.properties p on p.id = g.property_id;

grant select on public.coi_compliance to authenticated, service_role;

-- Digest audit log (what the reminder/digest run sent + when) — dedupe + audit.
create table if not exists public.coi_alert_log (
  id             uuid primary key default uuid_generate_v4(),
  sent_at        timestamptz not null default now(),
  recipients     text[]      not null default '{}',
  horizon_days   int,
  missing_count  int,
  expiring_count int,
  expired_count  int,
  deficient_count int,
  certificate_ids uuid[]     not null default '{}',
  test           boolean     not null default false,
  ok             boolean     not null default true,
  detail         text
);

-- ---------------------------------------------------------------------------
-- RLS — read for anyone who can see the property; write for admin/AM (PMs get
-- write on the property-scoped tables so they can chase their own assets).
-- ---------------------------------------------------------------------------
alter table public.insurance_requirements            enable row level security;
alter table public.insurance_requirement_coverages   enable row level security;
alter table public.coi_certificates                  enable row level security;
alter table public.coi_coverages                     enable row level security;
alter table public.coi_requests                       enable row level security;
alter table public.coi_alert_log                      enable row level security;

create policy "insurance_requirements_select" on public.insurance_requirements
  for select using (public.can_access_property(property_id));
create policy "insurance_requirements_write" on public.insurance_requirements
  for all using (public.is_admin_or_am()) with check (public.is_admin_or_am());

create policy "insurance_req_cov_select" on public.insurance_requirement_coverages
  for select using (exists (
    select 1 from public.insurance_requirements r
    where r.id = requirement_id and public.can_access_property(r.property_id)));
create policy "insurance_req_cov_write" on public.insurance_requirement_coverages
  for all using (public.is_admin_or_am()) with check (public.is_admin_or_am());

create policy "coi_certificates_select" on public.coi_certificates
  for select using (public.can_access_property(property_id));
create policy "coi_certificates_write" on public.coi_certificates
  for all using (public.can_access_property(property_id))
  with check (public.can_access_property(property_id));

create policy "coi_coverages_select" on public.coi_coverages
  for select using (exists (
    select 1 from public.coi_certificates c
    where c.id = certificate_id and public.can_access_property(c.property_id)));
create policy "coi_coverages_write" on public.coi_coverages
  for all using (exists (
    select 1 from public.coi_certificates c
    where c.id = certificate_id and public.can_access_property(c.property_id)))
  with check (exists (
    select 1 from public.coi_certificates c
    where c.id = certificate_id and public.can_access_property(c.property_id)));

create policy "coi_requests_select" on public.coi_requests
  for select using (public.can_access_property(property_id));
create policy "coi_requests_write" on public.coi_requests
  for all using (public.can_access_property(property_id))
  with check (public.can_access_property(property_id));

create policy "coi_alert_log_read"  on public.coi_alert_log
  for select using (public.is_admin_or_am());
create policy "coi_alert_log_write" on public.coi_alert_log
  for all using (public.is_admin_or_am());

grant select, insert, update, delete on public.insurance_requirements          to authenticated;
grant select, insert, update, delete on public.insurance_requirement_coverages to authenticated;
grant select, insert, update, delete on public.coi_certificates                to authenticated;
grant select, insert, update, delete on public.coi_coverages                   to authenticated;
grant select, insert, update, delete on public.coi_requests                    to authenticated;
grant select, insert on public.coi_alert_log to authenticated, service_role;

notify pgrst, 'reload schema';
