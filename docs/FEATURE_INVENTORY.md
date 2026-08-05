# Feature inventory — route-by-route (feature-to-test matrix)

Status legend: **OK✓** = verified working (signed-in UI checks 8/01–8/03 + this pass) ·
**OK** = live, no defects known, not re-verified this pass · **AI-DOWN** = code sound,
feature dead until Anthropic credits restored (KI-1) · **BLOCKED** = missing external
input (see KNOWN_ISSUES) · **UNTESTED** = never exercised end-to-end.

Roles: A=admin, AM=asset_manager, PM=property_manager (property-scoped), T=tenant (portal).
Unit-test coverage is for the underlying `src/lib` math; page-level E2E does not exist (gap noted below).

| Route | Feature | Status | Roles | Key sources | Tests / evidence |
|---|---|---|---|---|---|
| `/login`, `/reset-password` | Supabase auth, password reset | OK✓ | all staff | LoginPage, AuthContext | Live-verified incl. missing-env banner (8/04) |
| `/portal` | Tenant portal: work orders + photos | OK | T (custom auth) | TenantPortalPage, portalApi, work-orders fn | Security section in [[project-work-orders]]; gateway-only anon use |
| `/` | Dashboard: role presets, widgets (DSCR, health, exec snapshot, co-tenancy alerts) | OK✓ | all | pages/DashboardPage, components/dashboard/*, useDashboard | financials.test (NOI/DSCR); UI verified 8/03 |
| `/tasks` | Tasks + assignments | OK | all | TasksPage, `assignable_users()` RPC | RPC needed because users RLS hides rows |
| `/pipeline` | Acquisitions: deals, stages, comps, underwriting, meeting deck | OK✓ | A/AM | PipelinePage, usePipeline, acqUnderwriting, tenantUnderwriting, PipelineMeetingDeck | **acqReturns.test (18) + tenantUnderwriting.test (9) + acqPromote/buyBox/partnerMatch tests**; comps perf fix proven 7/29 |
| `/ppm` | PPM generator | AI-DOWN (draft) / OK (assembly) | A/AM | PpmBuilderPage, lib/ppm, ppm-draft fn | reports render client-side |
| `/ask` | Doc-ask RAG over 16.4k docs | AI-DOWN | all | AskPage, doc-ask fn | hybrid retrieval + HNSW verified pre-outage |
| `/properties`, `/properties/:id` | Property hub; 22 shells collapsed behind toggle | OK✓ | all (PM scoped) | PropertiesPage, PropertyDetailPage, usePropertyHub | Shipped `6c26d4b` 8/04; typecheck+tests green |
| `/siteplans` | Site-plan viewer + extraction | AI-DOWN (extract) / OK (view) | all | SitePlansPage, siteplan-extract fn | vision needs enumerate-first (memory) |
| `/financials` | GL income statement; picker limited to loaded properties | OK✓ | all (PM scoped) | FinancialsPage, useFinancials, v_gl_pnl_* views | View guards verified this pass (docs/SECURITY.md) |
| `/receivables` | AR aging + follow-up drafts (.eml) | OK | A/AM | ReceivablesPage, ArAgingReport | Outlook .eml test still open with owner |
| `/rea` | REA agreements (Knightdale members; `rea_agreements` is truth) | OK | A/AM | ReaPage | zero-SF suite convention (memory rule 9) |
| `/services`, `/services/new` | Service-agreement tracker + builder (docx→PDF→e-sign) | OK / send BLOCKED | A/AM | ServiceAgreements*, serviceAgreement/renderPdf, *-send fn | renderPdf typecheck fixed this pass; sends need Resend (KI-2) |
| `/brokerage` | Brokerage engagements (most expired) | OK | A/AM | BrokeragePage | |
| `/transactions` | Transactions ledger | OK | A/AM | TransactionsPage, components/transactions | can_access_transaction RPC verified gated |
| `/waterfall` | Sell-today waterfall (2-layer promote, Class D, Knightdale override) | OK✓ | A/AM | WaterfallPage, lib/waterfall, waterfallExcel | **irrWaterfall.test (22) golden JV fixtures**; toDate fix this pass |
| `/investors` | Distribution ledger + quarterly PDF | OK | A/AM | InvestorsPage, distributionLedger, InvestorReport | **distributionLedger.test (10) — new this pass** |
| `/management` | PMA terms, effective-stack merge, abstract pack | OK | A/AM only (role-gated in page) | ManagementPage, useManagementAgreements | keyof-typed field access fixed this pass; fees verified vs PMAs |
| `/documents` | Corpus browser, upload, dedup-aware counts | OK✓ | all (PM scoped) | DocumentsPage | dedup counting convention (memory) |
| `/pcf` | Projected cash flow, FY25/26 tie-outs, immutable published versions | OK✓ | A/AM | PcfPage, usePcf, pcf_grid RPC | **pcfVariance.test (11)**; usePcf union fix this pass; FY2025 CLOSED |
| `/monthly-reports` | Per-property monthly PDF | OK | A/AM | MonthlyReportsPage | |
| `/forms` | Forms library (loader re-run = refresh) | OK | all | FormsPage | |
| `/emergency-manuals` | Emergency manuals | OK | all | EmergencyManualsPage | Word-COM render trap documented |
| `/contacts` | Contacts + xlsx import | OK | all | ContactsPage, contactsExcel | 24 leases need manual entry (owner) |
| `/announcements` | Tenant announcements | send BLOCKED | A/AM | AnnouncementsPage, announcement-send fn | KI-2 |
| `/workorders` | Work orders + R&M matrix | OK | all staff | WorkOrdersPage, workOrderMeta | |
| `/insurance` | COI tracker (ACORD parse + routing) | AI-DOWN (parse) / OK (track) | A/AM | InsurancePage, coi-extract fn | |
| `/inspections`, `/inspect` | Inspection app + field capture w/ photos | OK | all staff | InspectionsPage, InspectFieldPage, lib/inspection | storage-upload conventions in memory |
| `/abstracts` | Lease abstracts: generate, QA, overrides, locks | AI-DOWN (gen/QA) / OK✓ (view/override) | all (PM scoped) | AbstractsPage, abstract-* fns | **requote/verifyStatus/citation tests (45)**; overrides are the human layer — never judge from raw abstract |
| `/review` | Review Center: 4 detection layers incl. standing data-quality checks | OK✓ | A/AM | ReviewCenterPage, v_property_data_quality | 140 open findings tracked; shipped 8/02–8/03 |
| `/imports` | Excel import pipeline (GL/RR/budgets, column mapping) | OK | A/AM | ImportsPage, apply_mri_import RPC | RPC gate verified this pass; budgets awaiting owner files |
| `/doc-control` | Document accountability / register | OK | A/AM | DocControlPage | ordinal gaps ≠ doc gaps (memory) |
| `/onboarding` | 5-step property onboarding wizard | **UNTESTED (step 4)** | A/AM (action-gated) | OnboardingPage, complete_property_onboarding RPC | Rent-roll upload needs OWNER's file; RPC gate verified |
| `/clauses` | Clause search + exclusives registry | OK (search AI-degraded) | all | ClausesPage, clause-search fn | 500-char truncation trap fixed historically |
| `/diligence` | Deal diligence checklists + docs | OK | A/AM | DiligencePage | |
| `/mri-recon` | MRI reconciliation queue + stale-revert | OK | A/AM | MriReconPage, revert_stale_mri_recon RPC | reopens stale-resolved conflicts by design |
| `/market` | Market reports | AI-DOWN | A/AM | MarketReportsPage, market-reports fn | |
| `/admin` | Users, access templates, firm settings | OK✓ | A only | AdminPage, admin-users fn | access.test (8) covers permission rules |
| `*` | 404 fallback | OK | all | App.tsx | |

## Cross-cutting gaps (honest)

1. **No page-level E2E suite.** All 200 automated tests target `src/lib` pure logic.
   Page verification is manual (signed-in browser passes 8/01–8/03 + this pass's
   login/startup checks). A Playwright smoke (login → dashboard → 3 pages) is the
   next-best test investment once a staging environment exists — running E2E
   against the single production DB is not acceptable.
2. **AI features are unverifiable until credits return** (KI-1) — their last-known
   states are recorded in project memory (lease-abstract v33, abstract-verify v17,
   doc-ask v19).
3. **Integration tests against a real DB do not exist** — there is no test
   database; the prod project is the only environment (docs/OPERATIONS.md).
   RLS/authz were verified against prod read-only on 7/30 (129/129 tables) and
   re-verified for the P&L views + destructive RPCs this pass.
