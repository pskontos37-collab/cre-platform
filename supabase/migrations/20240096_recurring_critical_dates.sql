-- NOTE: 20240096 is a known disk-number dup (20240096_ppm_builder.sql was
-- claimed by a parallel session the same day). Supabase records migrations by
-- full name, so both apply cleanly; kept as-is per the 20240086 precedent.
--
-- Recurring operational deadlines (PMA monthly report packages, CHI sub-manager
-- reports, quarterly REIT questionnaires): instead of going permanently overdue,
-- they roll forward to the next occurrence once the date passes.
-- recurrence_day anchors the day-of-month so a 30th-of-month deadline doesn't
-- drift to the 28th after passing through February.

alter table public.critical_dates
  add column if not exists recurrence text
    check (recurrence in ('monthly','quarterly','annual')),
  add column if not exists recurrence_day int;

update public.critical_dates set recurrence = 'monthly',
  recurrence_day = extract(day from due_date)::int
where id in ('e45789c4-dc87-4c3f-a12c-3e0d04ddf146',
             '799fc282-b4cd-4756-b349-a9b4b313dfdc',
             '54c7e71a-3e1d-4725-886b-e36ceaaf70b4',
             '7aee72a3-373e-4e39-81d4-bed633bf4b3c',
             'e404d6a5-176c-41d3-a5fa-0acba9b7dfbb',
             '519b73d1-2546-4083-bf21-737e78992826');

update public.critical_dates set recurrence = 'quarterly',
  recurrence_day = extract(day from due_date)::int
where id = '5eb5593b-60a3-4cc9-9210-08b51485a611';

update public.critical_dates set recurrence = 'annual',
  recurrence_day = extract(day from due_date)::int
where id = 'f6acd3a3-1216-4e88-b76a-8e5b9918e8d1';

-- Advance every past-due recurring row to its next occurrence and reset the
-- resolution so each cycle starts fresh (history stays in audit_log).
create or replace function public.roll_recurring_critical_dates()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int; total int := 0;
begin
  loop
    update public.critical_dates c set
      due_date = sub.new_due,
      status = 'open',
      is_completed = false,
      completed_date = null,
      completed_by = null,
      resolution_note = null
    from (
      select c2.id,
             (t.first_of_target
              + (least(coalesce(c2.recurrence_day, extract(day from c2.due_date)::int),
                       extract(day from (t.first_of_target + interval '1 month - 1 day'))::int) - 1)
                * interval '1 day')::date as new_due
      from public.critical_dates c2
      cross join lateral (
        select (date_trunc('month', c2.due_date)
                + case c2.recurrence
                    when 'monthly'   then interval '1 month'
                    when 'quarterly' then interval '3 months'
                    else                  interval '12 months'
                  end)::date as first_of_target
      ) t
      where c2.recurrence is not null and c2.due_date < current_date
    ) sub
    where c.id = sub.id;
    get diagnostics n = row_count;
    total := total + n;
    exit when n = 0;
  end loop;
  return total;
end $$;

revoke execute on function public.roll_recurring_critical_dates() from public, anon;
grant execute on function public.roll_recurring_critical_dates() to authenticated, service_role;

-- Nightly roll at 06:15 UTC.
create extension if not exists pg_cron;
select cron.schedule('roll-recurring-critical-dates', '15 6 * * *',
                     'select public.roll_recurring_critical_dates()');
