-- 20240085_coi_review_queue.sql
-- Landing spot for COIs that coi-extract parsed but could NOT confidently route
-- to a property (and party). Both intake channels — the network-folder watcher
-- and the coi@wilkow.com mailbox — drop unresolved certs here instead of
-- guessing. Staff triage from the /insurance "Review queue" section: pick the
-- property + party and File (which re-runs coi-extract with the chosen ids so
-- the cert is graded exactly like any other), or Dismiss.
--
-- Property is UNKNOWN by definition, so these rows can't be RLS-scoped per
-- property — restrict the queue to admin / asset_manager (the risk triagers).

create table if not exists public.coi_review_queue (
  id                    uuid primary key default uuid_generate_v4(),
  storage_path          text,          -- documents-bucket path; lets File re-parse without re-upload
  document_id           uuid references public.documents(id) on delete set null,
  cert_type             text,
  insured_name          text,
  producer_name         text,
  effective_date        date,
  expiration_date       date,
  suggested_property_id uuid references public.properties(id) on delete set null,
  suggested_party_type  text check (suggested_party_type in ('tenant','vendor','contractor')),
  suggested_party_name  text,
  reason                text not null,  -- property_unresolved | ambiguous_property | low_confidence
  raw_extract           jsonb,          -- full parse, for display during triage
  coverages             jsonb,          -- normalized coverage rows parsed off the cert
  source                text not null default 'email_inbound'
                          check (source in ('ai_extraction','email_inbound','folder','manual')),
  status                text not null default 'pending'
                          check (status in ('pending','filed','dismissed')),
  resolved_by           uuid references public.users(id) on delete set null,
  resolved_at           timestamptz,
  notes                 text,
  created_at            timestamptz not null default now()
);
create index if not exists coi_review_queue_status on public.coi_review_queue(status);

alter table public.coi_review_queue enable row level security;
create policy "coi_review_queue_read"  on public.coi_review_queue
  for select using (public.is_admin_or_am());
create policy "coi_review_queue_write" on public.coi_review_queue
  for all using (public.is_admin_or_am()) with check (public.is_admin_or_am());
grant select, insert, update, delete on public.coi_review_queue to authenticated, service_role;

notify pgrst, 'reload schema';
