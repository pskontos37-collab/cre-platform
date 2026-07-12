-- seed_partners_2026.sql — rebuild capital_partners from the current (7/10/26)
-- Partner Tracking tab. CLEAN REPLACE (cascades pipeline_deal_lps). Run AFTER the
-- deal loader (which also clears the LP funnel).

delete from public.capital_partners;

insert into public.capital_partners
  (name, tier, product_types, markets, return_target, leverage, deal_size, preferred_hold, fee_structure, relationship_manager, primary_contact, notes)
values
  -- ── Current partners ──
  ('DRA','current',ARRAY['office','retail'],'Flexible','17%+','Flexible','Flexible','3-5 yr','None (excl. property mgmt / promote)','John / Marty','Dean Sickles','Deep, flexible partner across office & retail.'),
  ('Ballard','current',ARRAY['retail'],NULL,'16%+ flexible','50-55%','<$50M gross',NULL,NULL,'Marty','James Pinkerton / Alex Spotswood / Preston Sargent',NULL),
  ('MetLife','current',ARRAY['retail'],'Gateway','12%+','50-60%','>$100M','5 yr+',NULL,'W: Gregg / E: Marty / SE: John','Multiple','Core retail in gateway markets; large checks.'),
  ('Center Square','current',ARRAY['office','retail'],'Primary & secondary U.S.','16%+','up to 65%','$15-50M ($7-20M eq)','2-5 yr',NULL,'Marty','Rob Holuba','Overweighted in office; likes non-anchored strip.'),
  ('ALTO','current',ARRAY['retail'],'Agnostic','17%+','65%','$20-100M','5 yr+','1% EGR AM fee + $150-225K acq.','Marty','Mody Kidon','Value-add + strong cash yields.'),
  ('USAA','current',ARRAY['retail'],'Gateway','12%+','50-60%','>$100M','5 yr+',NULL,'John',NULL,'Core retail, gateway markets.'),
  ('Big Shopping Centers','current','{}',NULL,NULL,NULL,NULL,NULL,NULL,'Marty',NULL,'3rd-party candidate.'),
  ('Intercontinental','current','{}',NULL,NULL,NULL,NULL,NULL,NULL,'John',NULL,NULL),
  ('Slate','current','{}',NULL,NULL,NULL,NULL,NULL,NULL,'Marty',NULL,NULL),
  ('Davis Co.','current',ARRAY['retail','office'],NULL,'17%+',NULL,NULL,NULL,NULL,'Marty',NULL,'Opportunistic / heavy value-add.'),
  ('Bixby','current',ARRAY['retail'],NULL,NULL,NULL,NULL,NULL,NULL,'John','Gu Gong / Michael Battin','Bridge / special situations.'),
  -- ── Tier 1 prospects ──
  ('NY Life','tier1_prospect','{}',NULL,'12%+','50-65%','$10-20M equity',NULL,NULL,'Marty','Kevin Smith',NULL),
  ('Nuveen','tier1_prospect','{}',NULL,'Value-add / Core-Plus','50-65%',NULL,NULL,NULL,'Gregg / John','Multiple',NULL),
  ('JP Morgan','tier1_prospect','{}',NULL,'Value-add / Core-Plus','50-65%',NULL,NULL,NULL,'Gregg','Adria Savarese / Kiley Watumull','More focused on mixed-use value-add.'),
  ('Angelo Gordon','tier1_prospect',ARRAY['retail','office'],NULL,'16%+ flexible','60-65%','$20M min equity','3-5 yr','TBD','Marty / Gregg','Scott Glassberg / James Idol',NULL),
  ('Independencia','tier1_prospect',ARRAY['retail'],'Smile states','12%+','up to 70%','$10-35M','up to 7 yr',NULL,'Marty','Jason Rabin',NULL),
  ('Partners Group','tier1_prospect',ARRAY['office'],NULL,'17-18%+','65%','$50M min equity',NULL,NULL,'John','Ron LaMontagne','Office / MF / industrial - no retail.'),
  ('GEM','tier1_prospect',ARRAY['office','retail'],'Southeast','18% gross VF / 12%+ Core+','up to 65%','$20M min; $110M max','3-5 yr (VA) / 10 yr (Core+)','Two-tier promote (~160 bps run-off)','Gregg','Derek Lopez / Jeff Holmes','Niche product focus; still looks at one-off office/retail.'),
  ('Oaktree Capital','tier1_prospect',ARRAY['office'],NULL,'Opp 18%+ / Core+ 12% IRR','','$40M min equity',NULL,NULL,'Marty','Todd Liker','Office focused (Zeller, Golub, Glenstar).'),
  ('Artemis','tier1_prospect','{}','DC, CHI, Miami, NY, LA, SF, Austin, Houston, Dallas, Raleigh, Seattle, San Diego, Denver, Boston','Project-levered 12-13%','50-60% LTV',NULL,NULL,NULL,'Marty','Michael Stratton','Building/tenant/location quality.'),
  ('Atlantic Creek Partners','tier1_prospect',ARRAY['office'],'Top-25 coastal + CHI','17%+','up to 70%','$5-25M eq ($30-40M gross)','3-5 yr','90/10','Tim','Joshua Schwalbe','Office & MF value-add; medical office.'),
  ('Quartz Lake Capital','tier1_prospect',ARRAY['office','retail'],'Atlanta, Austin, Boston, Charlotte, CHI, Dallas, DEN, Houston, LA, Nashville, NY, Orlando, PHX, Pittsburgh, PDX, Raleigh, Salt Lake, San Diego, SF, Seattle, SoFL, Tampa, DC','Value-Add to Opportunistic','up to 75%','$25-250M gross',NULL,NULL,'Marty','David Nielsen','MF, office (incl. medical), industrial; retail selectively.'),
  ('Cerberus','tier1_prospect',ARRAY['retail','office'],'Agnostic','17%+','60-65%','$30M','3-5 yr','TBD','Tim',NULL,NULL),
  ('True North','tier1_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,'Gregg',NULL,NULL),
  ('Goldman Sachs','tier1_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,'Gregg',NULL,NULL),
  ('National Real Estate Advisors','tier1_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,'Marty',NULL,NULL),
  ('Exan','tier1_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,'Marty',NULL,NULL),
  ('Crescent','tier1_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,'Marty',NULL,NULL),
  ('Rockwood Capital','tier1_prospect',ARRAY['office','retail'],NULL,NULL,NULL,NULL,NULL,NULL,'Gregg',NULL,NULL),
  ('North American Development','tier1_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,'Gregg',NULL,NULL),
  -- ── Tier 2 prospects ──
  ('Fortress','tier2_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,'John',NULL,'Reached out 2/6 to re-establish.'),
  ('Farallon','tier2_prospect',ARRAY['retail'],NULL,NULL,NULL,NULL,NULL,NULL,'John',NULL,'Likes small strips, grocery, smaller community centers; open to recaps.'),
  ('Spearstreet Capital','tier2_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,'John',NULL,NULL),
  ('Barings','tier2_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,'John',NULL,NULL),
  ('TIAA','tier2_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
  ('Prudential','tier2_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
  ('CBRE Global','tier2_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,'John',NULL,NULL),
  ('Principal','tier2_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,'Matt R.',NULL,NULL),
  ('Alliance Bernstein','tier2_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,'Gregg',NULL,NULL),
  ('New York Common Fund','tier2_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,'Tim',NULL,NULL),
  ('CIM','tier2_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,'Matt R.',NULL,NULL),
  ('Macquarie','tier2_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,'Matt R.',NULL,NULL),
  ('OhioSTRS','tier2_prospect','{}',NULL,NULL,NULL,NULL,NULL,NULL,'John',NULL,NULL);
