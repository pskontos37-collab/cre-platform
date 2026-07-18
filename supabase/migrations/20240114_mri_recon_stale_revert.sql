-- 20240114_mri_recon_stale_revert.sql
-- Stale-resolved auto-revert for the MRI reconciliation queue.
--
-- Problem: mri_recon_status carries a workflow status per (property, tenant, field)
-- but was NOT tied to the QA run it was decided against. A row marked resolved /
-- not_an_issue stayed closed forever. If a LATER abstract-verify run re-flagged the
-- same field (a regression, or a "fix" that didn't actually change the field the
-- verifier keys on), the conflict came back to v_mri_reconciliation already wearing
-- the old closed status -- and since both /mri-recon and the dashboard widget default
-- to hiding resolved/not_an_issue, the still-broken conflict was silently invisible.
--
-- Fix:
--   1. Stamp each status decision with the QA timestamp it was made against (qa_at).
--   2. revert_stale_mri_recon() flips any resolved/not_an_issue row back to 'open'
--      once the underlying abstract has been re-verified at a NEWER qa_at than the
--      decision. Called by both surfaces at load, so the reopen is consistent
--      everywhere and the regressed conflict resurfaces in the default filter.
--
-- Staleness is judged against lease_abstracts.qa_at (the base table the view derives
-- from), NOT the security_invoker view v_mri_reconciliation -- inside a SECURITY
-- DEFINER function the view would run without the caller's JWT and could see nothing.
-- Trade-off: a resolved field whose conflict actually CLEARED on re-verify also gets
-- reopened, but it is no longer emitted by v_mri_reconciliation so that reopen is an
-- invisible no-op (it surfaces nowhere and inflates no count). Only genuinely
-- re-flagged fields become visible again -- exactly the intent.

-- 1. the QA timestamp a status decision was made against (null = pre-feature / untracked)
alter table public.mri_recon_status
  add column if not exists qa_at timestamptz;

-- 2. backfill existing decisions to the current abstract QA timestamp so nothing
--    reverts spuriously on first deploy (only re-verifies AFTER now can trigger it).
--    No-op today (table is empty) but correct if rows exist.
update public.mri_recon_status s
set qa_at = (
  select max(la.qa_at)
  from public.lease_abstracts la
  where la.property_id = s.property_id
    and la.tenant_name = s.tenant_name
)
where s.qa_at is null;

-- 3. reopen stale-resolved rows re-flagged by a newer QA run. Returns the count reopened.
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
    set status = 'open', updated_at = now()
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

-- anon posture (see CLAUDE.md): no PUBLIC/anon execute; staff + edge functions only.
revoke execute on function public.revert_stale_mri_recon() from public, anon;
grant execute on function public.revert_stale_mri_recon() to authenticated, service_role;
