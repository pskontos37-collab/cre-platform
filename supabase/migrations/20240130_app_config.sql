-- 20240130_app_config.sql
-- PHASE 3a (audit: "de-hard-code M&J config"). A single key/value config surface
-- so firm identity and operational maps live in DATA, not in deployed code.
--
-- First tenants of the table:
--   firm.identity          — names/wordmark/report footer used by UI + reports
--   properties.route_map   — keyword -> property_id routing used by coi-extract
--                            (certificate text voting) and drive-import (folder
--                            tokens). Entries carry a scope ('coi'|'drive'|'all')
--                            because the two consumers match differently: bare
--                            'knightdale'/'consolidated' tokens are correct for
--                            folder names but would make certificate voting
--                            ambiguous. This seed is ALSO the authoritative fix
--                            for the long-standing KM inversion (East=Midway=
--                            ...010, West=Midtown=...011, Consolidated=...012 —
--                            drive-import's hardcoded map had East/West swapped).
--
-- Reads: any authenticated user (and service-role edge functions).
-- Writes: admins only.

create table if not exists public.app_config (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_by  uuid references public.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

alter table public.app_config enable row level security;

create policy app_config_select on public.app_config
  for select to authenticated using (true);
create policy app_config_write on public.app_config
  for all to authenticated
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'))
  with check (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'));

grant select on public.app_config to authenticated;
grant insert, update, delete on public.app_config to authenticated; -- gated by policy

insert into public.app_config (key, value, description) values
(
  'firm.identity',
  jsonb_build_object(
    'name',          'M&J Wilkow, Ltd.',
    'short',         'Wilkow',
    'wordmark',      'M&J WILKOW',
    'report_footer', 'M&J Wilkow, Ltd. - Confidential'
  ),
  'Firm identity for UI chrome and report branding. Edit here, not in code.'
),
(
  'properties.route_map',
  jsonb_build_object('entries', jsonb_build_array(
    -- phrases safe for certificate-text voting AND folder matching
    jsonb_build_object('kw','midway plantation',           'property_id','00000000-0000-0000-0000-000000000010','scope','all'),
    jsonb_build_object('kw','knightdale marketplace east', 'property_id','00000000-0000-0000-0000-000000000010','scope','all'),
    jsonb_build_object('kw','midtown commons',             'property_id','00000000-0000-0000-0000-000000000011','scope','all'),
    jsonb_build_object('kw','knightdale marketplace west', 'property_id','00000000-0000-0000-0000-000000000011','scope','all'),
    jsonb_build_object('kw','gateway',                     'property_id','d5a4ed03-0b60-4168-9208-83822dd24884','scope','all'),
    jsonb_build_object('kw','port chester',                'property_id','d5a4ed03-0b60-4168-9208-83822dd24884','scope','all'),
    jsonb_build_object('kw','magnolia',                    'property_id','d4f08824-2d88-472d-b7aa-a703310c2aaf','scope','all'),
    -- bare folder tokens: drive-import only (would be ambiguous for certificates)
    jsonb_build_object('kw','midway',       'property_id','00000000-0000-0000-0000-000000000010','scope','drive'),
    jsonb_build_object('kw','midtown',      'property_id','00000000-0000-0000-0000-000000000011','scope','drive'),
    jsonb_build_object('kw','consolidated', 'property_id','00000000-0000-0000-0000-000000000012','scope','drive'),
    jsonb_build_object('kw','knightdale',   'property_id','00000000-0000-0000-0000-000000000012','scope','drive')
  )),
  'Keyword -> property routing (coi-extract certificate voting; drive-import folder tokens). KM identity per 2026-06-28 confirmation: East=Midway Plantation=0532, West=Midtown Commons=0531, Consolidated=0530.'
)
on conflict (key) do nothing;

comment on table public.app_config is
  'Firm/operational configuration as data (audit Phase 3a: de-hard-code). Reads: authenticated + service. Writes: admin only. Migration 20240130.';
