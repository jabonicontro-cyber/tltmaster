-- Subscription notices (SUB1, owner 2026-11-06: "build the reminders"). What the pricing FAQ promises, per the owner's
-- policies in master plan §10, on the customer lifecycle (20261118000300):
--   * annual terms renew unless renewal is turned off; reminders 30, 7 and 1 day before the renewal date;
--   * going over the plan's truck or dispatch-base limit starts a 30-day grace period with a notice, another notice a
--     week before it ends, and, if still over, the lowest plan that fits is proposed to the platform team;
--   * a tier change takes effect only after a platform admin schedules it (effective date and agreed price, which this
--     code never computes) and the customer was notified; it is applied on that date. No plan change happens silently.
-- No payment code: amounts are records. Every event is recorded once (unique per company, kind and period) so a second
-- run in the same day adds nothing. Customer emails go out from the app (the cron route) through the email provider;
-- without a configured provider they are recorded as previews, never sent. Demo companies have no lifecycle.
-- Counting today: active company trucks that are not hired (hauler) trucks, and active dispatch bases. Excluding
-- pickups and maintenance vehicles needs a vehicle flag that does not exist yet (master plan §10 open item).
-- Downgrades (30 consecutive days under a lower limit) are not automated.
-- Reversible: supabase/rollbacks/20261120008800_subscription_notices.down.sql.

alter table private.company_lifecycle add column renewal_off boolean not null default false;

create table private.subscription_events (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  kind          text not null check (kind in ('renewal_reminder', 'over_limit', 'grace_ending', 'back_within_limits',
                                              'tier_change_due', 'tier_change_scheduled', 'tier_change_applied')),
  period_key    text not null check (length(period_key) between 1 and 80),
  detail        jsonb not null default '{}'::jsonb,
  -- Customer notice: pending until the app emails it; not_needed for platform-only events.
  notice_status text not null default 'pending' check (notice_status in ('pending', 'sent', 'previewed', 'failed', 'not_needed')),
  notice_note   text not null default '' check (length(notice_note) <= 300),
  created_at    timestamptz not null default now(),
  notified_at   timestamptz,
  unique (company_id, kind, period_key)
);
alter table private.subscription_events enable row level security;

create table private.subscription_grace (
  company_id   uuid primary key references public.companies (id) on delete cascade,
  started_on   date not null,
  ends_on      date not null,
  trucks       integer not null,
  bases        integer not null,
  limit_trucks integer,
  limit_bases  integer,
  -- Set when the company is back within the plan or a plan change applied; the row is reused for a later grace.
  resolved_on  date,
  updated_at   timestamptz not null default now()
);
alter table private.subscription_grace enable row level security;

create table private.tier_changes (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete cascade,
  from_plan_version_id uuid references private.platform_plan_versions (id),
  to_plan_version_id   uuid references private.platform_plan_versions (id),
  status               text not null default 'due' check (status in ('due', 'scheduled', 'applied', 'canceled')),
  reason               text not null default '' check (length(reason) <= 300),
  effective_on         date,
  agreed_monthly_cents integer check (agreed_monthly_cents >= 0),
  created_at           timestamptz not null default now(),
  decided_by           uuid references auth.users (id) on delete set null,
  decided_at           timestamptz,
  applied_at           timestamptz,
  cancel_reason        text not null default '' check (length(cancel_reason) <= 300),
  check (status <> 'scheduled' or (effective_on is not null and agreed_monthly_cents is not null and to_plan_version_id is not null))
);
create unique index tier_changes_one_open on private.tier_changes (company_id) where status in ('due', 'scheduled');
alter table private.tier_changes enable row level security;

-- Usage that counts against the plan (see the header for what is and is not counted yet).
create or replace function private.subscription_usage(p_company uuid)
returns table (trucks integer, bases integer)
language sql
stable
security definer
set search_path = ''
as $$
  select (select count(*)::integer from public.trucks t where t.company_id = p_company and t.active and t.hauler_id is null),
         (select count(*)::integer from public.dispatch_bases b where b.company_id = p_company and b.active);
