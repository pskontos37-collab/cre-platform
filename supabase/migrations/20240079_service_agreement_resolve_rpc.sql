-- 20240079_service_agreement_resolve_rpc.sql
-- Let property managers mark/restore service-agreement resolutions on their
-- entitled properties (user request 2026-07-12: managers can manually adjust
-- the auto-marked completions). The table's write RLS stays is_admin_or_am()
-- — a broad PM UPDATE policy would let them edit any column via PostgREST.
-- Instead this SECURITY DEFINER RPC touches ONLY the resolution fields, with
-- authorization inside: admins/AMs anywhere, active property managers where
-- can_access_property() grants them the property. The frontend calls this
-- RPC for all resolve/restore actions.
--
-- Passing p_resolution = null restores the agreement into tracking.
-- Cancelled/ignored still demand a non-empty audit note (enforced here AND
-- by the table CHECK from migration 20240078); the audit trigger fires on
-- the inner UPDATE, so every change lands in audit_log with auth.uid().
-- Returns false when the caller isn't permitted or the row doesn't exist.

create or replace function public.resolve_service_agreement(
  p_id uuid,
  p_resolution text,
  p_reason text default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
  v_prop uuid;
begin
  select * into v_user from public.users where id = auth.uid() and is_active;
  if not found then
    return false;
  end if;

  select property_id into v_prop from public.service_agreements where id = p_id;
  if not found then
    return false;
  end if;

  if not (
    public.is_admin_or_am()
    or (v_user.role = 'property_manager' and public.can_access_property(v_prop))
  ) then
    return false;
  end if;

  if p_resolution is null then
    update public.service_agreements
    set resolution        = null,
        resolved_at       = null,
        resolved_by       = null,
        resolved_by_name  = null,
        resolution_reason = null,
        updated_at        = now()
    where id = p_id;
    return true;
  end if;

  if p_resolution not in ('completed', 'cancelled', 'ignored') then
    raise exception 'invalid resolution: %', p_resolution;
  end if;
  if p_resolution <> 'completed' and (p_reason is null or length(btrim(p_reason)) = 0) then
    raise exception 'An audit note is required to mark an agreement %', p_resolution;
  end if;

  update public.service_agreements
  set resolution        = p_resolution,
      resolved_at       = now(),
      resolved_by       = v_user.id,
      resolved_by_name  = coalesce(v_user.full_name, v_user.email),
      resolution_reason = nullif(btrim(coalesce(p_reason, '')), ''),
      updated_at        = now()
  where id = p_id;
  return true;
end;
$$;

revoke all on function public.resolve_service_agreement(uuid, text, text) from public;
grant execute on function public.resolve_service_agreement(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
