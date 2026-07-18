-- 20240115_mri_recon_reflagged.sql
-- Visible "re-flagged" marker for the MRI recon queue.
--
-- revert_stale_mri_recon() (migration 20240114) reopens a resolved/not_an_issue row
-- when a newer QA run re-flags the same field, but the row just returned to plain
-- 'open' -- indistinguishable from a never-touched conflict. This adds reflagged_at:
-- the function stamps it on reopen so the UI can badge the row "you resolved this, a
-- newer QA run flagged it again." Any manual status change clears it (the frontend
-- sets reflagged_at = null in setStatus) -- once the user re-triages, the marker is done.

alter table public.mri_recon_status
  add column if not exists reflagged_at timestamptz;

create or replace function public.revert_stale_mri_recon()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if not public.is_admin_or_am() then
    raise exception 'not authorized';
  end if;

  with reverted as (
    update public.mri_recon_status s
    set status = 'open', reflagged_at = now(), updated_at = now()
    where s.status in ('resolved', 'not_an_issue')
      and s.qa_at is not null
      and exists (
        select 1
        from public.lease_abstracts la
        where la.property_id = s.property_id
          and la.tenant_name = s.tenant_name
          and la.qa is not null
          and la.qa_at is not null
          and la.qa_at > s.qa_at
      )
    returning 1
  )
  select count(*) into n from reverted;
  return n;
end;
$$;

-- CREATE OR REPLACE preserves the existing ACL, but re-issue to be explicit.
revoke execute on function public.revert_stale_mri_recon() from public, anon;
grant execute on function public.revert_stale_mri_recon() to authenticated, service_role;
