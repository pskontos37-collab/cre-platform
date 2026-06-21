-- ============================================================
-- AUDIT LOG (append-only)
-- ============================================================

create table audit_log (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references users(id) on delete set null,
  action      audit_action not null,
  entity_type text,
  entity_id   uuid,
  property_id uuid,
  detail      jsonb,
  ip_address  text,
  user_agent  text,
  created_at  timestamptz not null default now()
);

alter table audit_log enable row level security;

-- Anyone authenticated can append; only admins can read
create policy "audit_log_insert" on audit_log for insert
  with check (auth.uid() is not null);

create policy "audit_log_select" on audit_log for select using (
  exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active = true)
);

-- Auto-log mutations on sensitive tables
create or replace function public.log_mutation()
returns trigger language plpgsql security definer as $$
begin
  insert into public.audit_log (user_id, action, entity_type, entity_id, detail)
  values (
    auth.uid(),
    lower(TG_OP)::audit_action,
    TG_TABLE_NAME,
    coalesce(new.id, old.id),
    case
      when TG_OP = 'DELETE' then to_jsonb(old)
      when TG_OP = 'UPDATE' then jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new))
      else to_jsonb(new)
    end
  );
  return coalesce(new, old);
end;
$$;

create trigger audit_leases
  after insert or update or delete on leases
  for each row execute procedure public.log_mutation();

create trigger audit_distributions
  after insert or update or delete on distributions
  for each row execute procedure public.log_mutation();

create trigger audit_capital_accounts
  after insert or update or delete on capital_accounts
  for each row execute procedure public.log_mutation();

create trigger audit_users
  after insert or update or delete on users
  for each row execute procedure public.log_mutation();

create trigger audit_entitlements
  after insert or update or delete on entitlements
  for each row execute procedure public.log_mutation();
