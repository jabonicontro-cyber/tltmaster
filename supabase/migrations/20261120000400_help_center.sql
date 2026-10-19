-- =============================================================================
-- Help Center (2026-10-20, master plan B65): article feedback, search terms and support requests from Help.
-- Articles themselves live in the repository (reviewed like code). This stores only what people do with them:
-- 1. public.help_feedback: "Did this help?" per person and article (one answer each; can be changed), optional note.
-- 2. public.help_searches: what was searched and how many results came back (no other context), to find gaps.
-- 3. public.help_support_requests: a message to Taviron support written and reviewed by the person, with the page
--    they were on. Nothing is emailed from here (no provider configured); the platform team reads them in the console.
-- People insert their own rows for their own company; they read only their own support requests. The platform team
-- reads totals and requests through platform_help_overview() (platform admins only).
-- Rollback: supabase/rollbacks/20261120000400_help_center.down.sql
-- =============================================================================

create table public.help_feedback (
  company_id  uuid not null default private.current_company_id() references public.companies (id),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  article_id  text not null check (article_id ~ '^[a-z0-9-]{1,80}$'),
  helpful     boolean not null,
  note        text not null default '' check (length(note) <= 1000),
  created_at  timestamptz not null default now(),
  primary key (company_id, user_id, article_id)
);
alter table public.help_feedback enable row level security;
create policy help_feedback_own on public.help_feedback for all to authenticated
  using (company_id = (select private.current_company_id()) and user_id = (select auth.uid()))
  with check (company_id = (select private.current_company_id()) and user_id = (select auth.uid()));
revoke all on public.help_feedback from anon, authenticated;
grant select, insert, update on public.help_feedback to authenticated;

create table public.help_searches (
  id          bigint generated always as identity primary key,
  company_id  uuid not null default private.current_company_id() references public.companies (id),
  query       text not null check (length(query) between 1 and 120),
  results     integer not null check (results >= 0),
  created_at  timestamptz not null default now()
);
create index help_searches_recent on public.help_searches (created_at desc);
alter table public.help_searches enable row level security;
create policy help_searches_insert on public.help_searches for insert to authenticated
  with check (company_id = (select private.current_company_id()));
revoke all on public.help_searches from anon, authenticated;
grant insert on public.help_searches to authenticated;

create table public.help_support_requests (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default private.current_company_id() references public.companies (id),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  page        text not null default '' check (length(page) <= 200),
  article_id  text check (article_id is null or article_id ~ '^[a-z0-9-]{1,80}$'),
  message     text not null check (length(btrim(message)) between 10 and 4000),
  status      text not null default 'new' check (status in ('new', 'answered', 'closed')),
  created_at  timestamptz not null default now()
);
alter table public.help_support_requests enable row level security;
create policy help_support_own_read on public.help_support_requests for select to authenticated
  using (company_id = (select private.current_company_id()) and user_id = (select auth.uid()));
create policy help_support_insert on public.help_support_requests for insert to authenticated
  with check (company_id = (select private.current_company_id()) and user_id = (select auth.uid()) and status = 'new');
revoke all on public.help_support_requests from anon, authenticated;
grant select, insert on public.help_support_requests to authenticated;

-- Platform team: totals for the last 90 days and the latest support requests (with the company name and the page).
create or replace function public.platform_help_overview()
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select case when not private.is_platform_admin() then null else jsonb_build_object(
    'searches', (select count(*) from public.help_searches where created_at > now() - interval '90 days'),
    'no_results', (select coalesce(jsonb_agg(x), '[]') from (
        select lower(query) as query, count(*) as n from public.help_searches
        where results = 0 and created_at > now() - interval '90 days' group by lower(query) order by count(*) desc limit 20) x),
    'feedback', (select coalesce(jsonb_agg(x), '[]') from (
        select article_id, count(*) filter (where helpful) as helpful, count(*) filter (where not helpful) as not_helpful
        from public.help_feedback group by article_id order by count(*) filter (where not helpful) desc, article_id limit 50) x),
    'requests', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]') from (
        select r.id, c.name as company, c.is_demo, r.page, r.article_id, left(r.message, 600) as message, r.status, r.created_at
        from public.help_support_requests r join public.companies c on c.id = r.company_id
        order by r.created_at desc limit 50) x)
  ) end;
$$;
revoke all on function public.platform_help_overview() from public, anon;
grant execute on function public.platform_help_overview() to authenticated;
