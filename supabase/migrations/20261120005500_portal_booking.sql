-- B115: customer self-booking in the portal (owner 2026-11-01: a company setting, off by default; owner 2026-11-02:
-- capacity is a number of loads the company opens per day). Customers request loads on open days; nothing is scheduled
-- until dispatch approves, and the order is created as usual and linked to the request. Customers see each day only as
-- open or full, never fleet details. Non-destructive: new tables and functions only.

create table public.booking_settings (
  company_id      uuid primary key references public.companies (id) on delete cascade,
  enabled         boolean not null default false,
  min_days_ahead  integer not null default 1 check (min_days_ahead between 0 and 30),
  horizon_days    integer not null default 14 check (horizon_days between 1 and 60),
  updated_by      uuid references auth.users (id) on delete set null,
  updated_at      timestamptz not null default now()
);
alter table public.booking_settings enable row level security;
create policy booking_settings_read on public.booking_settings for select to authenticated
  using (company_id = (select private.current_company_id()));
revoke all on public.booking_settings from anon;
grant select on public.booking_settings to authenticated;

create table public.booking_capacity (
  company_id  uuid not null references public.companies (id) on delete cascade,
  day         date not null,
  loads       integer not null check (loads between 0 and 500),
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (company_id, day)
);
alter table public.booking_capacity enable row level security;
create policy booking_capacity_read on public.booking_capacity for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('dispatch.view')));
revoke all on public.booking_capacity from anon;
grant select on public.booking_capacity to authenticated;

create table public.booking_requests (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  customer_id    uuid not null references public.customers (id),
  -- The portal account that asked; null for a demo sample.
  account_id     uuid references public.portal_accounts (id) on delete set null,
  day            date not null,
  loads          integer not null check (loads between 1 and 100),
  material       text not null default '' check (length(material) <= 200),
  site_id        uuid references public.customer_sites (id) on delete set null,
  time_window    text not null default 'any' check (time_window in ('any', 'morning', 'afternoon')),
  notes          text not null default '' check (length(notes) <= 2000),
  status         text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'canceled')),
  decision_note  text not null default '' check (length(decision_note) <= 1000),
  decided_by     uuid references auth.users (id) on delete set null,
  decided_at     timestamptz,
  order_id       uuid references public.orders (id) on delete set null,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now()
);
create index booking_requests_company_day on public.booking_requests (company_id, day);
create index booking_requests_customer on public.booking_requests (company_id, customer_id, created_at desc);
alter table public.booking_requests enable row level security;
create policy booking_requests_read on public.booking_requests for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('dispatch.view')));
revoke all on public.booking_requests from anon;
grant select on public.booking_requests to authenticated;

-- Loads already taken on a day: pending and approved requests.
create or replace function private.booking_used(p_company uuid, p_day date)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(loads), 0)::integer from public.booking_requests
  where company_id = p_company and day = p_day and status in ('pending', 'approved');
$$;
revoke all on function private.booking_used(uuid, date) from public, anon, authenticated;