$$;
revoke all on function private.subscription_usage(uuid) from public, anon, authenticated;

-- The lowest current plan that fits the usage (latest version of each standard plan in effect), or null.
create or replace function private.lowest_fitting_plan(p_trucks integer, p_bases integer, p_today date)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select v.id from private.platform_plan_versions v
  where v.plan_key <> 'custom' and v.effective_from <= p_today
    and v.version = (select max(v2.version) from private.platform_plan_versions v2 where v2.plan_key = v.plan_key and v2.effective_from <= p_today)
    and (v.trucks is null or v.trucks >= p_trucks) and (v.bases is null or v.bases >= p_bases)
  order by v.monthly_cents nulls last, v.trucks nulls last
  limit 1;
$$;
revoke all on function private.lowest_fitting_plan(integer, integer, date) from public, anon, authenticated;

-- The daily run: renewal reminders, grace periods, proposed and scheduled tier changes. Idempotent per day.
create or replace function private.subscription_run_core(p_today date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l record;
  u record;
  g private.subscription_grace%rowtype;
  tc private.tier_changes%rowtype;
  v_today date;
  v_renew date;
  v_days integer;
  v_offset integer;
  v_over boolean;
  v_fit uuid;
  v_events integer := 0;
  v_n integer;
begin
  for l in
    select cl.*, v.trucks as limit_trucks, v.bases as limit_bases, v.plan_key, v.name as plan_name
    from private.company_lifecycle cl
    join public.companies c on c.id = cl.company_id and not c.is_demo
    left join private.platform_plan_versions v on v.id = cl.plan_version_id
    where cl.stage = 'live'
  loop
    v_today := coalesce(p_today, private.company_today(l.company_id));

    -- Scheduled tier changes whose day has come take effect (the customer was notified when it was scheduled).
    for tc in select * from private.tier_changes where company_id = l.company_id and status = 'scheduled' and effective_on <= v_today loop
      update private.company_lifecycle set plan_version_id = tc.to_plan_version_id, agreed_monthly_cents = tc.agreed_monthly_cents, updated_at = now()
       where company_id = l.company_id;
      update private.tier_changes set status = 'applied', applied_at = now() where id = tc.id;
      update private.subscription_grace set resolved_on = v_today, updated_at = now() where company_id = l.company_id and resolved_on is null;
      insert into private.subscription_events (company_id, kind, period_key, detail)
      values (l.company_id, 'tier_change_applied', tc.id::text, jsonb_build_object('to_plan_version_id', tc.to_plan_version_id, 'effective_on', tc.effective_on, 'agreed_monthly_cents', tc.agreed_monthly_cents))
      on conflict do nothing;
      get diagnostics v_n = row_count; v_events := v_events + v_n;
    end loop;

    -- Renewal reminders: 30, 7 and 1 day before (the closest one due, so a missed day still sends the right one).
    if l.terms = 'annual' and not l.renewal_off and l.commitment_start is not null then
      v_renew := l.commitment_start;
      while v_renew <= v_today loop v_renew := (v_renew + interval '1 year')::date; end loop;
      v_days := v_renew - v_today;
      v_offset := case when v_days <= 1 then 1 when v_days <= 7 then 7 when v_days <= 30 then 30 end;
      if v_offset is not null then
        insert into private.subscription_events (company_id, kind, period_key, detail)
        values (l.company_id, 'renewal_reminder', v_renew::text || ':' || v_offset, jsonb_build_object('renews_on', v_renew, 'days_before', v_offset, 'plan', l.plan_name))
        on conflict do nothing;
        get diagnostics v_n = row_count; v_events := v_events + v_n;
      end if;
    end if;

    -- Limits (custom plans and companies without a plan have none).
    if l.plan_version_id is null or l.plan_key = 'custom' then continue; end if;
    select * into u from private.subscription_usage(l.company_id);
    v_over := (l.limit_trucks is not null and u.trucks > l.limit_trucks) or (l.limit_bases is not null and u.bases > l.limit_bases);
    select * into g from private.subscription_grace where company_id = l.company_id and resolved_on is null;

    if v_over and g.company_id is null then
      insert into private.subscription_grace (company_id, started_on, ends_on, trucks, bases, limit_trucks, limit_bases)
      values (l.company_id, v_today, v_today + 30, u.trucks, u.bases, l.limit_trucks, l.limit_bases)
      on conflict (company_id) do update set started_on = excluded.started_on, ends_on = excluded.ends_on, trucks = excluded.trucks,
        bases = excluded.bases, limit_trucks = excluded.limit_trucks, limit_bases = excluded.limit_bases, resolved_on = null, updated_at = now();
      insert into private.subscription_events (company_id, kind, period_key, detail)
      values (l.company_id, 'over_limit', v_today::text, jsonb_build_object('trucks', u.trucks, 'bases', u.bases, 'limit_trucks', l.limit_trucks, 'limit_bases', l.limit_bases, 'plan', l.plan_name, 'grace_ends_on', v_today + 30))
      on conflict do nothing;
      get diagnostics v_n = row_count; v_events := v_events + v_n;
    elsif v_over then
      update private.subscription_grace set trucks = u.trucks, bases = u.bases, updated_at = now() where company_id = l.company_id;
      if v_today >= g.ends_on - 7 and v_today < g.ends_on then
        insert into private.subscription_events (company_id, kind, period_key, detail)
        values (l.company_id, 'grace_ending', g.started_on::text, jsonb_build_object('trucks', u.trucks, 'bases', u.bases, 'limit_trucks', l.limit_trucks, 'limit_bases', l.limit_bases, 'grace_ends_on', g.ends_on))
        on conflict do nothing;
        get diagnostics v_n = row_count; v_events := v_events + v_n;
      elsif v_today >= g.ends_on and not exists (select 1 from private.tier_changes t where t.company_id = l.company_id and t.status in ('due', 'scheduled')) then
        v_fit := private.lowest_fitting_plan(u.trucks, u.bases, v_today);
        insert into private.tier_changes (company_id, from_plan_version_id, to_plan_version_id, reason)
        values (l.company_id, l.plan_version_id, v_fit,
                format('Over the plan for 30 days: trucks %s of %s, dispatch bases %s of %s.', u.trucks, coalesce(l.limit_trucks::text, 'no limit'), u.bases, coalesce(l.limit_bases::text, 'no limit')))
        returning * into tc;
        -- For the platform team only; the customer is notified when a person schedules the change.
        insert into private.subscription_events (company_id, kind, period_key, detail, notice_status)
        values (l.company_id, 'tier_change_due', g.started_on::text, jsonb_build_object('tier_change_id', tc.id, 'to_plan_version_id', v_fit, 'trucks', u.trucks, 'bases', u.bases), 'not_needed')
        on conflict do nothing;
        get diagnostics v_n = row_count; v_events := v_events + v_n;
      end if;
    elsif g.company_id is not null then
      update private.subscription_grace set resolved_on = v_today, updated_at = now() where company_id = l.company_id;
      update private.tier_changes set status = 'canceled', cancel_reason = 'Back within the plan''s limits.', decided_at = now()
       where company_id = l.company_id and status = 'due';
      insert into private.subscription_events (company_id, kind, period_key, detail)
      values (l.company_id, 'back_within_limits', g.started_on::text, jsonb_build_object('trucks', u.trucks, 'bases', u.bases, 'limit_trucks', l.limit_trucks, 'limit_bases', l.limit_bases))
      on conflict do nothing;
      get diagnostics v_n = row_count; v_events := v_events + v_n;
    end if;
  end loop;
  return jsonb_build_object('events', v_events);
end;
$$;
revoke all on function private.subscription_run_core(date) from public, anon, authenticated;

-- Callers: the daily cron (service role) and the platform console when it opens (platform admins).
create or replace function public.subscription_run_cron()
returns jsonb
language sql
security definer
set search_path = ''
as $$ select private.subscription_run_core(null); $$;
revoke all on function public.subscription_run_cron() from public, anon, authenticated;
grant execute on function public.subscription_run_cron() to service_role;

create or replace function public.platform_subscription_run()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return private.subscription_run_core(null);
end;
$$;
revoke all on function public.platform_subscription_run() from public, anon;
grant execute on function public.platform_subscription_run() to authenticated;

-- One company's subscription picture for the platform console.
create or replace function public.platform_subscription_state(p_company uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l record;
  u record;
  v_today date;
  v_renew date;
begin
  perform private.require_platform_admin();
  select cl.*, v.trucks as limit_trucks, v.bases as limit_bases, v.plan_key, v.name as plan_name
    into l
  from private.company_lifecycle cl left join private.platform_plan_versions v on v.id = cl.plan_version_id
  where cl.company_id = p_company;
  if not found then return null; end if;
  v_today := private.company_today(p_company);
  if l.terms = 'annual' and l.commitment_start is not null then
    v_renew := l.commitment_start;
    while v_renew <= v_today loop v_renew := (v_renew + interval '1 year')::date; end loop;
  end if;
  select * into u from private.subscription_usage(p_company);
  return jsonb_build_object(
    'trucks', u.trucks, 'bases', u.bases, 'limit_trucks', l.limit_trucks, 'limit_bases', l.limit_bases, 'plan', l.plan_name,
    'renewal_off', l.renewal_off, 'renews_on', v_renew,
    'grace', (select jsonb_build_object('started_on', g.started_on, 'ends_on', g.ends_on) from private.subscription_grace g where g.company_id = p_company and g.resolved_on is null),
    'tier_change', (select jsonb_build_object('id', t.id, 'status', t.status, 'reason', t.reason, 'effective_on', t.effective_on, 'agreed_monthly_cents', t.agreed_monthly_cents,
                                              'to_plan_version_id', t.to_plan_version_id,
                                              'to_plan', (select jsonb_build_object('name', v.name, 'version', v.version, 'monthly_cents', v.monthly_cents) from private.platform_plan_versions v where v.id = t.to_plan_version_id))
                    from private.tier_changes t where t.company_id = p_company and t.status in ('due', 'scheduled')),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'detail', e.detail, 'notice_status', e.notice_status, 'notice_note', e.notice_note, 'created_at', e.created_at)
                                         order by e.created_at desc), '[]'::jsonb)
               from (select * from private.subscription_events e where e.company_id = p_company order by e.created_at desc limit 20) e));
