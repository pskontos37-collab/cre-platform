-- 20240077_work_orders.sql
-- Tenant work-order system: tenants log into a portal (/portal) and submit
-- maintenance requests; staff triage/assign/close them from /workorders.
--
-- SECURITY MODEL — tenants do NOT get Supabase Auth accounts. Many existing
-- policies/grants/views/RPCs are open to any `authenticated` JWT (form
-- templates, emergency manuals, GL statement views, the 20240048 execute-grant
-- loop, storage read policies), so a tenant holding a real Supabase JWT could
-- read staff data straight off PostgREST. Instead, portal identities live in
-- work_order_portal_users (PBKDF2 password hash) and every tenant interaction
-- goes through the `work-orders` edge function, which runs with the service
-- role and scopes all reads/writes to the caller's tenant + property. Staff
-- access these tables directly through PostgREST under the normal
-- can_access_property() RLS.

-- ── Portal identities ───────────────────────────────────────────────────────
create table if not exists public.work_order_portal_users (
  id                   uuid primary key default uuid_generate_v4(),
  property_id          uuid not null references public.properties(id) on delete cascade,
  -- denormalized like tenant_contacts / lease_abstracts (not every lease has a
  -- tenants row); portal scope = property_id + tenant_name
  tenant_name          text not null,
  unit_label           text,
  email                text not null,               -- stored lowercased
  contact_name         text,
  phone                text,
  password_hash        text not null,               -- pbkdf2$<iters>$<saltB64>$<hashB64>
  must_change_password boolean not null default true,
  -- bumped on every password change so outstanding portal session tokens die
  token_epoch          int not null default 1,
  failed_attempts      int not null default 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  is_active            boolean not null default true,
  created_by           uuid references public.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create unique index if not exists wo_portal_users_email on public.work_order_portal_users (lower(email));
create index if not exists wo_portal_users_property on public.work_order_portal_users (property_id);

-- ── Work orders ─────────────────────────────────────────────────────────────
create table if not exists public.work_orders (
  id                  uuid primary key default uuid_generate_v4(),
  -- human-facing number, e.g. WO-001042
  wo_number           bigint generated always as identity (start with 1001),
  property_id         uuid not null references public.properties(id) on delete cascade,
  portal_user_id      uuid references public.work_order_portal_users(id) on delete set null,
  tenant_name         text not null,
  unit_label          text,
  category            text not null default 'other'
                        check (category in ('hvac','plumbing','electrical','roof_leak','doors_locks',
                                            'lighting','janitorial','pest_control','landscaping',
                                            'parking_lot','signage','safety','other')),
  priority            text not null default 'normal'
                        check (priority in ('low','normal','high','emergency')),
  title               text not null,
  description         text,
  status              text not null default 'new'
                        check (status in ('new','acknowledged','in_progress','on_hold','completed','cancelled')),
  source              text not null default 'portal' check (source in ('portal','staff')),
  contact_phone       text,
  permission_to_enter boolean not null default true,
  assigned_to         uuid references public.users(id) on delete set null,
  -- visible to the tenant when the order completes (staff-facing notes go in
  -- internal comments)
  resolution_notes    text,
  acknowledged_at     timestamptz,
  completed_at        timestamptz,
  created_by          uuid references public.users(id) on delete set null,  -- staff-entered orders
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists work_orders_property_status on public.work_orders (property_id, status);
create index if not exists work_orders_portal_user     on public.work_orders (portal_user_id);
create index if not exists work_orders_tenant          on public.work_orders (property_id, tenant_name);

-- ── Comments (tenant-visible thread + internal staff notes) ─────────────────
create table if not exists public.work_order_comments (
  id             uuid primary key default uuid_generate_v4(),
  work_order_id  uuid not null references public.work_orders(id) on delete cascade,
  author_kind    text not null check (author_kind in ('tenant','staff')),
  portal_user_id uuid references public.work_order_portal_users(id) on delete set null,
  user_id        uuid references public.users(id) on delete set null,
  author_name    text,
  body           text not null,
  -- internal notes never leave the staff app; the edge function filters them
  -- out of every tenant response
  is_internal    boolean not null default false,
  created_at     timestamptz not null default now()
);

create index if not exists wo_comments_order on public.work_order_comments (work_order_id, created_at);

-- ── Photos ──────────────────────────────────────────────────────────────────
create table if not exists public.work_order_photos (
  id               uuid primary key default uuid_generate_v4(),
  work_order_id    uuid not null references public.work_orders(id) on delete cascade,
  storage_path     text not null,      -- work-orders/<property>/<order>/<uuid>.<ext>
  content_type     text,
  uploaded_by_kind text not null default 'tenant' check (uploaded_by_kind in ('tenant','staff')),
  caption          text,
  created_at       timestamptz not null default now()
);

create index if not exists wo_photos_order on public.work_order_photos (work_order_id);

-- Private bucket. Tenants upload/view only via edge-function signed URLs;
-- staff read/sign client-side under the storage policies below (tenants hold
-- no Supabase JWT, so `authenticated` here means staff only).
insert into storage.buckets (id, name, public)
values ('work-orders', 'work-orders', false)
on conflict (id) do nothing;

drop policy if exists "work_orders_storage_read" on storage.objects;
create policy "work_orders_storage_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'work-orders');

drop policy if exists "work_orders_storage_insert" on storage.objects;
create policy "work_orders_storage_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'work-orders');

-- ── RLS (staff paths; the edge function's service role bypasses RLS) ────────
alter table public.work_order_portal_users enable row level security;
alter table public.work_orders             enable row level security;
alter table public.work_order_comments     enable row level security;
alter table public.work_order_photos       enable row level security;

-- Portal users: staff in scope may see + maintain contact fields / deactivate.
-- INSERT and password/token columns are deliberately NOT granted — creating a
-- login and setting passwords happen only in the edge function (service role).
drop policy if exists "wo_portal_users_select" on public.work_order_portal_users;
create policy "wo_portal_users_select" on public.work_order_portal_users
  for select using (public.can_access_property(property_id));

drop policy if exists "wo_portal_users_update" on public.work_order_portal_users;
create policy "wo_portal_users_update" on public.work_order_portal_users
  for update using (public.can_access_property(property_id))
  with check (public.can_access_property(property_id));

drop policy if exists "wo_portal_users_delete" on public.work_order_portal_users;
create policy "wo_portal_users_delete" on public.work_order_portal_users
  for delete using (public.can_access_property(property_id));

-- Column-level grants keep password_hash / token_epoch out of staff reach.
grant select (id, property_id, tenant_name, unit_label, email, contact_name, phone,
              must_change_password, locked_until, last_login_at, is_active,
              created_by, created_at, updated_at)
  on public.work_order_portal_users to authenticated;
grant update (tenant_name, unit_label, contact_name, phone, is_active, updated_at)
  on public.work_order_portal_users to authenticated;
grant delete on public.work_order_portal_users to authenticated;

-- Work orders: full staff lifecycle within property scope; delete admin-only
-- (cancel is a status, not a delete).
drop policy if exists "work_orders_select" on public.work_orders;
create policy "work_orders_select" on public.work_orders
  for select using (public.can_access_property(property_id));

drop policy if exists "work_orders_insert" on public.work_orders;
create policy "work_orders_insert" on public.work_orders
  for insert with check (public.can_access_property(property_id));

drop policy if exists "work_orders_update" on public.work_orders;
create policy "work_orders_update" on public.work_orders
  for update using (public.can_access_property(property_id))
  with check (public.can_access_property(property_id));

drop policy if exists "work_orders_delete" on public.work_orders;
create policy "work_orders_delete" on public.work_orders
  for delete using (public.is_admin());

grant select, insert, update, delete on public.work_orders to authenticated;

-- Comments / photos follow their order's property scope.
drop policy if exists "wo_comments_select" on public.work_order_comments;
create policy "wo_comments_select" on public.work_order_comments
  for select using (exists (
    select 1 from public.work_orders w
    where w.id = work_order_id and public.can_access_property(w.property_id)));

drop policy if exists "wo_comments_insert" on public.work_order_comments;
create policy "wo_comments_insert" on public.work_order_comments
  for insert with check (exists (
    select 1 from public.work_orders w
    where w.id = work_order_id and public.can_access_property(w.property_id)));

drop policy if exists "wo_comments_delete" on public.work_order_comments;
create policy "wo_comments_delete" on public.work_order_comments
  for delete using (public.is_admin());

grant select, insert, delete on public.work_order_comments to authenticated;

drop policy if exists "wo_photos_select" on public.work_order_photos;
create policy "wo_photos_select" on public.work_order_photos
  for select using (exists (
    select 1 from public.work_orders w
    where w.id = work_order_id and public.can_access_property(w.property_id)));

drop policy if exists "wo_photos_insert" on public.work_order_photos;
create policy "wo_photos_insert" on public.work_order_photos
  for insert with check (exists (
    select 1 from public.work_orders w
    where w.id = work_order_id and public.can_access_property(w.property_id)));

grant select, insert on public.work_order_photos to authenticated;
