-- seed_pipeline.sql — deal pipeline demo content (v2), drawn from the firm's
-- Deal Tracking Sheet (Aquisition Pipeline / Partner Tracking / OM Tracking).
-- Each block inserts ONLY when its table is still empty, so re-running is a
-- no-op once seeded (won't clobber real data entered later).

-- ── Capital partners (LP mandate book) ───────────────────────────────────────
insert into public.capital_partners
  (name, tier, product_types, markets, return_target, leverage, deal_size,
   preferred_hold, fee_structure, relationship_manager, primary_contact, notes)
select * from (values
  ('DRA',              'current', ARRAY['office','retail'], 'Flexible', '17%+', 'Flexible', 'Flexible', '3–5 yr', 'None (excl. property mgmt / promote)', 'John / Marty', 'Dean Sickles', 'Deep, flexible partner across office & retail.'),
  ('MetLife',          'current', ARRAY['retail'], 'Gateway', '12%+', '50–60%', '>$100M', '5 yr+', NULL, 'W: Gregg · E: Marty · SE: John', 'Multiple', 'Core retail in gateway markets; large checks.'),
  ('ALTO',             'current', ARRAY['retail'], 'Agnostic', '17%+', '65%', '$20–100M', '5 yr+', '1% EGR AM fee + $150–225K acq.', 'JW / MS', 'Mody Kidon', 'Value-add + strong cash yields.'),
  ('Center Square',    'current', ARRAY['office','retail'], 'Primary & secondary U.S.', '16%+', 'up to 65%', '$15–50M ($7–20M eq)', '2–5 yr', NULL, 'MS / TS', 'Rob Holuba', 'Overweighted in office; likes non-anchored strip centers.'),
  ('USAA',             'current', ARRAY['retail'], 'Gateway', '12%+', '50–60%', '>$100M', '5 yr+', NULL, 'John', NULL, 'Core retail, gateway markets.'),
  ('Bailard',          'current', ARRAY['retail'], NULL, '16%+ flexible', '60–65%', '<$50M gross', NULL, NULL, 'Matt R.', 'Preston Sargent', 'Retail focus; off office.'),
  ('Bixby Bridge Capital','current', ARRAY['retail'], NULL, NULL, NULL, NULL, NULL, NULL, 'John', 'Steven Fass', 'Bridge / special situations (loan foreclosures).'),
  ('Davis Co.',        'current', ARRAY['retail','office'], NULL, '17%+', NULL, NULL, NULL, NULL, 'Marty', NULL, 'Opportunistic / heavy value-add.'),
  ('Independencia',    'tier1_prospect', ARRAY['retail'], 'Smile states', '12%+', 'up to 70%', '$10–35M', 'up to 7 yr', NULL, 'Marty', 'Jason Rabin', NULL),
  ('Angelo Gordon',    'tier1_prospect', ARRAY['retail','office'], NULL, '16%+ flexible', '60–65%', '$20M min equity', '3–5 yr', 'TBD', 'Marty', 'Christina Lyndon', NULL),
  ('Partners Group',   'tier1_prospect', ARRAY['office'], NULL, '17–18%+', '65%', '$50M min equity', NULL, NULL, 'John', 'Ron LaMontagne', 'Office / MF / industrial — no retail.'),
  ('Atlantic Creek',   'tier1_prospect', ARRAY['office'], 'Top-25 coastal + CHI', '17%+', 'up to 70%', '$5–25M eq', '3–5 yr', '90/10', 'John / Tim', 'Joshua Schwalbe', 'Office & MF value-add; likes medical office.'),
  ('Cerberus',         'tier1_prospect', ARRAY['retail','office'], 'Agnostic', '17%+', '60–65%', '$30M', '3–5 yr', 'TBD', 'Tim', NULL, NULL)
) as v(name, tier, product_types, markets, return_target, leverage, deal_size,
       preferred_hold, fee_structure, relationship_manager, primary_contact, notes)
where not exists (select 1 from public.capital_partners);

-- ── Deals (from the Aquisition Pipeline tab) ─────────────────────────────────
insert into public.pipeline_deals
  (name, asset_type, risk_profile, sub_type, submarket, team, city, state, gla_sf,
   year_built, stage, deal_source, broker, seller, ask_price, price_text,
   going_in_cap, equity_required, probability, bid_text, partner, thesis,
   proj_irr, equity_multiple)
select * from (values
  -- closed
  ('Port Chester Shopping Center','retail','core_plus','Community retail','Suburban',ARRAY['MJS','TS','MHS'],'Port Chester','NY',493495::numeric,2018,'closed','off_market',NULL,NULL,191000000::numeric,NULL,NULL::numeric,NULL::numeric,1.00::numeric,NULL,'MetLife / URS','Dominant grocery-anchored center in an infill Westchester trade area.',NULL::numeric,NULL::numeric),
  ('Keystone Crossing','office','value_add','Suburban office','Suburban',ARRAY['JW','LJ'],'Indianapolis','IN',1054866,NULL,'closed',NULL,NULL,NULL,151000000,NULL,NULL,NULL,1.00,NULL,'DRA','Large suburban office campus; lease-up + mark-to-market value-add.',NULL,NULL),
  ('The Southlands','mixed','value_add','Mixed-use','Suburban',ARRAY['GW','MHS'],'Aurora','CO',917000,NULL,'closed',NULL,NULL,NULL,142000000,NULL,0.0629,NULL,1.00,NULL,'MetLife / URS','Regional mixed-use town center; retail + office + pad reposition.',NULL,NULL),
  ('Midway Plantation / Midtown Commons','retail','value_add','Grocery-anchored','Suburban',ARRAY['MR','LJ'],'Raleigh','NC',323000,NULL,'closed',NULL,NULL,NULL,43600000,NULL,NULL,NULL,1.00,NULL,'Bailard','Two-center Raleigh retail buy; option to acquire together or separately.',NULL,NULL),
  -- under contract / dd
  ('Outlets at Maui','retail','value_add','Outlet retail','Suburban',ARRAY['JW','LJ'],'Lahaina','HI',147843,NULL,'under_contract','off_market',NULL,NULL,12300000,NULL,NULL,5000000,0.75,NULL,'Bixby','Loan foreclosure opportunity; deep-value outlet center in a tourism market.',0.19,1.9),
  -- loi
  ('Town & Country Village','retail','core_plus','Community retail','Suburban',ARRAY['MS','MHS'],'Sacramento','CA',216320,NULL,'loi','marketed',NULL,NULL,62000000,NULL,NULL,24000000,0.50,NULL,'Bailard','Established Sacramento community center; durable cash yield.',0.15,1.65),
  ('Miranova Corporate Tower','office','value_add','CBD office','CBD',ARRAY['JW','MHS'],'Columbus','OH',243500,NULL,'loi',NULL,NULL,NULL,24500000,'Need $32MM',NULL,13000000,0.50,'2nd bid pending',NULL,'CBD office repositioning; capital needed to hit basis.',0.17,1.8),
  -- underwriting
  ('225 West Wacker','office','core_plus','CBD office','CBD',ARRAY['John','Marty','LJ'],'Chicago','IL',650000,NULL,'underwriting','marketed',NULL,NULL,240000000,NULL,NULL,NULL,0.25,'Oct 29',NULL,'Trophy-adjacent CBD office on the Chicago River.',NULL,NULL),
  ('The Rim','retail','core_plus','Power center','Suburban',ARRAY['Marty','LJ'],'San Antonio','TX',1029224,NULL,'underwriting',NULL,NULL,NULL,220000000,NULL,NULL,NULL,0.25,NULL,NULL,'Dominant San Antonio power center; strong sales per SF.',NULL,NULL),
  ('Union Trust Building','office','core_plus','CBD office','CBD',ARRAY['Marty','LJ'],'Pittsburgh','PA',460767,NULL,'underwriting',NULL,NULL,NULL,130000000,NULL,NULL,NULL,0.25,'Early Nov',NULL,'Historic Pittsburgh CBD landmark; credit tenancy.',NULL,NULL),
  ('The Orchard','retail','value_add','Community retail','Suburban',ARRAY['GW','MHS'],'Westminster','CO',700000,NULL,'underwriting',NULL,NULL,NULL,105000000,NULL,NULL,NULL,0.25,'Jul 15',NULL,'Denver-metro retail; anchor mark-to-market thesis.',NULL,NULL),
  ('Corporate 500','office','core_plus','Suburban office','Suburban',ARRAY['JW','MHS'],'Deerfield','IL',696770,NULL,'underwriting','marketed',NULL,NULL,18000000,NULL,NULL,NULL,0.25,'Jul 13','DRA','Deep-basis suburban office park north of Chicago.',NULL,NULL),
  ('Oakland Square & Plaza','retail','value_add','Community retail','Suburban',ARRAY['MS','LJ'],'Troy','MI',391748,NULL,'underwriting',NULL,NULL,NULL,NULL,'Guidance TBD',NULL,NULL,0.25,NULL,'DRA','Detroit-metro retail; awaiting pricing guidance.',NULL,NULL),
  -- sourced / waiting on OM
  ('One DTC','office','value_add','Suburban office','Suburban',ARRAY['LJ','MHS'],'Denver','CO',240931,NULL,'sourced',NULL,NULL,NULL,NULL,NULL,NULL,NULL,0.08,'Waiting on OM',NULL,'Denver Tech Center office; value-add lease-up.',NULL,NULL),
  ('Westshore Office Collection','office','core_plus','Suburban office','Suburban',ARRAY['JW','LJ'],'Tampa','FL',370761,NULL,'sourced',NULL,NULL,NULL,80000000,NULL,NULL,NULL,0.08,'Waiting on OM',NULL,'Tampa Westshore office collection.',NULL,NULL),
  ('Randhurst Village','retail','value_add','Regional retail','Suburban',ARRAY['MR'],'Mt Prospect','IL',966000,NULL,'sourced',NULL,NULL,NULL,NULL,NULL,NULL,NULL,0.08,'Waiting on offering materials',NULL,'Large Chicago-suburban retail village.',NULL,NULL),
  ('The Arsenal on the Charles','office','value_add','Creative office','Suburban',ARRAY['John'],'Watertown','MA',834782,NULL,'sourced',NULL,NULL,NULL,NULL,NULL,NULL,NULL,0.08,'Waiting on offering materials',NULL,'Boston-area creative/office campus.',NULL,NULL)
) as v(name, asset_type, risk_profile, sub_type, submarket, team, city, state, gla_sf,
       year_built, stage, deal_source, broker, seller, ask_price, price_text,
       going_in_cap, equity_required, probability, bid_text, partner, thesis,
       proj_irr, equity_multiple)
where not exists (select 1 from public.pipeline_deals);

-- ── Sample LP funnel on the two active raises ────────────────────────────────
insert into public.pipeline_deal_lps (deal_id, partner_id, status, soft_amount, committed_amount, notes)
select d.id, p.id, x.status, x.soft, x.committed, x.notes
from (values
  ('Town & Country Village','Bailard','soft_circle',15000000::numeric,NULL::numeric,'Verbal soft-circle; committee in 2 weeks.'),
  ('Town & Country Village','DRA','reviewing',NULL,NULL,'Backup LP; reviewing the model.'),
  ('Outlets at Maui','Bixby Bridge Capital','committed',NULL,5000000,'Foreclosure play; Bixby funding the equity.')
) as x(deal_name, partner_name, status, soft, committed, notes)
join public.pipeline_deals d on d.name = x.deal_name
join public.capital_partners p on p.name = x.partner_name
where not exists (select 1 from public.pipeline_deal_lps);

-- ── OM intake rows (from the OM Tracking tab) ────────────────────────────────
insert into public.om_intake (deal_id, requestor, deal_name, city, state, date_requested, om_received, base_model, spoke_to_broker, taxes_updated, comments)
select d.id, x.req, x.deal_name, x.city, x.state, x.requested, x.received, x.base, x.broker, x.taxes, x.comments
from (values
  ('LJ / MHS','One DTC','Denver','CO',date '2026-06-28', true,  'partial', false, false, NULL),
  ('JW / LJ','Westshore Office Collection','Tampa','FL',date '2026-06-24', true, 'none', false, false, NULL),
  ('MR','Randhurst Village','Mt Prospect','IL',date '2026-06-21', false, 'none', false, false, 'Chasing the broker for offering materials.')
) as x(req, deal_name, city, state, requested, received, base, broker, taxes, comments)
left join public.pipeline_deals d on d.name = x.deal_name
where not exists (select 1 from public.om_intake);
