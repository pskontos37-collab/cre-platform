-- 20240029_critical_dates_status.sql
-- Critical dates get a resolution workflow: open → completed / exercised /
-- received / waived. Resolving a date removes it from the dashboard widget
-- (which filters is_completed = false). is_completed stays as the boolean
-- mirror so existing queries keep working.

alter table public.critical_dates
  add column if not exists status text not null default 'open',
  add column if not exists completed_date date,
  add column if not exists completed_by uuid;

alter table public.critical_dates drop constraint if exists critical_dates_status_check;
alter table public.critical_dates add constraint critical_dates_status_check
  check (status in ('open', 'completed', 'exercised', 'received', 'waived'));

update public.critical_dates set status = 'completed' where is_completed and status = 'open';
