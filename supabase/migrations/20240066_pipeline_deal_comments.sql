-- 20240066_pipeline_deal_comments.sql
-- Team discussion thread on acquisition deals + the capital raise. Each comment
-- is author-attributed and timestamped; an optional lp_id ties a comment to a
-- specific partner in the deal's LP funnel (capital-raise chatter).
--
-- Author NAMES are resolved client-side via the assignable_users() RPC (the
-- users table's RLS hides other users' rows), the same pattern the tasks feature
-- uses — never embed the author user row in the comment query.

create table if not exists public.pipeline_deal_comments (
  id uuid primary key default uuid_generate_v4(),
  deal_id uuid not null references public.pipeline_deals(id) on delete cascade,
  lp_id uuid references public.pipeline_deal_lps(id) on delete set null,  -- optional: a capital-raise comment about one LP
  author_id uuid references public.users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index if not exists pipeline_deal_comments_deal on public.pipeline_deal_comments(deal_id, created_at);

alter table public.pipeline_deal_comments enable row level security;

-- Any manager can read the thread.
create policy "pipeline_deal_comments_select" on public.pipeline_deal_comments
  for select using (public.is_admin_or_am());
-- A manager can post, but only AS themselves.
create policy "pipeline_deal_comments_insert" on public.pipeline_deal_comments
  for insert with check (public.is_admin_or_am() and author_id = auth.uid());
-- Edit only your own comment.
create policy "pipeline_deal_comments_update" on public.pipeline_deal_comments
  for update using (author_id = auth.uid()) with check (author_id = auth.uid());
-- Delete your own; admins can moderate.
create policy "pipeline_deal_comments_delete" on public.pipeline_deal_comments
  for delete using (author_id = auth.uid() or public.is_admin());

grant select, insert, update, delete on public.pipeline_deal_comments to authenticated;

notify pgrst, 'reload schema';
