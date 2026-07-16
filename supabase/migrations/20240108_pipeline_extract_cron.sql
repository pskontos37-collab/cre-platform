-- Server-side underwriting extraction cron (task #26).
-- Moves the storage-only extraction (T-12 recoverable-OpEx split) off the
-- interactive Windows weekly task and onto pg_cron -> pg_net -> the uw-extract
-- edge function, so already-mirrored docs get extracted even when nobody is
-- logged on. The K:\-and-Excel steps (mirror, model->PDF, site-plan raster) stay
-- in the local weekly chain (refresh_pipeline.ps1) — only the storage+Claude half
-- runs here.
--
-- ⚠️ DEPLOY ORDER (all gated on the user saying "deploy"):
--   1. deploy_edge.ps1 -Slug uw-extract          (function must exist first)
--   2. store the service-role key in Vault so cron can authenticate:
--        select vault.create_secret('<SERVICE_ROLE_KEY>', 'uw_extract_service_key',
--                                   'service-role bearer for the uw-extract cron');
--   3. apply THIS migration.
-- Until steps 1-2 are done the scheduled job will error harmlessly (no function /
-- no secret); nothing else depends on it. The local scripts remain the source of
-- truth until this is deployed and a live run is verified.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Weekly safety net: Saturday 06:10 (after Friday's local refresh at 15:00 has had
-- time to land the week's mirror). Batch mode fills only deals whose tenant model
-- still has no recoverable-OpEx figure; the function is idempotent and posts one
-- [AI] audit comment per deal. Authenticates as service_role via the Vault secret.
select cron.schedule(
  'pipeline-uw-extract-weekly',
  '10 6 * * 6',
  $$
  select net.http_post(
    url     := 'https://vsqcykdpilfaockyfhuk.supabase.co/functions/v1/uw-extract',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'uw_extract_service_key')
               ),
    body    := jsonb_build_object('force', false),
    timeout_milliseconds := 300000
  );
  $$
);

-- To remove: select cron.unschedule('pipeline-uw-extract-weekly');
