-- =============================================================================
-- Shift offers (B102, owner decision 2026-10-28).
--
-- A planner (schedules.manage) offers an extra shift on a date. The company chooses in Settings how it is filled:
--   request       (a) qualified people ask for it; a planner approves one of them;
--   first_accept  (b) the first qualified person to accept gets it; planners are notified;
--   offer         (c) the planner offers it to chosen people; the first to accept holds it; a planner confirms.
-- The mode is copied onto each offer when it is made, so changing the setting never changes offers already out.
--
-- "Qualified": an active person in the offer's group (drivers: people with a driver record; shop: the shop
-- department; everyone), not already working that day (or still on the day before's overnight shift at its start),
-- not on approved time off that day, and for mode (c) one of the people it was offered to. The check runs when a
-- person asks or accepts and again when a planner approves or confirms, right before the shift is written.
--
-- Filling an offer writes an ordinary one-day shift (public.shift_changes) with the reason "Shift offer", logged in
-- schedule_events like any schedule change, so the Schedule, My Day and the dispatch shift check see it at once.
-- Notifications are in-app only (category 'schedule'); nothing is emailed or texted.
--
-- Reversible: supabase/rollbacks/20261120004700_shift_offers.down.sql
-- =============================================================================

create table public.shift_offer_settings (
  company_id  uuid primary key default private.current_company_id() references public.companies (id),
  mode        text not null default 'request' check (mode in ('request', 'first_accept', 'offer')),
  updated_by  uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now()
);

create table public.shift_offers (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company_id() references public.companies (id),
  work_date        date not null,
  start_time       time not null,
  end_time         time not null,
  break_minutes    integer not null default 0 check (break_minutes between 0 and 240),
  audience         text not null check (audience in ('drivers', 'shop', 'everyone')),
  mode             text not null check (mode in ('request', 'first_accept', 'offer')),
  note             text not null default '' check (length(note) <= 300),
  status           text not null default 'open' check (status in ('open', 'pending', 'filled', 'canceled')),
  filled_employee  uuid,
  cancel_reason    text not null default '',
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  decided_by       uuid references auth.users (id) on delete set null,
  decided_at       timestamptz,
  unique (company_id, id),
  foreign key (company_id, filled_employee) references public.employees (company_id, id),
  check (start_time <> end_time),
  check ((status = 'filled') = (filled_employee is not null))
);
create index shift_offers_company_idx on public.shift_offers (company_id, work_date);

create table public.shift_offer_targets (
  offer_id     uuid not null,
  company_id   uuid not null,
  employee_id  uuid not null,
  primary key (offer_id, employee_id),
  foreign key (company_id, offer_id) references public.shift_offers (company_id, id) on delete cascade,
  foreign key (company_id, employee_id) references public.employees (company_id, id) on delete cascade
);

create table public.shift_offer_responses (
  id           uuid primary key default gen_random_uuid(),
  offer_id     uuid not null,
  company_id   uuid not null,
  employee_id  uuid not null,
  status       text not null check (status in ('requested', 'accepted', 'approved', 'declined', 'withdrawn', 'not_chosen')),
  note         text not null default '',
  created_at   timestamptz not null default now(),
  decided_by   uuid references auth.users (id) on delete set null,
  decided_at   timestamptz,
  unique (offer_id, employee_id),
  foreign key (company_id, offer_id) references public.shift_offers (company_id, id) on delete cascade,
  foreign key (company_id, employee_id) references public.employees (company_id, id) on delete cascade
);
create index shift_offer_responses_company_idx on public.shift_offer_responses (company_id, offer_id);

alter table public.shift_offer_settings enable row level security;
alter table public.shift_offers enable row level security;
alter table public.shift_offer_targets enable row level security;
alter table public.shift_offer_responses enable row level security;
revoke all on public.shift_offer_settings, public.shift_offers, public.shift_offer_targets, public.shift_offer_responses from anon, authenticated;
grant select on public.shift_offer_settings, public.shift_offers, public.shift_offer_targets, public.shift_offer_responses to authenticated;

-- Everyone in the company may read the mode; planners and dispatch read offers and answers. People see the offers open
-- to them through public.my_shift_offers().
create policy shift_offer_settings_read on public.shift_offer_settings for select to authenticated
  using (company_id = (select private.current_company_id()));
create policy shift_offers_read on public.shift_offers for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('schedules.manage')) or (select private.has_permission('dispatch.view'))));
create policy shift_offer_targets_read on public.shift_offer_targets for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('schedules.manage')) or (select private.has_permission('dispatch.view'))));
create policy shift_offer_responses_read on public.shift_offer_responses for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('schedules.manage')) or (select private.has_permission('dispatch.view'))));

