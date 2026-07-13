-- 20240089_mri_recon_scope.sql
-- Scope the MRI-reconciliation queue to what it should actually be: places where
-- the lease documents and the MRI SYSTEM OF RECORD genuinely disagree on a field
-- MRI is the source of truth for.
--
-- The prior view expanded EVERY item the QA verifier dropped into qa.mri_reconciliation,
-- which turned out to be ~536 rows of mostly noise:
--   * ~200 were AGREEMENTS — the verifier logged a row even when abstract == MRI,
--     with a note literally saying "Agree." Those are not conflicts.
--   * ~97 were security_deposit / ti_allowance / breakpoints — economic terms the
--     LEASE governs; the MRI rent roll doesn't carry them, so they always "differ".
--   * ~86 were tenant-name rows — legal name vs DBA formatting, never a real conflict.
--
-- MRI (the RETAILRR rent roll) is the system of record for the CURRENT-term dates,
-- leased SF, suite, current base rent, and the percentage-rent flag. Everything else
-- is documents-govern and does not belong in an MRI-correction queue. This view now
-- surfaces only genuine differences on MRI-governed fields. (The QA prompt is also
-- being fixed so future verifications stop emitting the agreements/non-governed rows
-- in the first place; this view protects the queue for already-stored verdicts too.)

create or replace view public.v_mri_reconciliation
with (security_invoker = true) as
with expanded as (
  select
    la.property_id,
    p.name                                as property_name,
    la.tenant_name,
    item->>'field'                        as field,
    item->>'abstract_value'               as abstract_value,
    item->>'mri_value'                    as mri_value,
    coalesce(item->>'governs', 'unclear') as governs,
    item->>'note'                         as note,
    la.qa_at
  from public.lease_abstracts la
  join public.properties p on p.id = la.property_id
  cross join lateral jsonb_array_elements(coalesce(la.qa->'mri_reconciliation', '[]'::jsonb)) as item
  where la.qa is not null
),
classified as (
  select *,
    lower(regexp_replace(coalesce(abstract_value, ''), '\s+', '', 'g')) as av_norm,
    lower(regexp_replace(coalesce(mri_value, ''),      '\s+', '', 'g')) as mv_norm,
    lower(coalesce(note, ''))                                           as note_l,
    lower(coalesce(field, ''))                                          as field_l
  from expanded
)
select property_id, property_name, tenant_name, field, abstract_value, mri_value, governs, note, qa_at
from classified
where
  -- (1) a real difference: drop rows where the two sides carry the same value
  (av_norm <> mv_norm or av_norm = '' or mv_norm = '')
  -- (2) drop the verifier's "they agree" confirmations
  and note_l !~ '^(agree|consistent|both agree|both show)'
  and note_l not like '%abstract and mri agree%'
  and note_l not like '%both agree%'
  -- (3) MRI system-of-record fields only: current commencement/expiration, leased
  --     SF, suite/unit, current base rent, percentage-rent flag ...
  and field_l ~ '(commenc|expir|leased_sf|square|suite|unit|base_rent|minimum rent|percentage_rent|has_percentage)'
  -- ... but NOT the documents-govern fields (deposits, TI, breakpoints, guarantor,
  --     legal/trade-name formatting) that are not MRI's to be right about.
  and field_l !~ '(name|security_deposit|ti_allowance|breakpoint|guarantor)';

grant select on public.v_mri_reconciliation to authenticated;