-- Staff: turn booking on or off and set how far ahead customers may book (company settings permission).
create or replace function public.booking_save_settings(p_enabled boolean, p_min_days_ahead integer, p_horizon_days integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('settings.manage');
  if p_min_days_ahead is null or p_min_days_ahead not between 0 and 30 then
    raise exception 'Choose between 0 and 30 days ahead.' using errcode = '22023';
  end if;
  if p_horizon_days is null or p_horizon_days not between 1 and 60 or p_horizon_days <= p_min_days_ahead then
    raise exception 'Customers must be able to book at least one day (up to 60 days ahead).' using errcode = '22023';
  end if;
  insert into public.booking_settings (company_id, enabled, min_days_ahead, horizon_days, updated_by, updated_at)
  values (v_company, coalesce(p_enabled, false), p_min_days_ahead, p_horizon_days, auth.uid(), now())
  on conflict (company_id) do update set enabled = excluded.enabled, min_days_ahead = excluded.min_days_ahead,
    horizon_days = excluded.horizon_days, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform private.log_event('booking.settings_saved', 'booking_settings', v_company,
    format('Customer booking turned %s', case when coalesce(p_enabled, false) then 'on' else 'off' end),
    jsonb_build_object('enabled', coalesce(p_enabled, false), 'min_days_ahead', p_min_days_ahead, 'horizon_days', p_horizon_days));
end;
$$;

-- Staff (dispatch): how many loads customers may request on a day. 0 closes the day; existing requests stay.
create or replace function public.booking_set_capacity(p_day date, p_loads integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('dispatch.edit');
  if p_day is null or p_day < private.company_today(v_company) or p_day > private.company_today(v_company) + 90 then
    raise exception 'Choose a day from today up to 90 days ahead.' using errcode = '22023';
  end if;
  if p_loads is null or p_loads not between 0 and 500 then
    raise exception 'Enter between 0 and 500 loads.' using errcode = '22023';
  end if;
  insert into public.booking_capacity (company_id, day, loads, updated_by, updated_at)
  values (v_company, p_day, p_loads, auth.uid(), now())
  on conflict (company_id, day) do update set loads = excluded.loads, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform private.log_event('booking.capacity_set', 'booking_capacity', null,
    format('Customer booking capacity for %s set to %s loads', p_day, p_loads), jsonb_build_object('day', p_day, 'loads', p_loads));
end;
$$;

-- Staff (dispatch): approve or decline a pending request, or link the order created for an approved one. A decline
-- needs a reason the customer sees; the linked order must be the same customer's.
create or replace function public.booking_decide(p_request uuid, p_status text, p_note text, p_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  r public.booking_requests%rowtype;
  v_note text := private.clean_text(p_note, 1000, 'Note');
begin
  perform private.require_permission('dispatch.edit');
  select * into r from public.booking_requests where id = p_request and company_id = v_company for update;
  if not found then
    raise exception 'Request not found.' using errcode = 'P0002';
  end if;
  if p_status not in ('approved', 'declined') then
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  if r.status not in ('pending', 'approved') or (r.status = 'approved' and p_status <> 'approved') then
    raise exception 'This request was already %.', r.status using errcode = '22023';
  end if;
  if p_status = 'declined' and length(v_note) = 0 then
    raise exception 'Tell the customer why (they see this note).' using errcode = '22023';
  end if;
  if p_order is not null and not exists (select 1 from public.orders where id = p_order and company_id = v_company and customer_id = r.customer_id) then
    raise exception 'That order belongs to a different customer.' using errcode = '22023';
  end if;
  update public.booking_requests set status = p_status,
    decision_note = case when length(v_note) > 0 then v_note else decision_note end,
    order_id = coalesce(p_order, order_id),
    decided_by = case when r.status = 'pending' then auth.uid() else decided_by end,
    decided_at = case when r.status = 'pending' then now() else decided_at end
  where id = p_request;
  perform private.log_event('booking.request_' || p_status, 'booking_request', p_request,
    format('Booking request for %s (%s loads) %s', r.day, r.loads, p_status), jsonb_build_object('order_id', p_order));
end;
$$;

-- Portal: the days a customer may book (open or full only, never counts) and their own requests.
create or replace function public.portal_booking_state(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  s public.booking_settings%rowtype;
  v_today date;
begin
  select * into s from public.booking_settings where company_id = v.company_id;
  if not found or not s.enabled then
    return jsonb_build_object('enabled', false);
  end if;
  v_today := private.company_today(v.company_id);
  return jsonb_build_object(
    'enabled', true,
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', d::date,
               'open', coalesce(c.loads, 0) > private.booking_used(v.company_id, d::date)) order by d)
      from generate_series(v_today + s.min_days_ahead, v_today + s.horizon_days, interval '1 day') d
      left join public.booking_capacity c on c.company_id = v.company_id and c.day = d::date), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'day', r.day, 'loads', r.loads, 'material', r.material,
               'time_window', r.time_window, 'notes', r.notes, 'status', r.status, 'decision_note', r.decision_note,
               'site', cs.label, 'order_id', r.order_id, 'order_number', o.order_number, 'created_at', r.created_at)
             order by r.day desc, r.created_at desc)
      from public.booking_requests r
      left join public.customer_sites cs on cs.id = r.site_id
      left join public.orders o on o.id = r.order_id
      where r.company_id = v.company_id and r.customer_id = v.customer_id and r.created_at > now() - interval '120 days'), '[]'::jsonb));
end;
$$;

