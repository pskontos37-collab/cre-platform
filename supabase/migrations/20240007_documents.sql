-- ============================================================
-- GROUP E: Documents & Inspections
-- Expand the documents stub created in 20240004
-- ============================================================

alter table documents
  add column property_id     uuid references properties(id) on delete restrict,
  add column tenant_id       uuid references tenants(id) on delete set null,
  add column loan_id         uuid references loans(id) on delete set null,
  add column doc_type        doc_type not null default 'other',
  add column title           text not null default '',
  add column file_path       text,
  add column file_name       text,
  add column mime_type       text,
  add column file_size_bytes integer,
  add column version         integer not null default 1,
  add column superseded_by   uuid references documents(id) on delete set null,
  add column upload_date     date,
  add column uploaded_by     uuid,
  add column is_indexed      boolean not null default false,
  add column notes           text,
  add column created_at      timestamptz not null default now();

create table document_chunks (
  id          uuid primary key default uuid_generate_v4(),
  document_id uuid not null references documents(id) on delete cascade,
  chunk_index integer not null,
  content     text not null,
  embedding   vector(1536),
  page_number integer,
  created_at  timestamptz not null default now()
);

-- inspections.uploaded_by FK added after users table in 20240008
create table inspections (
  id               uuid primary key default uuid_generate_v4(),
  property_id      uuid not null references properties(id) on delete cascade,
  document_id      uuid references documents(id) on delete set null,
  inspected_by     text,
  inspection_date  date not null,
  inspection_type  inspection_type not null default 'routine',
  summary          text,
  condition_rating condition_rating,
  uploaded_by      uuid,
  created_at       timestamptz not null default now()
);