end;
$$;
revoke all on function public.platform_subscription_state(uuid) from public, anon;
grant execute on function public.platform_subscription_state(uuid) to authenticated;

create or replace function public.platform_set_renewal(p_company uuid, p_renew boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  update private.company_lifecycle set renewal_off = not p_renew, updated_by = auth.uid(), updated_at = now() where company_id = p_company;
  if not found then raise exception 'This company has no subscription yet.' using errcode = 'P0002'; end if;
  perform private.log_event('platform.renewal_set', 'company', p_company,
    case when p_renew then 'Annual renewal turned on' else 'Annual renewal turned off' end, jsonb_build_object('renew', p_renew));
end;
$$;
revoke all on function public.platform_set_renewal(uuid, boolean) from public, anon;
grant execute on function public.platform_set_renewal(uuid, boolean) to authenticated;

-- A person schedules a proposed tier change: the plan (the proposed one or another), the date it takes effect (after
-- today) and the agreed monthly price. The customer is notified now; the daily run applies it on that date.
create or replace function public.platform_tier_change_schedule(p_change uuid, p_plan_version uuid, p_effective date, p_agreed_monthly_cents integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  tc private.tier_changes%rowtype;
  v_plan private.platform_plan_versions%rowtype;
begin
  perform private.require_platform_admin();
  select * into tc from private.tier_changes where id = p_change for update;
  if not found or tc.status <> 'due' then raise exception 'This tier change is not waiting for a decision.' using errcode = 'P0002'; end if;
  select * into v_plan from private.platform_plan_versions where id = coalesce(p_plan_version, tc.to_plan_version_id);
  if not found then raise exception 'Choose the plan to move to.' using errcode = '22023'; end if;
  if p_effective is null or p_effective <= private.company_today(tc.company_id) then raise exception 'The change takes effect on a later date (the next billing date).' using errcode = '22023'; end if;
  if p_agreed_monthly_cents is null or p_agreed_monthly_cents < 0 then raise exception 'Enter the agreed monthly price.' using errcode = '22023'; end if;
  update private.tier_changes set status = 'scheduled', to_plan_version_id = v_plan.id, effective_on = p_effective,
         agreed_monthly_cents = p_agreed_monthly_cents, decided_by = auth.uid(), decided_at = now()
   where id = p_change;
  insert into private.subscription_events (company_id, kind, period_key, detail)
  values (tc.company_id, 'tier_change_scheduled', p_change::text,
          jsonb_build_object('plan', v_plan.name, 'effective_on', p_effective, 'agreed_monthly_cents', p_agreed_monthly_cents, 'reason', tc.reason))
  on conflict do nothing;
  perform private.log_event('platform.tier_change_scheduled', 'company', tc.company_id,
    format('Plan change to %s scheduled for %s at %s per month', v_plan.name, to_char(p_effective, 'Mon FMDD, YYYY'), to_char(p_agreed_monthly_cents / 100.0, 'FM999999990.00')),
    jsonb_build_object('tier_change_id', p_change));
end;
$$;
revoke all on function public.platform_tier_change_schedule(uuid, uuid, date, integer) from public, anon;
grant execute on function public.platform_tier_change_schedule(uuid, uuid, date, integer) to authenticated;

create or replace function public.platform_tier_change_cancel(p_change uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  tc private.tier_changes%rowtype;
begin
  perform private.require_platform_admin();
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'Say why the change is not made.' using errcode = '22023'; end if;
  select * into tc from private.tier_changes where id = p_change for update;
  if not found or tc.status not in ('due', 'scheduled') then raise exception 'This tier change is not open.' using errcode = 'P0002'; end if;
  update private.tier_changes set status = 'canceled', cancel_reason = left(btrim(p_reason), 300), decided_by = auth.uid(), decided_at = now() where id = p_change;
  perform private.log_event('platform.tier_change_canceled', 'company', tc.company_id, 'Plan change not made: ' || left(btrim(p_reason), 200), jsonb_build_object('tier_change_id', p_change));
end;
$$;
revoke all on function public.platform_tier_change_cancel(uuid, text) from public, anon;
grant execute on function public.platform_tier_change_cancel(uuid, text) to authenticated;

-- Notices for the app to email (service role only): pending customer notices with the company's owner addresses.
create or replace function public.subscription_pending_notices()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id, 'kind', e.kind, 'detail', e.detail, 'company', c.name,
    'to', (select coalesce(jsonb_agg(distinct u.email), '[]'::jsonb) from public.company_memberships m join auth.users u on u.id = m.user_id
           where m.company_id = e.company_id and m.active and m.role = 'owner' and u.email is not null)) order by e.created_at), '[]'::jsonb)
  from private.subscription_events e join public.companies c on c.id = e.company_id and not c.is_demo
  where e.notice_status = 'pending';
$$;
revoke all on function public.subscription_pending_notices() from public, anon, authenticated;
grant execute on function public.subscription_pending_notices() to service_role;

create or replace function public.subscription_notice_mark(p_event uuid, p_status text, p_note text)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.subscription_events
     set notice_status = p_status, notice_note = left(coalesce(p_note, ''), 300), notified_at = case when p_status = 'sent' then now() else notified_at end
   where id = p_event and notice_status = 'pending' and p_status in ('sent', 'previewed', 'failed');
$$;
revoke all on function public.subscription_notice_mark(uuid, text, text) from public, anon, authenticated;
grant execute on function public.subscription_notice_mark(uuid, text, text) to service_role;