-- Portal: request loads on an open day. The day's capacity row is locked so two customers cannot both take the last
-- loads; a request larger than what is left is refused without saying how much is left.
create or replace function public.portal_booking_request(p_slug text, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
  s public.booking_settings%rowtype;
  v_day date := nullif(p ->> 'day', '')::date;
  v_loads integer := nullif(p ->> 'loads', '')::integer;
  v_site uuid := nullif(p ->> 'site_id', '')::uuid;
  v_window text := coalesce(nullif(p ->> 'time_window', ''), 'any');
  v_material text := private.clean_text(p ->> 'material', 200, 'Material');
  v_capacity integer;
  v_today date;
  v_id uuid;
begin
  select * into s from public.booking_settings where company_id = v.company_id;
  if not found or not s.enabled then
    raise exception 'This is not available in the portal.' using errcode = '42501';
  end if;
  v_today := private.company_today(v.company_id);
  if v_day is null or v_day < v_today + s.min_days_ahead or v_day > v_today + s.horizon_days then
    raise exception 'Choose one of the open days.' using errcode = '22023';
  end if;
  if v_loads is null or v_loads not between 1 and 100 then
    raise exception 'Enter between 1 and 100 loads.' using errcode = '22023';
  end if;
  if v_window not in ('any', 'morning', 'afternoon') then
    raise exception 'Choose a time of day.' using errcode = '22023';
  end if;
  if length(v_material) = 0 then
    raise exception 'Tell us what you need hauled.' using errcode = '22023';
  end if;
  if v_site is not null and not exists (select 1 from public.customer_sites where company_id = v.company_id and id = v_site and customer_id = v.customer_id) then
    raise exception 'Site not found.' using errcode = 'P0002';
  end if;
  select loads into v_capacity from public.booking_capacity where company_id = v.company_id and day = v_day for update;
  if coalesce(v_capacity, 0) < private.booking_used(v.company_id, v_day) + v_loads then
    raise exception 'That day does not have room for that many loads. Choose fewer loads or another open day.' using errcode = '22023';
  end if;
  perform private.portal_rate(v.id, 'booking_request', 20);
  insert into public.booking_requests (company_id, customer_id, account_id, day, loads, material, site_id, time_window, notes, created_by)
  values (v.company_id, v.customer_id, v.id, v_day, v_loads, v_material, v_site, v_window, private.clean_text(p ->> 'notes', 2000, 'Notes'), auth.uid())
  returning id into v_id;
  perform private.portal_log(v.company_id, 'portal.booking_requested', 'booking_request', v_id,
    format('%s requested %s loads for %s', v.email, v_loads, v_day));
  return jsonb_build_object('id', v_id);
end;
$$;

-- Portal: a customer withdraws their own pending request (frees the day's capacity).
create or replace function public.portal_booking_cancel(p_slug text, p_request uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  update public.booking_requests set status = 'canceled'
  where id = p_request and company_id = v.company_id and customer_id = v.customer_id and status = 'pending';
  if not found then
    raise exception 'Request not found or already answered.' using errcode = 'P0002';
  end if;
  perform private.portal_log(v.company_id, 'portal.booking_canceled', 'booking_request', p_request, format('%s withdrew a booking request', v.email));
end;
$$;

-- Demo sample: booking switched on, capacity on the next weekdays (one already full), one pending and one approved
-- request from the demo's customers. Fictional; added once.
create or replace function public.demo_booking_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_today date;
  v_day date;
  v_days date[] := '{}';
  v_customers uuid[];
  v_site uuid;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.booking_requests where company_id = v_demo) then
    return 0;
  end if;
  v_today := private.company_today(v_demo);
  insert into public.booking_settings (company_id, enabled, min_days_ahead, horizon_days, updated_by)
  values (v_demo, true, 1, 14, auth.uid()) on conflict (company_id) do nothing;
  v_day := v_today + 1;
  while array_length(v_days, 1) is null or array_length(v_days, 1) < 8 loop
    if extract(isodow from v_day) < 6 then
      v_days := v_days || v_day;
    end if;
    v_day := v_day + 1;
  end loop;
  insert into public.booking_capacity (company_id, day, loads, updated_by)
  select v_demo, d, case when i = 2 then 3 else 8 end, auth.uid() from unnest(v_days) with ordinality as t(d, i)
  on conflict (company_id, day) do nothing;
  select array_agg(id order by name) into v_customers from (select id, name from public.customers where company_id = v_demo and active order by name limit 2) c;
  if v_customers is null then
    return 1;
  end if;
  select id into v_site from public.customer_sites where company_id = v_demo and customer_id = v_customers[1] limit 1;
  insert into public.booking_requests (company_id, customer_id, day, loads, material, site_id, time_window, notes, created_by)
  values (v_demo, v_customers[1], v_days[1], 4, 'Base rock for a driveway pour (demo)', v_site, 'morning', 'Gate code at the trailer (fictional).', auth.uid());
  -- The full day: an approved request takes all of its loads.
  insert into public.booking_requests (company_id, customer_id, day, loads, material, time_window, status, decision_note, decided_by, decided_at, created_by)
  values (v_demo, coalesce(v_customers[2], v_customers[1]), v_days[2], 3, 'Fill dirt (demo)', 'any', 'approved', 'See you then (demo).', auth.uid(), now(), auth.uid());
  return 3;
end;
$$;

revoke all on function public.booking_save_settings(boolean, integer, integer) from public, anon;
revoke all on function public.booking_set_capacity(date, integer) from public, anon;
revoke all on function public.booking_decide(uuid, text, text, uuid) from public, anon;
revoke all on function public.portal_booking_state(text) from public, anon;
revoke all on function public.portal_booking_request(text, jsonb) from public, anon;
revoke all on function public.portal_booking_cancel(text, uuid) from public, anon;
revoke all on function public.demo_booking_samples() from public, anon;
grant execute on function public.booking_save_settings(boolean, integer, integer) to authenticated;
grant execute on function public.booking_set_capacity(date, integer) to authenticated;
grant execute on function public.booking_decide(uuid, text, text, uuid) to authenticated;
grant execute on function public.portal_booking_state(text) to authenticated;
grant execute on function public.portal_booking_request(text, jsonb) to authenticated;
grant execute on function public.portal_booking_cancel(text, uuid) to authenticated;
grant execute on function public.demo_booking_samples() to authenticated;
