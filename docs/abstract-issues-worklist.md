# Lease Abstract QA Worklist — 2026-07-08

**Context:** all 98 abstracts regenerated on `lease-abstract` v21 against the completed verbatim-text
corpus, then re-verified on `abstract-verify` v4 (Opus, adversarial). Result: **2 verified / 48 review /
48 issues** (0 unverified; 12 locked/human-verified were not touched).

**Read the severity honestly:** the "issues" bucket over-weights `needs_source`/unconfirmable-date flags —
nearly every summary opens with *"largely trustworthy / correctly identifies the controlling amendment"* and
then names **one or two specific defects**. This is a targeted fix list, not 48 broken abstracts. Full per-field
detail lives in `lease_abstracts.qa` and the AbstractsPage QaPanel.

Machine categories: **A-stale 13** (amendment_currency.current=false) · **B-error 34** (≥1 high-sev field check) ·
**C-mri 1**.

---

## Group 1 — Superseded / spurious base-rent rows  → **fix via v20 prompt + regen** (highest leverage)
Root cause: prompt line 343 said "list every rent period … historical if shown", which invites carrying forward
rows from superseded amendments or padding the schedule. v20 fix (below) constrains `base_rent_schedule` to the
CURRENT controlling instrument only.
- **Bass Pro Shop** (Magnolia) — lists renewal rows the Third Amendment §3(L) expressly deleted/replaced.
- **BEV MAX Liquors** (Gateway) — schedule = superseded 2009 pre-relocation rent, not the governing 2013 Relocation Agreement.
- **GNC** (KM East) — spurious extra base-rent row beyond the Fifth Amendment schedule.
- **Subway #37092** (KM East) — base_rent_schedule row inconsistent with the controlling First Amendment.
- **Music and Arts** (Magnolia) — base-rent PSF/annual rows contain a material error vs the amendment.
- **Salt Grass** (KM East) — square-footage discrepancy vs the Third Amendment premises.
- **TJ Maxx** (KM West) — term_years overstated as 20 (original term is 10).

## Group 2 — Dates/SF adopted from MRI or the wrong exhibit  → **prompt: never present an MRI/derived value as confirmed**
The abstract populated a field from the MRI system-of-record (or a projected schedule) and presented it as a
documented value instead of `null` + `CONFIRM`.
- **100 Chiro Fehrman** (Magnolia) — SF 1,775 vs lease-defined 1,800; commencement/expiration imported from MRI.
- **SSI Greenville** (Magnolia) — adopts MRI commencement over the documented date.
- **HomeGoods, Inc.** (KM East) — two date defects layered over the correct CDA.
- **Restore Hyper Wellness** (Gateway) — rent-commencement/expiration/schedule vs the executed Confirmation.
- **Firebird's Wood Fired Grill** (Magnolia) — schedule vs the executed Confirmation of Commencement.

## Group 3 — MRI conflict where the ABSTRACT is correct  → **no abstractor action; reconcile MRI (data task)**
The abstract correctly held the documented value; MRI is the stale/other side. Route to MRI reconciliation.
- **Cheddar's Casual Café** (Magnolia) — MRI implies an undocumented 2031 second renewal; abstract holds documented 2026-09-30.
- **Results Physiotherapy** (KM West) — MRI reconciliation flag only (C-mri).
- **Wells Fargo** (KM East) — amendment chain correct; residual conflict vs system-of-record.

## Group 4 — Fabricated ancillary values  → **v20 grounding tighten + regen**
Values with no supporting document (the grounding block should have caught these; v20 hardens guarantor + ancillary).
- **Bad Daddy's Burger Bar** (Magnolia) — guarantor name/existence unsupported by any attached doc.
- **Woodhouse Day Spa** (Magnolia) — invented "Letter Agreement dated 2025-11-10".
- **Dave & Busters** (Magnolia) — fabricated current term/expiration (2034-11-30) and rent-commencement.

## Group 5 — Missing / oversized controlling doc  → **human review or ingest (regen won't fix)**
- **Ross Dress for Less** (KM East) — 30-doc lease; regenerated text-only (forfeits PDF grounding). Needs the controlling Acknowledgment of Commencement re-attached or a manual pass.
- **Kay Jewelers** (KM East) — attached PDFs belong to the superseded TRIDEVS/Kay's Hallmark tenancy; current 2016 Sterling lease only reached via text. Re-scope attachments.
- **Destination XL** (Magnolia) — resolved to "Casual Male (DXL)" via file_aliases; re-confirm the extension doc is now in-file.

## Group 6 — Broken generation  → **re-investigate**
- **European Wax Center** (KM West) — abstract is EMPTY `{}`. Generation produced nothing (likely doc-set/alias miss). Re-check the tenant folder + file_aliases, then regen.

---

## Amendment-stale (13, category A) — triage each: wrong-instrument vs genuinely-missing-amendment
`HOMEGOODS LLC 507` (Gateway) · `Another Broken Egg Café` (Magnolia) · `European Wax Center` (KMW, see Group 6) ·
`TJ Maxx` (KMW) · `Nordstrom Rack` (Magnolia) · `Ross Dress for Less` (KME) · `Restore Hyper Wellness` (Gateway) ·
`Regal Cinemas` (Magnolia) · `Starbuck's` (KMW) · `Dave and Busters` (Magnolia) · `BEV MAX Liquors` (Gateway) ·
`Burlington Coat Factory` (Gateway) · `Wells Fargo` (KME).
For each: if the controlling amendment IS in the file, v20+regen should fix it; if the amendment is genuinely
missing from the corpus, it's an ingest/human task (flag in MRI reconciliation).

## Reprocess procedure (after v20 deploys)
1. `deploy_edge.ps1 -Slug lease-abstract`
2. `batch_abstracts_regen.ps1 -Since <v20 deploy time> -Shard 0..3 -Of 4` (skips locked)
3. `batch_verify.ps1 -Shard 0..3 -Of 4`
4. Re-pull the qa_status distribution; the Group-1/2/4 items should clear or downgrade to `review`.
