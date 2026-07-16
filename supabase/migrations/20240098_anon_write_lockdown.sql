-- Staff-only app: the anon key ships in the browser bundle, so the anon role
-- must never hold write privileges. RLS was the only gate (and
-- service_agreement_vendors had an always-true policy, making it anon-writable).
-- All legitimate writers are authenticated staff or edge functions running as
-- service_role; the tenant portal only uses the anon key to invoke the edge
-- function gateway, which is unaffected by table grants.
revoke insert, update, delete, truncate on all tables in schema public from anon;
alter default privileges in schema public
  revoke insert, update, delete, truncate on tables from anon;

-- Make the vendor-book policies explicit about who they serve (any staff
-- member may manage the shared vendor list; anon is now also blocked above).
alter policy svc_vendors_insert on public.service_agreement_vendors to authenticated;
alter policy svc_vendors_update on public.service_agreement_vendors to authenticated;

-- Pin search_path on the two remaining linter-flagged functions.
alter function public.tasks_reset_seen() set search_path = public;
alter function public.property_nca(pid uuid) set search_path = public;
