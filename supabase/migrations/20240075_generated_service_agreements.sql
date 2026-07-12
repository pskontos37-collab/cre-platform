-- 20240075_generated_service_agreements.sql
-- Tracking for service agreements produced by the /services/new generator.
-- METADATA ONLY: the .docx / PDF are fully reproducible from these fields on
-- demand (the generator is deterministic), so no file blobs are stored here.
-- One row per generated / sent agreement, written best-effort by the frontend
-- (src/hooks/useGeneratedAgreements.ts). Dates are kept as free text because
-- the paper form takes free-form dates (e.g. "July 30, 2026").

create table if not exists public.generated_service_agreements (
  id uuid primary key default uuid_generate_v4(),
  property_id uuid references public.properties(id) on delete set null,
  property_key text not null,                 -- 'KME' | 'KMW' (template used)
  vendor_name text not null,
  vendor_business text,
  vendor_email text,
  agreement_date text,                        -- "22nd May 2026"
  term_type text,                             -- 'continuing' | 'single'
  start_date text,
  end_date text,
  status text not null default 'generated'
    check (status in ('generated','sent')),
  sent_to text,
  sent_at timestamptz,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists gen_svc_agr_prop on public.generated_service_agreements(property_id);
create index if not exists gen_svc_agr_created on public.generated_service_agreements(created_at desc);

alter table public.generated_service_agreements enable row level security;

-- Internal operating record; any active authenticated user may read and add
-- (property managers issue these). Edits/deletes are asset-manager/admin only.
create policy "gen_svc_agr_select" on public.generated_service_agreements
  for select using (true);
create policy "gen_svc_agr_insert" on public.generated_service_agreements
  for insert with check (created_by = auth.uid() or created_by is null);
create policy "gen_svc_agr_modify" on public.generated_service_agreements
  for update using (public.is_admin_or_am());
create policy "gen_svc_agr_delete" on public.generated_service_agreements
  for delete using (public.is_admin_or_am());

grant select, insert, update, delete on public.generated_service_agreements to authenticated;

notify pgrst, 'reload schema';
