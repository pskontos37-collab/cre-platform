-- ============================================================
-- GROUP F: Users, Entitlements, Auth trigger
-- ============================================================

-- Extends Supabase auth.users. id must match auth.users.id exactly.
create table users (
  id         uuid primary key,
  email      text not null unique,
  full_name  text,
  role       user_role not null default 'property_manager',
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Back-fill FKs that referenced users before the table existed
alter table co_tenancy_flags
  add constraint co_tenancy_flags_reviewed_by_fkey
  foreign key (reviewed_by) references users(id) on delete set null;

alter table import_jobs
  add constraint import_jobs_created_by_fkey
  foreign key (created_by) references users(id) on delete set null;

alter table documents
  add constraint documents_uploaded_by_fkey
  foreign key (uploaded_by) references users(id) on delete set null;

alter table inspections
  add constraint inspections_uploaded_by_fkey
  foreign key (uploaded_by) references users(id) on delete set null;

create table entitlements (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid not null references users(id) on delete cascade,
  scope        entitlement_scope not null,
  portfolio_id uuid references portfolios(id) on delete cascade,
  property_id  uuid references properties(id) on delete cascade,
  fund_id      uuid references funds(id) on delete cascade,
  investor_id  uuid references investors(id) on delete cascade,
  can_read     boolean not null default true,
  can_write    boolean not null default false,
  can_upload   boolean not null default false,
  granted_by   uuid references users(id) on delete set null,
  granted_at   timestamptz not null default now()
);

-- Auto-create a user profile row on Supabase Auth sign-up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    'property_manager'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
