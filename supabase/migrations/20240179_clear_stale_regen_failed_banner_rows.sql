-- 20240179  Mark the 5 stale 'regen_failed' rows seen. NO abstract lost an update -
--           each was verified individually before clearing, not cleared in bulk.
--
-- The /abstracts banner ("Abstract changes from newly-ingested documents") reads
-- abstract_refresh_log where seen=false, and its Dismiss button sets seen=true. Four of
-- these showed permanently as "regeneration failed - retry from the tenant list"; a 5th
-- (MyEyeDr.) was hidden only because the banner caps at 20 rows.
--
-- WHY THEY FAILED: refresh_abstracts.ps1 treated ANY non-200 from lease-abstract as
-- terminal - no retry, and the row recorded no HTTP code. Three of the five failed
-- within FIVE SECONDS of each other (2026-07-22 08:43:18 / :21 / :23), which is one
-- transient burst rather than three defects. Fixed in the same commit: transient classes
-- (000/408/409/429/5xx) now retry 3x with backoff, permanent classes still fail fast, and
-- the http code + attempt count are written to changes so a future failure is diagnosable.
--
-- PER-TENANT VERIFICATION - every one confirmed as no-work-lost:
--   Athlete's Foot  trigger doc 24808086 IS already in the abstract's source_doc_ids
--                   (incorporated by the SUCCESSFUL 7/21 08:56 regen). The 7/22 attempt
--                   was a redundant repeat of finished work.
--   GNC             same pattern - doc 39427625 already incorporated 7/21 08:46.
--   Golf Galaxy     doc c06a5088 IS in source_doc_ids AND generated_at (09:26:10) is two
--                   seconds AFTER the failure row (09:26:07) - the retry actually
--                   succeeded and only the failure got logged.
--   MyEyeDr.        doc fe63f9ba is NOT linked, but it only evidences a construction
--                   allowance the abstract ALREADY carries correctly:
--                   tenant_allowance {psf 80, total 168320} and $80.00 x 2,104 sf =
--                   $168,320 exactly. Nothing to recover.
--   TJ Maxx         doc cd612aed is a property-level Phase I Environmental Site
--                   Assessment with summary-only chunks and ZERO kind='text' chunks. It
--                   matched merely because its title lists occupants ("...including
--                   TJ Maxx, Best Buy, PetSma..."). It is not a TJ Maxx lease document and
--                   correctly never entered the abstract. The roster guard added to
--                   refresh_abstracts.ps1 stops this class recurring: every genuine tenant
--                   document here matches exactly ONE tenant at its property, that ESA
--                   matches two, so 2+ matches = roster = skip.
--
-- Marking seen rather than deleting keeps the audit trail - this is precisely what the
-- UI's own Dismiss button does, applied in bulk after checking each case.

update abstract_refresh_log
set seen = true
where action = 'regen_failed' and seen = false;

-- VERIFIED after applying: unseen regen_failed = 0 (was 5); the 84 unseen 'regenerated'
-- change notices are deliberately untouched - those are informational, not failures.
