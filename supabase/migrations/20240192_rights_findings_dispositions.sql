-- 20240192 — the last 4 rights/exclusives findings: 2 corrections + 2 dispositions.
-- Closes mri_flag_only_right and exclusive_not_landlord_restricting, and with them
-- every check class that does not require an AI re-run.

-- 100 Chiro + Salt Grass: co_tenancy exists=true resting on the MRI flag alone. The
-- abstraction standard is explicit - a right whose covenant cannot be quoted is
-- exists=false plus a CONFIRM naming the instrument to obtain. Flip exists, keep the
-- explanatory text (it is the evidence of the search), and prepend the CONFIRM.
update lease_abstracts la
set overrides = coalesce(la.overrides,'{}'::jsonb) || jsonb_build_object(
      'co_tenancy', jsonb_build_object(
        'exists', false,
        'exact_language_and_remedies', null,
        'replacement_tenants_permitted', apply_abstract_overrides(la.abstract,la.overrides)->'co_tenancy'->>'replacement_tenants_permitted',
        'section', apply_abstract_overrides(la.abstract,la.overrides)->'co_tenancy'->>'section',
        'notes', 'CONFIRM: MRI records has_co_tenancy_clause=true but NO operative co-tenancy covenant could be located in the file - obtain the granting instrument. Prior finding text retained: '
                 || coalesce(apply_abstract_overrides(la.abstract,la.overrides)->'co_tenancy'->>'exact_language_and_remedies', '(none)')
      )),
    updated_at = now()
where la.tenant_name in ('100 Chiro Fehrman, LLC', 'Salt Grass');

insert into abstract_item_resolutions (abstract_id, item_key, kind, status, note, resolved_by, archived)
select la.id, v.item_key, 'data_quality', v.status, '[AI-prepared disposition] ' || v.note, null, false
from (values
  ('100 Chiro Fehrman, LLC', 'field:co_tenancy', 'corrected',
   'co_tenancy.exists flipped true -> false per the abstraction standard: the field itself recorded that no distinct co-tenancy clause (opening/operating thresholds triggering abatement or termination) was located as a labeled provision, so the assertion rested on the MRI flag alone. Explanatory text retained inside a CONFIRM naming what to obtain. NOTE this lease is TERMINATED (default judgment recorded), so the practical exposure is nil.'),
  ('Salt Grass', 'field:co_tenancy', 'corrected',
   'co_tenancy.exists flipped true -> false per the abstraction standard. The only support was the 2019 Tenant Estoppel Certificate §7 generically referencing "any exclusive use, co-tenancy, parking ratio or similar restrictions set forth in the Lease" - a boilerplate recital, not an operative covenant, and it quotes none. Retained as a CONFIRM naming the granting instrument to obtain.'),
  ('Ross Dress for Less', 'field:exclusives', 'needs_doc',
   'The exclusive is REAL - full-line department store protection against off-price department stores of 10,000+ sq ft aggregate, with named waiver exceptions for Michaels, Petco and Bed Bath & Beyond in the Exhibits. exists=true is NOT disturbed. What is missing is the VERBATIM covenant: the field holds a paraphrase, and the standard requires the quoted language. A prior pass already hunted the base-lease text layer for it inconclusively. NEEDS: the base-lease exclusive-use article read from the source PDF.'),
  ('Krispy Kreme', 'field:radius_clause', 'accepted',
   'FALSE POSITIVE of the check - no change needed. Migration 20240177 recorded this properly: exists=true with the full verbatim THREE (3) MILE covenant, the 25% Base Rent increase remedy quoted, the struck-through Percentage Rent passage explicitly excluded as non-operative, and a note that MRI has_radius_restriction=false is simply unpopulated. The mri_flag_only_right operative-covenant detector does not recognise this covenant''s phrasing ("will, directly or indirectly conduct business at ... within a radius of three (3) miles"), so it read the field as flag-only. LIMITATION RECORDED rather than chasing the regex a third time.')
) as v(tenant, item_key, status, note)
join lease_abstracts la on la.tenant_name = v.tenant
on conflict (abstract_id, item_key) do update
  set status = excluded.status, note = excluded.note, kind = excluded.kind,
      archived = false, updated_at = now();