-- In-app notifications get a 'schedule' category (shift offers; few and addressed to a person).
alter table public.comm_notifications drop constraint comm_notifications_category_check;
alter table public.comm_notifications add constraint comm_notifications_category_check
  check (category in ('direct', 'group', 'channel', 'announcement', 'alert', 'catch_up', 'membership', 'onboarding', 'schedule'));

-- -----------------------------------------------------------------------------
-- Helpers (internal)
-- -----------------------------------------------------------------------------

-- "Tue Nov 3, 6:00 AM–2:30 PM".
create or replace function private.shift_offer_label(o public.shift_offers)
returns text
language sql
stable
set search_path = ''
as $$
  select to_char(o.work_date, 'Dy Mon FMDD') || ', ' || private.clock_text(o.start_time) || '–' || private.clock_text(o.end_time);
$$;
revoke all on function private.shift_offer_label(public.shift_offers) from public, anon, authenticated;

-- Why a person cannot take an offered shift, or null when they can.
create or replace function private.shift_offer_problem(o public.shift_offers, p_employee uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  e public.employees%rowtype;
  s record;
  v_start timestamptz := (o.work_date + o.start_time) at time zone private.business_timezone(o.company_id);
begin
  select * into e from public.employees where id = p_employee and company_id = o.company_id;
  if not found or e.status <> 'active' then
    return 'Only active people can take a shift.';
  end if;
  if o.audience = 'drivers' and e.driver_id is null then
    return 'This shift is for drivers.';
  end if;
  if o.audience = 'shop' and e.department <> 'shop' then
    return 'This shift is for the shop.';
  end if;
  if o.mode = 'offer' and not exists (select 1 from public.shift_offer_targets t where t.offer_id = o.id and t.employee_id = p_employee) then
    return 'This shift was offered to other people.';
  end if;
  select * into s from private.shift_on(o.company_id, p_employee, o.work_date);
  if s.status = 'shift' then
    return format('Already works that day (%s–%s).', private.clock_text(s.start_time), private.clock_text(s.end_time));
  end if;
  select * into s from private.shift_on(o.company_id, p_employee, o.work_date - 1);
  if s.status = 'shift' and s.end_at > v_start then
    return 'Still on the overnight shift from the day before.';
  end if;
  if exists (select 1 from public.time_off_requests r
              where r.company_id = o.company_id and r.employee_id = p_employee and r.status = 'approved'
                and o.work_date between r.start_date and r.end_date) then
    return 'On approved time off that day.';
  end if;
  return null;
end;
$$;
revoke all on function private.shift_offer_problem(public.shift_offers, uuid) from public, anon, authenticated;

-- The caller's own person record in their company, or an error.
create or replace function private.my_employee()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v uuid;
begin
  select e.id into v from public.employees e where e.company_id = private.require_company() and e.user_id = auth.uid();
  if v is null then
    raise exception 'Your sign-in is not linked to a person in this company.' using errcode = '42501';
  end if;
  return v;
end;
$$;
revoke all on function private.my_employee() from public, anon, authenticated;

-- In-app notice to everyone in the company who plans schedules.
create or replace function private.shift_offer_notify_planners(p_company uuid, p_title text, p_offer uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in select distinct m.user_id from public.company_memberships m
             join public.role_permissions rp on rp.company_id = m.company_id and rp.role = m.role
            where m.company_id = p_company and m.active and rp.permission = 'schedules.manage' and m.user_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000')
  loop
    perform private.comm_notify(p_company, r.user_id, 'schedule', p_title, '/schedule#offer-' || p_offer, null, p_offer, false);
  end loop;
end;
$$;
revoke all on function private.shift_offer_notify_planners(uuid, text, uuid) from public, anon, authenticated;

-- In-app notice to one person (when their sign-in exists).
create or replace function private.shift_offer_notify_person(p_company uuid, p_employee uuid, p_title text, p_offer uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  select user_id into v_user from public.employees where id = p_employee and company_id = p_company;
  if v_user is not null then
    perform private.comm_notify(p_company, v_user, 'schedule', p_title, '/driver', null, p_offer, false);
  end if;
end;
$$;
revoke all on function private.shift_offer_notify_person(uuid, uuid, text, uuid) from public, anon, authenticated;

-- Give the shift to one person: re-check, write the one-day shift, close the offer and the other answers.
create or replace function private.shift_offer_fill(p_offer uuid, p_employee uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.shift_offers%rowtype;
  v_problem text;
begin
  select * into o from public.shift_offers where id = p_offer for update;
  v_problem := private.shift_offer_problem(o, p_employee);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023';
  end if;
  insert into public.shift_changes (company_id, employee_id, work_date, kind, start_time, end_time, break_minutes, reason)
  values (o.company_id, p_employee, o.work_date, 'shift', o.start_time, o.end_time, o.break_minutes, 'Shift offer')
  on conflict (employee_id, work_date) do update  -- replaces a one-day "off" change: taking the shift is working that day
    set kind = 'shift', start_time = excluded.start_time, end_time = excluded.end_time, break_minutes = excluded.break_minutes,
        reason = excluded.reason, created_by = auth.uid(), created_at = now();
  insert into public.schedule_events (company_id, employee_id, kind, summary)
  values (o.company_id, p_employee, 'day_set', format('%s (shift offer)', private.shift_offer_label(o)));
  update public.shift_offers set status = 'filled', filled_employee = p_employee, decided_by = auth.uid(), decided_at = now() where id = o.id;
  insert into public.shift_offer_responses (offer_id, company_id, employee_id, status, decided_by, decided_at)
  values (o.id, o.company_id, p_employee, 'approved', auth.uid(), now())
  on conflict (offer_id, employee_id) do update set status = 'approved', decided_by = auth.uid(), decided_at = now();
  update public.shift_offer_responses set status = 'not_chosen', decided_by = auth.uid(), decided_at = now()
   where offer_id = o.id and employee_id <> p_employee and status in ('requested', 'accepted');
end;
$$;
revoke all on function private.shift_offer_fill(uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Company setting
-- -----------------------------------------------------------------------------

create or replace function public.shift_offer_set_mode(p_mode text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('settings.manage');
  if p_mode not in ('request', 'first_accept', 'offer') then
    raise exception 'Choose how shift offers are filled.' using errcode = '22023';
  end if;
  insert into public.shift_offer_settings (company_id, mode) values (v_company, p_mode)
  on conflict (company_id) do update set mode = excluded.mode, updated_by = auth.uid(), updated_at = now();
  perform private.log_event('shift_offers.mode', 'company', v_company, format('Shift offers: %s',
    case p_mode when 'request' then 'people ask, a planner approves' when 'first_accept' then 'first to accept gets it'
                else 'offered to chosen people, a planner confirms' end), jsonb_build_object('mode', p_mode));
end;
$$;

-- -----------------------------------------------------------------------------
-- Planners
-- -----------------------------------------------------------------------------

create or replace function public.shift_offer_create(p_date date, p_start time, p_end time, p_break integer, p_audience text,
                                                     p_note text, p_targets uuid[] default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_mode text;
  v_note text := private.clean_text(p_note, 300, 'Note');
  o public.shift_offers%rowtype;
  v_problem text;
  r record;
  n integer := 0;
begin
  perform private.require_permission('schedules.manage');
  if p_date is null or p_date < private.company_today(v_company) or p_date > private.company_today(v_company) + 90 then
    raise exception 'Choose a date from today up to 90 days ahead.' using errcode = '22023';
  end if;
  if p_start is null or p_end is null or p_start = p_end then
    raise exception 'A shift needs a start and an end time.' using errcode = '22023';
  end if;
  if coalesce(p_break, 0) not between 0 and 240 then
    raise exception 'The break is 0 to 240 minutes.' using errcode = '22023';
  end if;
  if p_audience not in ('drivers', 'shop', 'everyone') then
    raise exception 'Choose who the shift is for.' using errcode = '22023';
  end if;
  select s.mode into v_mode from public.shift_offer_settings s where s.company_id = v_company;
  v_mode := coalesce(v_mode, 'request');
  if v_mode = 'offer' and coalesce(cardinality(p_targets), 0) = 0 then
    raise exception 'Choose the people to offer the shift to.' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_targets), 0) > 50 then
    raise exception 'Offer a shift to at most 50 people.' using errcode = '22023';
  end if;
  insert into public.shift_offers (company_id, work_date, start_time, end_time, break_minutes, audience, mode, note)
  values (v_company, p_date, p_start, p_end, coalesce(p_break, 0), p_audience, v_mode, v_note)
  returning * into o;
  if v_mode = 'offer' then
    insert into public.shift_offer_targets (offer_id, company_id, employee_id)
    select o.id, v_company, e.id from public.employees e where e.company_id = v_company and e.id = any (p_targets)
    on conflict do nothing;
    for r in select t.employee_id, e.full_name from public.shift_offer_targets t join public.employees e on e.id = t.employee_id where t.offer_id = o.id loop
      v_problem := private.shift_offer_problem(o, r.employee_id);
      if v_problem is not null then
        raise exception '%: %', r.full_name, v_problem using errcode = '22023';
      end if;
    end loop;
    if not found then
      raise exception 'Choose the people to offer the shift to.' using errcode = '22023';
    end if;
  end if;
  -- Tell everyone who can take it.
  for r in select e.id from public.employees e where e.company_id = v_company and e.status = 'active' and e.user_id is not null loop
    if private.shift_offer_problem(o, r.id) is null then
      perform private.shift_offer_notify_person(v_company, r.id, 'Shift offered: ' || private.shift_offer_label(o), o.id);
      n := n + 1;
    end if;
  end loop;
  perform private.log_event('shift_offers.created', 'shift_offer', o.id, 'Shift offered: ' || private.shift_offer_label(o),
    jsonb_build_object('mode', v_mode, 'audience', p_audience, 'notified', n));
  return o.id;
end;
$$;

-- Approve a request (mode a) or confirm an acceptance (mode c); or decline it.
create or replace function public.shift_offer_decide(p_response uuid, p_approve boolean, p_note text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_note text := private.clean_text(p_note, 300, 'Note');
  r public.shift_offer_responses%rowtype;
  o public.shift_offers%rowtype;
begin
  perform private.require_permission('schedules.manage');
  select * into r from public.shift_offer_responses where id = p_response and company_id = v_company for update;
  if not found then
    raise exception 'Answer not found.' using errcode = 'P0002';
  end if;
  select * into o from public.shift_offers where id = r.offer_id for update;
  if o.status not in ('open', 'pending') or r.status not in ('requested', 'accepted') then
    raise exception 'This shift offer has already been decided.' using errcode = '22023';
  end if;
  if p_approve then
    perform private.shift_offer_fill(o.id, r.employee_id);
    perform private.shift_offer_notify_person(v_company, r.employee_id, 'Shift is yours: ' || private.shift_offer_label(o), o.id);
    perform private.log_event('shift_offers.filled', 'shift_offer', o.id,
      format('Shift %s given to %s', private.shift_offer_label(o), (select full_name from public.employees where id = r.employee_id)), '{}'::jsonb);
  else
    update public.shift_offer_responses set status = 'declined', note = v_note, decided_by = auth.uid(), decided_at = now() where id = r.id;
    if o.status = 'pending' then
      update public.shift_offers set status = 'open' where id = o.id;
    end if;
    perform private.shift_offer_notify_person(v_company, r.employee_id, 'Shift went to someone else: ' || private.shift_offer_label(o), o.id);
  end if;
end;
$$;

create or replace function public.shift_offer_cancel(p_offer uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_reason text := private.clean_text(p_reason, 300, 'Reason');
  o public.shift_offers%rowtype;
  r record;
begin
  perform private.require_permission('schedules.manage');
  select * into o from public.shift_offers where id = p_offer and company_id = v_company for update;
  if not found then
    raise exception 'Shift offer not found.' using errcode = 'P0002';
  end if;
  if o.status not in ('open', 'pending') then
    raise exception 'Only an open shift offer can be withdrawn. A filled shift is changed on the Schedule.' using errcode = '22023';
  end if;
  if v_reason = '' then
    raise exception 'Give a reason.' using errcode = '22023';
  end if;
  update public.shift_offers set status = 'canceled', cancel_reason = v_reason, decided_by = auth.uid(), decided_at = now() where id = o.id;
  for r in select employee_id from public.shift_offer_responses where offer_id = o.id and status in ('requested', 'accepted') loop
    perform private.shift_offer_notify_person(v_company, r.employee_id, 'Shift no longer needed: ' || private.shift_offer_label(o), o.id);
  end loop;
  update public.shift_offer_responses set status = 'not_chosen', decided_by = auth.uid(), decided_at = now()
   where offer_id = o.id and status in ('requested', 'accepted');
  perform private.log_event('shift_offers.canceled', 'shift_offer', o.id, 'Shift offer withdrawn: ' || private.shift_offer_label(o),
    jsonb_build_object('reason', v_reason));
end;
$$;

-- -----------------------------------------------------------------------------
-- People
-- -----------------------------------------------------------------------------

-- Open offers the caller can take (or has answered), with what they can do.
create or replace function public.my_shift_offers()
returns table (id uuid, work_date date, start_time time, end_time time, break_minutes integer, mode text, note text,
               offer_status text, my_status text, problem text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_me uuid;
begin
  select e.id into v_me from public.employees e where e.company_id = v_company and e.user_id = auth.uid();
  if v_me is null then
    return;
  end if;
  return query
    select o.id, o.work_date, o.start_time, o.end_time, o.break_minutes, o.mode, o.note, o.status, r.status,
           private.shift_offer_problem(o, v_me)
      from public.shift_offers o
      left join public.shift_offer_responses r on r.offer_id = o.id and r.employee_id = v_me
     where o.company_id = v_company
       and o.work_date >= private.company_today(v_company)
       and (r.id is not null or (o.status = 'open' and private.shift_offer_problem(o, v_me) is null))
     order by o.work_date, o.start_time;
end;
$$;

-- Ask for (a) or accept (b, c) an offered shift.
create or replace function public.shift_offer_respond(p_offer uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_me uuid := private.my_employee();
  v_name text;
  o public.shift_offers%rowtype;
  v_problem text;
begin
  select * into o from public.shift_offers where id = p_offer and company_id = v_company for update;
  if not found then
    raise exception 'Shift offer not found.' using errcode = 'P0002';
  end if;
  if o.status <> 'open' then
    raise exception '%', case when o.status = 'pending' then 'Someone else accepted this shift first.' else 'This shift is no longer available.' end
      using errcode = '22023';
  end if;
  if o.work_date < private.company_today(v_company) then
    raise exception 'This shift is in the past.' using errcode = '22023';
  end if;
  v_problem := private.shift_offer_problem(o, v_me);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023';
  end if;
  select full_name into v_name from public.employees where id = v_me;
  if o.mode = 'request' then
    insert into public.shift_offer_responses (offer_id, company_id, employee_id, status)
    values (o.id, v_company, v_me, 'requested')
    on conflict (offer_id, employee_id) do update set status = 'requested', created_at = now(), decided_by = null, decided_at = null
      where public.shift_offer_responses.status = 'withdrawn';
    if not found then
      raise exception 'You already answered this shift.' using errcode = '22023';
    end if;
    perform private.shift_offer_notify_planners(v_company, v_name || ' asks for the shift ' || private.shift_offer_label(o), o.id);
    return 'requested';
  elsif o.mode = 'first_accept' then
    perform private.shift_offer_fill(o.id, v_me);
    perform private.shift_offer_notify_planners(v_company, v_name || ' took the shift ' || private.shift_offer_label(o), o.id);
    perform private.log_event('shift_offers.filled', 'shift_offer', o.id, format('Shift %s taken by %s', private.shift_offer_label(o), v_name), '{}'::jsonb);
    return 'approved';
  else
    insert into public.shift_offer_responses (offer_id, company_id, employee_id, status)
    values (o.id, v_company, v_me, 'accepted')
    on conflict (offer_id, employee_id) do update set status = 'accepted', created_at = now(), decided_by = null, decided_at = null
      where public.shift_offer_responses.status = 'withdrawn';
    if not found then
      raise exception 'You already answered this shift.' using errcode = '22023';
    end if;
    update public.shift_offers set status = 'pending' where id = o.id;
    perform private.shift_offer_notify_planners(v_company, v_name || ' accepted the shift ' || private.shift_offer_label(o) || ': confirm it', o.id);
    return 'accepted';
  end if;
end;
$$;

-- Take back a request or an acceptance not yet decided.
create or replace function public.shift_offer_withdraw(p_offer uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_me uuid := private.my_employee();
  r public.shift_offer_responses%rowtype;
begin
  select * into r from public.shift_offer_responses where offer_id = p_offer and employee_id = v_me and company_id = v_company for update;
  if not found or r.status not in ('requested', 'accepted') then
    raise exception 'There is nothing to withdraw.' using errcode = '22023';
  end if;
  update public.shift_offer_responses set status = 'withdrawn', decided_at = now() where id = r.id;
  if r.status = 'accepted' then
    update public.shift_offers set status = 'open' where id = p_offer and status = 'pending';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Demo sample: an open driver shift two days out with one request (mode a), so the Schedule and My Day show offers.
-- -----------------------------------------------------------------------------
create or replace function public.demo_shift_offer_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  o public.shift_offers%rowtype;
  v_emp uuid;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.shift_offers where company_id = v_demo) then
    return 0;
  end if;
  insert into public.shift_offers (company_id, work_date, start_time, end_time, break_minutes, audience, mode, note)
  values (v_demo, private.company_today(v_demo) + 2, time '06:00', time '14:30', 30, 'drivers', 'request',
          'Extra hauls for a large pour (demo). Nothing is sent outside Taviron.')
  returning * into o;
  select e.id into v_emp from public.employees e
   where e.company_id = v_demo and e.status = 'active' and e.driver_id is not null and private.shift_offer_problem(o, e.id) is null
   order by e.full_name limit 1;
  if v_emp is not null then
    insert into public.shift_offer_responses (offer_id, company_id, employee_id, status) values (o.id, v_demo, v_emp, 'requested');
  end if;
  return 1;
end;
$$;

revoke all on function public.shift_offer_set_mode(text), public.shift_offer_create(date, time, time, integer, text, text, uuid[]),
  public.shift_offer_decide(uuid, boolean, text), public.shift_offer_cancel(uuid, text), public.my_shift_offers(),
  public.shift_offer_respond(uuid), public.shift_offer_withdraw(uuid), public.demo_shift_offer_samples() from public, anon;
grant execute on function public.shift_offer_set_mode(text), public.shift_offer_create(date, time, time, integer, text, text, uuid[]),
  public.shift_offer_decide(uuid, boolean, text), public.shift_offer_cancel(uuid, text), public.my_shift_offers(),
  public.shift_offer_respond(uuid), public.shift_offer_withdraw(uuid), public.demo_shift_offer_samples() to authenticated;
