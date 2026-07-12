-- MJW-affiliation flag on syndication rosters: marks which Layer-2 entity
-- investors are MJW (firm entities + Wilkow family/trusts) vs outside
-- co-investors. Powers the dashboard Investor Returns widget's "MJW only"
-- slice (MJW share of each unit class scales that class's flows and
-- sold-today value).
alter table entity_investors add column if not exists is_mjw boolean not null default false;

comment on column entity_investors.is_mjw is
  'True when the investor is MJW-affiliated (M&J firm entities or Wilkow family/trusts), per user classification 2026-07-12. Class B promote units are 100% MJW by decree and are handled in code, not roster rows.';

-- Classification confirmed by user 2026-07-12: Wilkow family names/trusts
-- and M & J Equities are MJW; everyone else (Driehaus, Profimex, BDL Barry,
-- Rudis, Rodin, Yovovich, Miskella, JS/MS Holding, etc.) is outside money.
update entity_investors
set is_mjw = true
where name ~* 'wilkow' or name ~* 'm *& *j equities';
