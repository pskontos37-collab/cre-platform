-- 20240202_formalize_untracked_schema_drift
--
-- The 2026-08-07 DR rehearsal (docs/DR_REHEARSAL.md) replayed every committed
-- migration onto an empty project and found the schema below living ONLY in
-- production -- created via dashboard SQL or untracked hotfixes, so a from-zero
-- rebuild fails without it. This migration is the missing history: on prod every
-- statement is a no-op (all objects already exist); on a fresh replay it makes
-- the repo sufficient to rebuild the schema.
--
-- Sources: column types/defaults from information_schema; function bodies from
-- pg_get_functiondef verbatim; grants mirrored from routine_privileges.

-- (1) documents: dashboard-era columns (pre 2026-07-10; nightly_scan_report_view
--     depends on storage_path)
alter table documents add column if not exists storage_path text;
alter table documents add column if not exists file_mtime timestamptz;

-- (2) asset_type gained 'mixed_use' via untracked ALTER TYPE (Penn Center Retail,
--     Penn Center East Office). Only enum drift portfolio-wide (full diff 8/07).
alter type asset_type add value if not exists 'mixed_use';

-- (3) properties: four untracked columns. useProperties() FILTERS on
--     ownership_type, so /properties hard-errors on any rebuild without it.
alter table properties add column if not exists ownership_type text not null default 'owned';
alter table properties add column if not exists status text not null default 'active';
alter table properties add column if not exists management_company text;
alter table properties add column if not exists jv_partner text;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'properties_ownership_type_check'
                   and conrelid = 'properties'::regclass) then
    alter table properties add constraint properties_ownership_type_check
      check (ownership_type = any (array['owned'::text, 'third_party_managed'::text]));
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'properties_status_check'
                   and conrelid = 'properties'::regclass) then
    alter table properties add constraint properties_status_check
      check (status = any (array['active'::text, 'sold'::text, 'under_contract'::text]));
  end if;
end $$;

-- (4) loans: untracked covenant column
alter table loans add column if not exists debt_yield_covenant numeric;

-- (5) storage buckets created in the dashboard (only work-orders has a migration)
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false), ('lease-ingest', 'lease-ingest', false)
on conflict (id) do nothing;

-- (6) log_mutation(): the 20240010 version casts lower(TG_OP) = 'insert' into
--     audit_action, whose value is 'create' -- every audited INSERT fails on a
--     fresh database. Prod has run this hotfixed body (CASE TG_OP) since the
--     dashboard era; this is its first appearance in the repo. Body verbatim
--     from pg_get_functiondef.
CREATE OR REPLACE FUNCTION public.log_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.audit_log (user_id, action, entity_type, entity_id, detail)
  VALUES (
    auth.uid(),
    CASE TG_OP
      WHEN 'INSERT' THEN 'create'
      WHEN 'UPDATE' THEN 'update'
      WHEN 'DELETE' THEN 'delete'
    END::public.audit_action,
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    CASE
      WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
      WHEN TG_OP = 'UPDATE' THEN jsonb_build_object('old', to_jsonb(OLD), 'new', to_jsonb(NEW))
      ELSE to_jsonb(NEW)
    END
  );
  RETURN NULL;
END;
$function$;

-- (7) search_documents_by_title(): untracked function used by doc-ask and
--     doc-search; 20240040 only ALTERs it inside an absence-tolerant loop.
--     Body + grants verbatim from prod (anon EXECUTE is deliberate: SECURITY
--     INVOKER, so RLS on documents yields anon zero rows).
CREATE OR REPLACE FUNCTION public.search_documents_by_title(p_terms text[], p_property uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 6)
 RETURNS TABLE(id uuid, title text, score numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$ with scored as ( select d.id, d.title, (select count(*) from unnest(p_terms) t where d.title ilike '%'||t||'%')::numeric as hits from documents d where (p_property is null or d.property_id = p_property) ) select id, title, round((hits / sqrt(greatest(length(title),10)))::numeric, 4) as score from scored where hits >= least(2, coalesce(array_length(p_terms,1),1)) order by (hits / sqrt(greatest(length(title),10))) desc limit p_limit $function$;
revoke all on function public.search_documents_by_title(text[], uuid, integer) from public;
grant execute on function public.search_documents_by_title(text[], uuid, integer) to anon, authenticated, service_role;

-- Verification guard: every object this migration formalizes must now exist.
-- On prod this asserts the no-op landed on a schema that already conformed;
-- on a rebuild it asserts the migration did its job. (Enum checked via
-- pg_enum, not a cast -- a cast would be an unsafe same-transaction use of
-- the possibly-just-added value.)
do $$
declare missing text := '';
begin
  if to_regprocedure('public.log_mutation()') is null then
    missing := missing || ' log_mutation()'; end if;
  if to_regprocedure('public.search_documents_by_title(text[], uuid, integer)') is null then
    missing := missing || ' search_documents_by_title()'; end if;
  if not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
                 where t.typname = 'asset_type' and e.enumlabel = 'mixed_use') then
    missing := missing || ' asset_type.mixed_use'; end if;
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and (
        (table_name = 'documents'  and column_name in ('storage_path', 'file_mtime')) or
        (table_name = 'properties' and column_name in ('ownership_type', 'status', 'management_company', 'jv_partner')) or
        (table_name = 'loans'      and column_name = 'debt_yield_covenant'))) <> 7 then
    missing := missing || ' drift-columns<>7'; end if;
  if (select count(*) from pg_constraint where conrelid = 'properties'::regclass
      and conname in ('properties_ownership_type_check', 'properties_status_check')) <> 2 then
    missing := missing || ' properties-checks<>2'; end if;
  if (select count(*) from storage.buckets where id in ('documents', 'lease-ingest')) <> 2 then
    missing := missing || ' buckets<>2'; end if;
  if missing <> '' then
    raise exception '20240202: formalization incomplete:%', missing;
  end if;
end $$;
