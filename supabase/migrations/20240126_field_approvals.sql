-- 20240126_field_approvals.sql
-- Phase 2: FIELD-LEVEL approval. A human can affirm one field's value without
-- locking the whole abstract (and one open question no longer holds the other
-- confirmed fields hostage). The authoritative record lives here as
--   { "<field.path>": { "by": <uuid>, "at": <iso>, "note": <text|null> } }
-- Writers also record a companion abstract_item_resolutions row keyed
-- 'field:<path>' so every existing settled-field consumer (ensemble sticky
-- decisions, worklists, red counts) honors the approval with no other changes.
alter table public.lease_abstracts
  add column if not exists field_approvals jsonb not null default '{}'::jsonb;

comment on column public.lease_abstracts.field_approvals is
  'Per-field human approvals: {"<field.path>": {by, at, note}}. Authoritative record of field-level sign-off (whole-abstract sign-off remains human_verified/locked); companion resolution rows propagate settlement to worklists and the ensemble.';
