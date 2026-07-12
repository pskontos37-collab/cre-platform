-- 20240055_abstract_human_review.sql
-- Human-in-the-loop layer over AI lease abstracts. QA flags problems; this lets a
-- reviewer CORRECT specific fields, record a note, and LOCK the abstract as
-- human-verified — the step that makes the output authoritative (and what the
-- commercial abstractors sell). Corrections are stored as a dotted-path override
-- map applied over the AI JSON at display/export time; the AI `abstract` is never
-- mutated, so a regenerate can be diffed against the human's values.

alter table public.lease_abstracts add column if not exists overrides jsonb;                 -- { "term.expiration": "2028-12-31", "square_footage": 6240, ... }
alter table public.lease_abstracts add column if not exists human_verified boolean not null default false;
alter table public.lease_abstracts add column if not exists locked boolean not null default false;  -- blocks regenerate from clobbering human work
alter table public.lease_abstracts add column if not exists reviewed_by uuid references public.users(id);
alter table public.lease_abstracts add column if not exists reviewed_at timestamptz;
alter table public.lease_abstracts add column if not exists review_note text;

comment on column public.lease_abstracts.overrides is
  'Reviewer field corrections as a dotted-path→value map, layered over the AI abstract at render/export time. AI abstract JSON is left intact for diffing.';
comment on column public.lease_abstracts.locked is
  'When true the abstract is human-authoritative; the UI blocks regenerate so an AI re-run cannot overwrite corrected/verified content without an explicit unlock.';
