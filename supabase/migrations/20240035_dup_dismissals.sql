-- 20240035_dup_dismissals.sql
-- User-dismissable "possible duplicate payment" flags. The flag key is the
-- sorted invoice-id set joined with '|' — if a NEW invoice later joins the
-- same vendor/amount/date group, the key changes and the flag re-surfaces.
create table if not exists public.invoice_dup_dismissals (
  id uuid primary key default uuid_generate_v4(),
  property_id uuid not null references public.properties(id) on delete cascade,
  flag_key text not null,
  dismissed_by text,
  reason text,
  created_at timestamptz not null default now(),
  unique (property_id, flag_key)
);

alter table public.invoice_dup_dismissals enable row level security;
create policy "dup_dismissals_select" on public.invoice_dup_dismissals
  for select using (public.can_access_property(property_id));
create policy "dup_dismissals_write" on public.invoice_dup_dismissals
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.invoice_dup_dismissals to authenticated;
