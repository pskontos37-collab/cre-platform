-- 20240085_tenant_announcements.sql
-- Tenant Announcements (/announcements, Operations group): property managers
-- compose an email to all tenants of a property or a selected subset, sent via
-- the announcement-send edge function (Resend). These tables are the audit
-- trail — what was said, who sent it, who received it, and per-recipient
-- delivery status.
--
-- Recipient emails come from the union of tenant_contacts (email present) and
-- work_order_portal_users (active) at send time; the snapshot stored here is
-- what was actually used, so later contact edits do not rewrite history.
--
-- Writes happen ONLY through the edge function (service role, bypasses RLS).
-- Staff get read-only visibility scoped by can_access_property, matching the
-- rest of the operations pages. No insert/update/delete policies on purpose.

create table if not exists public.tenant_announcements (
  id             uuid primary key default uuid_generate_v4(),
  property_id    uuid not null references public.properties(id) on delete cascade,
  subject        text not null,
  body           text not null,   -- plain text as composed (rendered to HTML at send)
  sent_by        uuid references public.users(id) on delete set null,
  sent_by_name   text,            -- snapshot; survives user deletion
  recipient_mode text not null default 'selected'
                   check (recipient_mode in ('all','selected')),
  status         text not null default 'sent'
                   check (status in ('sent','partial','failed')),
  sent_count     integer not null default 0,
  failed_count   integer not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists tenant_announcements_prop
  on public.tenant_announcements(property_id, created_at desc);

create table if not exists public.tenant_announcement_recipients (
  id              uuid primary key default uuid_generate_v4(),
  announcement_id uuid not null references public.tenant_announcements(id) on delete cascade,
  tenant_id       uuid references public.tenants(id) on delete set null,
  tenant_name     text,
  contact_name    text,
  email           text not null,
  source          text,            -- 'tenant_contacts' | 'portal_user' | 'manual'
  status          text not null default 'sent'
                    check (status in ('sent','failed')),
  error           text
);
create index if not exists tenant_announcement_recipients_ann
  on public.tenant_announcement_recipients(announcement_id);

alter table public.tenant_announcements enable row level security;
alter table public.tenant_announcement_recipients enable row level security;

create policy tenant_announcements_select on public.tenant_announcements
  for select using (can_access_property(property_id));

create policy tenant_announcement_recipients_select on public.tenant_announcement_recipients
  for select using (
    exists (
      select 1 from public.tenant_announcements a
      where a.id = announcement_id and can_access_property(a.property_id)
    )
  );
