-- 20240188 — dispose the 27 remaining override_no_op findings and all 3
-- allowance_missed findings. No abstract values change here; these are dispositions.
-- Notes carry the "[AI-prepared disposition]" prefix and resolved_by is LEFT NULL:
-- final human sign-off is deliberately not forged.

insert into abstract_item_resolutions (abstract_id, item_key, kind, status, note, resolved_by, archived)
select dq.abstract_id, dq.item_key, 'data_quality', 'accepted',
  '[AI-prepared disposition] Benign redundancy - no data is wrong. The flagged override now equals the raw abstract value. In 25 of 27 cases the path is rea_pma.pma_manager: those overrides were correcting the x100 management fee (Gateway 175.00->1.75, KM 310.00->3.10, Magnolia 300.00/275.00->3.00/2.75) and were doing real work until migration 20240182 corrected the RAW value underneath them. In the remainder the raw abstract came into line by a later regeneration or data fix. Left in place - removing them would be churn and they cost nothing. LESSON: a data backfill can turn a working override into a no-op finding.',
  null, false
from v_property_data_quality dq
where dq.check_code = 'override_no_op' and not dq.resolved and dq.abstract_id is not null
on conflict (abstract_id, item_key) do update
  set status = excluded.status, note = excluded.note, kind = excluded.kind,
      archived = false, updated_at = now();

update abstract_item_resolutions r
set note = '[AI-prepared disposition] Benign redundancy - the override sets exclusives.exists=true over a raw value that was already true, so nothing changed. WORTH A LOOK THOUGH: a reviewer reaching for exclusives.exists usually means the companion exact_language needed the correction. Condado is also carrying an open schedule_vs_term finding.',
    updated_at = now()
from lease_abstracts la, properties p
where r.abstract_id = la.id and p.id = la.property_id
  and la.tenant_name = 'CONDADO TACOS 44, LLC'
  and r.item_key = 'text:no-op override';

insert into abstract_item_resolutions (abstract_id, item_key, kind, status, note, resolved_by, archived)
select la.id, 'field:tenant_allowance', 'data_quality', v.status,
       '[AI-prepared disposition] ' || v.note, null, false
from (values
  ('GNC', 'needs_doc',
   'Brief proposes tenant_improvement psf 7.50 @ Art.47, but the quoted clause appears in NO kind=text chunk for this tenant, so there is no positive evidence for the figure. Absence from the text layer is not proof of fabrication (doc-brief and abstract-verify can read attached PDFs the chunk layer misses) but it is not grounds to write a dollar figure either. Migration 20240180 deliberately declined to write it for exactly this reason. NEEDS: a read of the source PDF at Article 47.'),
  ('KOHLS 397', 'waived',
   'NOT a tenant improvement allowance. The brief total 3,240 comes from degraded OCR ("the annual sum of $3,2''l0") describing an ANNUAL PAYMENT for assumed obligations, not a landlord contribution to tenant work. Flipping tenant_allowance.exists on this would be wrong. Waived as a brief misclassification.'),
  ('Cheddar''s Casual Café #0202058', 'waived',
   'The brief classifies this as landlord_to_tenant but it runs the OTHER WAY. Work Letter SSII.D is a "Tenant Contribution": TENANT pays LANDLORD 130,000 toward Landlord''s sitework, escrowed on Lender demand, and non-payment is a Tenant Event of Default. A reviewer already overrode tenant_allowance to exists=false with that verbatim analysis - the abstract is CORRECT and the brief''s direction label is wrong. Waived as a brief misclassification.')
) as v(tenant, status, note)
join lease_abstracts la on la.tenant_name = v.tenant
join v_property_data_quality dq on dq.abstract_id = la.id
     and dq.check_code = 'allowance_missed' and not dq.resolved
on conflict (abstract_id, item_key) do update
  set status = excluded.status, note = excluded.note, kind = excluded.kind,
      archived = false, updated_at = now();
