-- 20240154_comps_restore_security_invoker.sql
-- Repairs a defect introduced by 20240153 in this same session.
--
-- CREATE OR REPLACE VIEW RESETS reloptions THAT THE NEW STATEMENT DOES NOT RESTATE. 20240153
-- replaced comps.v_assumption, v_tenant_assumption, v_market_coverage and v_assumption_rollup
-- without a WITH (security_invoker = true) clause, which silently stripped that flag from all
-- four. Only comps.v_quarantine_review kept it -- because 20240153 never touched it.
--
-- WHY THIS MATTERS RATHER THAN BEING COSMETIC: these views are owned by 'postgres', and
-- postgres has rolbypassrls = true on this project. A view without security_invoker executes
-- with the OWNER's identity, so RLS on comps.assumption / assumption_set / source_document /
-- source_property was no longer being enforced through those four views, and the INVOKER's own
-- table grants were no longer checked either -- which is exactly the class of defect that hid
-- the missing v_tenant_assumption grant until 20240143.
--
-- The four views did still return zero rows for a non-admin when measured, but only because
-- 20240153 also made v_assumption inner-join comps.v_document_version, which DOES carry the
-- flag. That is accidental protection resting on one join surviving; it is not the posture the
-- schema was designed with. Restore the flag explicitly.
--
-- No view definition changes here. Options only.
alter view comps.v_assumption        set (security_invoker = true);
alter view comps.v_tenant_assumption set (security_invoker = true);
alter view comps.v_market_coverage   set (security_invoker = true);
alter view comps.v_assumption_rollup set (security_invoker = true);

-- Belt and braces for the two 20240153 created, so a future reader sees all seven asserted in
-- one place rather than split across two migrations.
alter view comps.v_document_version   set (security_invoker = true);
alter view comps.v_assumption_vintage set (security_invoker = true);
alter view comps.v_quarantine_review  set (security_invoker = true);
