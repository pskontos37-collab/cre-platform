# Exclusives-field audit — 2026-07-12

Full classification of the `exclusives` field across all 98 production abstracts (v1
generations), run after the user caught another tenant's exclusive displayed under the wrong
tenant and permitted uses shown as exclusives on /clauses. Every defect finding below was
adversarially re-verified by an independent second pass (16-agent audit; first-pass errors were
overturned — e.g. V Nail Bar's Ulta-waiver reference was correctly ruled a legitimate condition
inside its own exclusive, and HomeGoods' carve-out list naming Buy Buy Baby was ruled correct).

## Result

| Verdict | Count | Meaning |
|---|---|---|
| tenant_own | 59 | Genuine own exclusive, correctly filed |
| none | 19 | exists=false/null — correct where no exclusive |
| **other_tenants_exclusive** | **7** | ANOTHER tenant's protection filed as this tenant's exclusive |
| **mixed** | **5** | Own exclusive + other tenants' restrictions mushed together |
| **permitted_use_conflation** | **3** | Tenant's own permitted-use/non-compete language misread as an exclusive |
| **unsupported_no_language** | **5** | exists=true with no operative protection quoted (MRI note code / paraphrase only) |

**20 of 98 defective (≈1 in 5).** The defect list (regen acceptance test — after the v2
rebuild regenerates these tenants, every row must land in `use_restrictions_on_tenant`,
`permitted_use`, or `exclusives.exists=false` as appropriate):

| Tenant | Property | Defect |
|---|---|---|
| CKE Fitness Corp | Gateway | other_tenants_exclusive (Exhibit C existing exclusives binding tenant) |
| DSW #29193 | Gateway | other_tenants_exclusive (a beauty retailer's cosmetics exclusive shown as the SHOE store's own; identical text also planted in Club Pilates — copied from the existing-exclusives exhibit; DSW's real footwear protection sits under prohibited_uses) |
| J. Crew | Gateway | other_tenants_exclusive (Buy Buy Baby's infant/children exclusive; the abstract itself admits "appears to be an existing exclusive of another tenant" and files it anyway) |
| Qdoba | KM West | other_tenants_exclusive (Exhibit E exclusive/prohibited uses binding Qdoba) |
| Sport Clips | KM East | other_tenants_exclusive (Exhibit D schedule protecting Lee Spa Nails, Rita's, Subway, GNC…) |
| Staples #4 | Gateway | other_tenants_exclusive |
| T-Mobile | KM East | other_tenants_exclusive |
| Club Pilates | Gateway | mixed (own fitness exclusive + the same beauty exclusive as DSW) |
| Island Nails Spa | KM East | mixed (own Buildings-K/L nail exclusive + permitted use + Exhibit D burden) |
| Moe's Southwest Grill | KM East | mixed (own QSR-Mexican exclusive + Exhibit D others appended) |
| TJ Maxx | KM West | mixed (own apparel exclusive + Best Buy's electronics + Petco/PetSmart pet exclusives appended as "Additional exclusives") |
| Yard House | Magnolia | mixed (own beer exclusive + Exhibit H recital of other tenants' exclusives) |
| BEV MAX LIQUORS | Gateway | permitted_use_conflation (§12A permitted use + §12D tenant non-compete — both bind the TENANT) |
| JINYA Ramen Bar | Magnolia | permitted_use_conflation (only the permitted-use clause quoted) |
| Nordstrom Rack | Magnolia | permitted_use_conflation (demise/possession wording "for Tenant's exclusive use" misread as a competition exclusive) |
| Blue Cross Blue Shield | Magnolia | unsupported (exists=true on an MRI "EXCLUSIV" note code; language admittedly never located) |
| Elase | Magnolia | unsupported (section TITLE cited, language not captured) |
| Krispy Kreme | KM East | unsupported (paraphrase asserting exclusivity, no covenant quoted) |
| Old Navy #4885 | Gateway | unsupported (one-line paraphrase; MRI says has_exclusives=false) |
| VISION WORLD | Gateway | unsupported (MRI flag only) |

Machine-readable copy: session scratchpad `exclusives_defects.json` (regen validation input);
full dataset `exclusives_dataset.json`.

## Root-cause mechanism (why v1 produced these)

1. **One flat field.** The v1 schema had a single `exclusives` slot and NO
   `use_restrictions_on_tenant`. When the model met exclusive-flavored language burdening the
   tenant (existing-exclusives exhibits, Riders), the only place to put it was `exclusives` —
   J. Crew proves the model KNEW it was another tenant's protection and filed it there anyway.
2. **No beneficiary test.** The prompt never asked "who does this covenant protect?" — the
   distinction between a landlord covenant FOR the tenant vs a restriction ON the tenant was
   undefined, so demise language ("for Tenant's exclusive use") and tenant non-competes passed
   as exclusives.
3. **Truncation.** With ~11–30% of big leases read, the model often saw the exhibit or a
   summary but not the actual grant section — so it quoted whatever "exclusive-ish" text it had.
4. **MRI flag pressure.** `has_exclusives=true` in the cross-check nudged exists=true even when
   no language was found (all 5 "unsupported" rows).

## How the v2 rebuild kills each mechanism

1. Schema v2 splits `exclusives` (own protection, with remedies/conditions) from
   `use_restrictions_on_tenant` (others' exclusives, with source_exhibit) from
   `permitted_use`/`prohibited_uses` — the misfile slot now exists.
2. doc-brief clause taxonomy labels language at extraction time (`tenant_exclusive` vs
   `use_restrictions_on_tenant` vs `permitted_use`), and the synthesis prompt applies the
   beneficiary test explicitly ("if you cannot quote language protecting THIS tenant,
   exclusives.exists=false; an MRI note code is NOT evidence").
3. Briefs read 100% of every document — the grant section is always seen.
4. abstract-verify v2 carries an EXCLUSIVES DISCIPLINE check at severity HIGH ("poisons leasing
   decisions"), so any recurrence forces qa_status=issues.
