-- End-of-day owner summary (master plan B97, owner 2026-10-27: email now, text once Twilio keys exist; demos never
-- send). A short, measured summary of the day: loads delivered and still open, tickets missing or waiting for review,
-- trucks down, open driver reports and tomorrow's loads without a truck.
--
--   * company_settings.daily_summary_enabled / daily_summary_hour: off until the company switches it on (settings.manage);
--     the hour (company time zone, default 18) is the earliest it goes out.
--   * public.my_daily_summary(day): the same figures in the app (preview in Settings, and demos), for dispatch or
--     settings access.
--   * public.daily_summary_due() / public.daily_summary_record(...): service role only, for the scheduled job, which
--     sends one summary per company per day (public.daily_summary_log keeps the outcome; never twice).
-- Owners receive it (active owner memberships). Demo companies are never returned by daily_summary_due.
--
-- Reversible: supabase/rollbacks/20261120004200_daily_summary.down.sql

alter table public.company_settings
  add column daily_summary_enabled boolean not null default false,
  add column daily_summary_hour smallint not null default 18 check (daily_summary_hour between 0 and 23);
grant update (daily_summary_enabled, daily_summary_hour) on public.company_settings to authenticated;

create table public.daily_summary_log (
  company_id  uuid not null references public.companies (id),
  day         date not null,
  status      text not null check (status in ('sent', 'test', 'preview', 'failed', 'no_recipients')),
  recipients  integer not null default 0,
  detail      text not null default '' check (length(detail) <= 500),
  created_at  timestamptz not null default now(),
  primary key (company_id, day)
);
alter table public.daily_summary_log enable row level security;
create policy daily_summary_log_read on public.daily_summary_log for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('settings.manage')));
revoke all on public.daily_summary_log from anon;
grant select on public.daily_summary_log to authenticated;

-- The figures for one company and day (no names: counts only).
create or replace function private.daily_summary(p_company uuid, p_day date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with today_loads as (
    select l.id, l.end_time from public.order_loads l where l.company_id = p_company and l.load_date = p_day and l.status <> 'canceled'
  ), tomorrow_loads as (
    select l.id from public.order_loads l where l.company_id = p_company and l.load_date = p_day + 1 and l.status <> 'canceled'
  ), ticketed as (
    select distinct t.load_id from public.delivery_tickets t
     where t.company_id = p_company and t.status in ('submitted', 'needs_review', 'accepted') and t.load_id in (select id from today_loads)
  ), assigned as (
    select distinct a.load_id from public.dispatch_assignments a where a.company_id = p_company and a.status = 'active'
  )
  select jsonb_build_object(
    'day', p_day,
    'loads', (select count(*) from today_loads),
    'delivered', (select count(*) from ticketed),
    'without_truck', (select count(*) from today_loads tl where tl.id not in (select load_id from assigned)),
    'missing_tickets', (select count(*) from today_loads tl where tl.id in (select load_id from assigned) and tl.id not in (select load_id from ticketed)),
    'to_review', (select count(*) from public.delivery_tickets t where t.company_id = p_company and t.status in ('submitted', 'needs_review')),
    'trucks_down', (select count(*) from public.trucks tr where tr.company_id = p_company and tr.active and tr.service_status = 'out_of_service'),
    'open_reports', (select count(*) from public.field_reports fr where fr.company_id = p_company and fr.status = 'open'),
    'tomorrow_loads', (select count(*) from tomorrow_loads),
    'tomorrow_without_truck', (select count(*) from tomorrow_loads tl where tl.id not in (select load_id from assigned))
  );
$$;
revoke all on function private.daily_summary(uuid, date) from public, anon, authenticated;

create or replace function public.my_daily_summary(p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
begin
  if v_company is null or not (private.has_permission('dispatch.view') or private.has_permission('settings.manage')) then
    raise exception 'Not available.' using errcode = '42501';
  end if;
  return private.daily_summary(v_company, p_day);
end;
$$;
revoke all on function public.my_daily_summary(date) from public, anon;
grant execute on function public.my_daily_summary(date) to authenticated;

-- Companies whose summary is due now (enabled, local hour reached, not yet logged today, never a demo), with the
-- owners' addresses and the figures. Service role only.
create or replace function public.daily_summary_due()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'company_id', c.id, 'company', c.name, 'day', x.day,
           'recipients', (select coalesce(jsonb_agg(distinct u.email), '[]'::jsonb)
                            from public.company_memberships m join auth.users u on u.id = m.user_id
                           where m.company_id = c.id and m.active and m.role = 'owner' and u.email is not null and u.email not like '%.invalid'),
           'summary', private.daily_summary(c.id, x.day))), '[]'::jsonb)
    from public.companies c
    join public.company_settings s on s.company_id = c.id
    cross join lateral (select (now() at time zone coalesce(s.timezone, 'America/Chicago'))::date as day,
                               extract(hour from now() at time zone coalesce(s.timezone, 'America/Chicago'))::int as hour) x
   where c.active and not c.is_demo and s.daily_summary_enabled and x.hour >= s.daily_summary_hour
     and not exists (select 1 from public.daily_summary_log l where l.company_id = c.id and l.day = x.day);
$$;
revoke all on function public.daily_summary_due() from public, anon, authenticated;
grant execute on function public.daily_summary_due() to service_role;

create or replace function public.daily_summary_record(p_company uuid, p_day date, p_status text, p_recipients integer, p_detail text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  insert into public.daily_summary_log (company_id, day, status, recipients, detail)
  values (p_company, p_day, p_status, coalesce(p_recipients, 0), left(coalesce(p_detail, ''), 500))
  on conflict (company_id, day) do nothing
  returning true;
$$;
revoke all on function public.daily_summary_record(uuid, date, text, integer, text) from public, anon, authenticated;
grant execute on function public.daily_summary_record(uuid, date, text, integer, text) to service_role;
