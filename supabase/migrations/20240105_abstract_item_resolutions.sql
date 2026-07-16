-- 20240105_abstract_item_resolutions.sql
-- Per-item resolution workflow for lease abstracts (Phase 1). A reviewer can
-- resolve any open item OR verification check by a STABLE key so the resolution
-- survives regeneration (open_items strings and qa.field_checks are rebuilt on
-- every generate/verify). One key, shared between a generator open item and a
-- verifier check about the same field, clears both — the single passthrough.
--
-- item_key derivation (kept identical in the frontend, see AbstractsPage.tsx):
--   field-tagged item ("... [term.expiration] ...")  -> 'field:term.expiration'
--   verification check (always has a field)           -> 'field:<field>'
--   field-less open item (missing doc, note)          -> 'text:<normalized first 120 chars>'
-- normalization = collapse whitespace, trim, lowercase (reproducible in SQL + JS).

create table if not exists public.abstract_item_resolutions (
  id           uuid primary key default uuid_generate_v4(),
  abstract_id  uuid not null references public.lease_abstracts(id) on delete cascade,
  item_key     text not null,
  kind         text not null default 'open_item' check (kind in ('open_item', 'qa_check')),
  status       text not null check (status in ('corrected', 'accepted', 'waived', 'needs_doc')),
  note         text,
  task_id      uuid references public.tasks(id) on delete set null,
  resolved_by  uuid references public.users(id) on delete set null,
  resolved_at  timestamptz not null default now(),
  archived     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (abstract_id, item_key)
);

create index if not exists air_abstract_idx on public.abstract_item_resolutions (abstract_id) where archived = false;

alter table public.abstract_item_resolutions enable row level security;

-- Abstracts are an admin / asset-manager surface (AbstractsPage gates the route
-- to those roles); resolutions follow the same posture.
create policy "air_select" on public.abstract_item_resolutions
  for select using (public.is_admin_or_am());
create policy "air_insert" on public.abstract_item_resolutions
  for insert with check (public.is_admin_or_am());
create policy "air_update" on public.abstract_item_resolutions
  for update using (public.is_admin_or_am());
create policy "air_delete" on public.abstract_item_resolutions
  for delete using (public.is_admin_or_am());

grant select, insert, update, delete on public.abstract_item_resolutions to authenticated;

-- Portfolio rollup: every open item across all abstracts, tagged with severity
-- and joined to its resolution. Powers an "unresolved discrepancies portfolio-
-- wide" view. security_invoker so the caller's lease_abstracts RLS still applies.
create or replace view public.v_abstract_open_items
with (security_invoker = true) as
with items as (
  select
    la.id          as abstract_id,
    la.property_id,
    la.tenant_name,
    t.ord,
    t.txt
  from public.lease_abstracts la
  cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(la.abstract -> 'open_items') = 'array'
         then la.abstract -> 'open_items' else '[]'::jsonb end
  ) with ordinality as t(txt, ord)
),
keyed as (
  select
    i.*,
    case
      when i.txt ~* '^\s*DISCREPANCY\s*:' then 'discrepancy'
      when i.txt ~* '^\s*CONFIRM\s*:'     then 'confirm'
      else 'info'
    end as severity,
    (regexp_match(
       regexp_replace(i.txt, '^\s*(DISCREPANCY|CONFIRM)\s*:\s*', '', 'i'),
       '^\[([^\]]+)\]'))[1] as field
  from items i
)
select
  k.abstract_id,
  k.property_id,
  k.tenant_name,
  k.ord,
  k.txt,
  k.severity,
  k.field,
  case
    when k.field is not null then 'field:' || lower(k.field)
    else 'text:' || left(
      btrim(lower(regexp_replace(
        regexp_replace(k.txt, '^\s*(DISCREPANCY|CONFIRM)\s*:\s*', '', 'i'),
        '\s+', ' ', 'g'))), 120)
  end as item_key,
  (r.id is not null) as resolved,
  r.status as resolution_status
from keyed k
left join public.abstract_item_resolutions r
  on r.abstract_id = k.abstract_id
 and r.archived = false
 and r.item_key = case
    when k.field is not null then 'field:' || lower(k.field)
    else 'text:' || left(
      btrim(lower(regexp_replace(
        regexp_replace(k.txt, '^\s*(DISCREPANCY|CONFIRM)\s*:\s*', '', 'i'),
        '\s+', ' ', 'g'))), 120)
  end;

grant select on public.v_abstract_open_items to authenticated;
