-- 20240036_tenant_file_aliases.sql
-- Alternate file-system names per tenant (folder naming diverges from the MRI
-- trade name: renamed practices, concatenations, word-form variants). The
-- lease-abstract edge fn merges these into its document-matching needles.
alter table public.tenants add column if not exists file_aliases text[] not null default '{}';
comment on column public.tenants.file_aliases is 'Alternate names used in the document file system (folder/file naming) — consulted by the lease-abstract document matcher.';
