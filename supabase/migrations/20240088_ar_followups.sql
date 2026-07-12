-- 20240088_ar_followups.sql
-- Follow-up log for A/R payment reminders. One row per reminder draft a
-- manager generates from /receivables (either the .eml download or the
-- clipboard/mailto route). This logs that a draft was GENERATED, not that the
-- email was actually sent -- the send happens in the manager's own mail
-- client, which the app cannot observe. Keyed like ar_notes on
-- property_id + mri_lease_id, with tenant_name kept for rows that lack an
-- MRI lease id. Immutable: insert + select only, no update/delete policies.

create table if not exists public.ar_followups (
  id            uuid primary key default uuid_generate_v4(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  tenant_id     uuid references public.tenants(id) on delete set null,
  mri_lease_id  text,
  tenant_name   text not null,
  method        text not null check (method in ('eml','mailto')),
  recipients    text[] not null default '{}',
  -- balances at the moment the reminder was generated
  past_due      numeric,
  total_balance numeric,
  as_of         date,
  sent_by       uuid not null default auth.uid() references public.users(id),
  -- denormalized so the UI never needs a users-table join (users RLS hides rows)
  sent_by_name  text,
  created_at    timestamptz not null default now()
);

create index if not exists ar_followups_key
  on public.ar_followups(property_id, mri_lease_id, created_at desc);

alter table public.ar_followups enable row level security;

drop policy if exists "ar_followups_select" on public.ar_followups;
create policy "ar_followups_select" on public.ar_followups
  for select using (public.can_access_property(property_id));

drop policy if exists "ar_followups_insert" on public.ar_followups;
create policy "ar_followups_insert" on public.ar_followups
  for insert with check (public.can_access_property(property_id) and sent_by = auth.uid());

grant select, insert on public.ar_followups to authenticated;
