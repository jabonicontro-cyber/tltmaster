-- =============================================================================
-- Stops on an order (MK2 slice 1, owner 2026-11-05: freight loads with several pickups and deliveries).
--
-- An order may list its stops in order: each a pickup or a delivery, with the place (name and address), an
-- appointment date and window, a reference number (pickup number, PO, BOL) and notes for the driver. The first stop is
-- a pickup and the last a delivery. Optional and additive: aggregate orders without stops keep the order's pickup
-- (20261120006600) and job site exactly as before.
--
-- Stops are never deleted: a stop taken off the order gets removed_at, so the order's history keeps what was planned.
-- Writes only through save_order_stops (orders.edit; open orders only; audited). Reads: orders.view or dispatch.view,
-- and the assigned driver through driver_load_stops (their own loads, two days back to tomorrow).
-- Reversible: supabase/rollbacks/20261120007800_order_stops.down.sql
-- =============================================================================

create table public.order_stops (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id),
  order_id          uuid not null,
  seq               smallint not null check (seq between 1 and 25),
  kind              text not null check (kind in ('pickup', 'delivery')),
  name              text not null check (char_length(name) between 1 and 160),
  address_line1     text not null default '' check (char_length(address_line1) <= 200),
  city              text not null default '' check (char_length(city) <= 80),
  state             text not null default '' check (char_length(state) <= 40),
  postal_code       text not null default '' check (char_length(postal_code) <= 20),
  appointment_date  date check (appointment_date is null or appointment_date between date '2000-01-01' and date '2099-12-31'),
  window_start      time,
  window_end        time,
  reference         text not null default '' check (char_length(reference) <= 80),
  notes             text not null default '' check (char_length(notes) <= 500),
  removed_at        timestamptz,
  created_by        uuid default auth.uid() references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (company_id, order_id) references public.orders (company_id, id) on delete cascade,
  check ((window_start is null) = (window_end is null)),
  check (window_end is null or window_end > window_start),
  check (window_start is null or appointment_date is not null)
);
create index order_stops_order_idx on public.order_stops (order_id, seq) where removed_at is null;
create index order_stops_company_date_idx on public.order_stops (company_id, appointment_date) where removed_at is null;

create trigger a_company_guard before update of company_id on public.order_stops
  for each row execute function private.forbid_company_change();

alter table public.order_stops enable row level security;
create policy order_stops_read on public.order_stops for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('orders.view')) or (select private.has_permission('dispatch.view'))));
revoke all on public.order_stops from anon, authenticated;
grant select on public.order_stops to authenticated;
grant all on public.order_stops to service_role;

-- Replace an order's stops with the given list, in order. Each item: optional id (a current stop of this order, kept
-- and updated), kind, name, address_line1, city, state, postal_code, appointment_date, window_start, window_end,
-- reference, notes. Stops left out are marked removed. An empty list removes every stop. Returns the number of stops.
create or replace function public.save_order_stops(p_order uuid, p_stops jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_company();
  v_number   text;
  v_status   text;
  v_count    integer;
  v_item     jsonb;
  v_i        integer := 0;
  v_id       uuid;
  v_kept     uuid[] := '{}';
  v_kind     text;
  v_name     text;
  v_date     date;
  v_start    time;
  v_end      time;
  v_pickups  integer := 0;
  v_drops    integer := 0;
begin
  perform private.require_permission('orders.edit');
  select order_number, status::text into v_number, v_status
    from public.orders where id = p_order and company_id = v_company for update;
  if v_number is null then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if v_status in ('completed', 'canceled') then
    raise exception 'Stops can''t change on a completed or canceled order.' using errcode = 'P0001';
  end if;
  if p_stops is null or jsonb_typeof(p_stops) <> 'array' then
    raise exception 'Send the stops as a list.' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_stops);
  if v_count > 25 then
    raise exception 'An order can have at most 25 stops.' using errcode = '22023';
  end if;
  if v_count > 0 then
    if p_stops -> 0 ->> 'kind' is distinct from 'pickup' then
      raise exception 'The first stop must be a pickup.' using errcode = '22023';
    end if;
    if p_stops -> (v_count - 1) ->> 'kind' is distinct from 'delivery' then
      raise exception 'The last stop must be a delivery.' using errcode = '22023';
    end if;
  end if;

  for v_item in select value from jsonb_array_elements(p_stops) loop
    v_i := v_i + 1;
    v_kind := v_item ->> 'kind';
    if v_kind is null or v_kind not in ('pickup', 'delivery') then
      raise exception 'Stop %: choose pickup or delivery.', v_i using errcode = '22023';
    end if;
    v_name := btrim(coalesce(v_item ->> 'name', ''));
    if v_name = '' then
      raise exception 'Stop %: enter the place name.', v_i using errcode = '22023';
    end if;
    begin
      v_date  := nullif(v_item ->> 'appointment_date', '')::date;
      v_start := nullif(v_item ->> 'window_start', '')::time;
      v_end   := nullif(v_item ->> 'window_end', '')::time;
    exception when others then
      raise exception 'Stop %: check the appointment date and times.', v_i using errcode = '22023';
    end;
    if (v_start is null) <> (v_end is null) then
      raise exception 'Stop %: enter both window times or neither.', v_i using errcode = '22023';
    end if;
    if v_start is not null and v_end <= v_start then
      raise exception 'Stop %: the window must end after it starts.', v_i using errcode = '22023';
    end if;
    if v_start is not null and v_date is null then
      raise exception 'Stop %: a time window needs an appointment date.', v_i using errcode = '22023';
    end if;
    if v_kind = 'pickup' then v_pickups := v_pickups + 1; else v_drops := v_drops + 1; end if;

    v_id := null;
    if nullif(v_item ->> 'id', '') is not null then
      begin
        v_id := (v_item ->> 'id')::uuid;
      exception when others then
        v_id := null;
      end;
      if v_id is not null and v_id = any (v_kept) then
        raise exception 'Stop % appears twice.', v_i using errcode = '22023';
      end if;
      update public.order_stops set
        seq = v_i, kind = v_kind, name = left(v_name, 160),
        address_line1 = left(btrim(coalesce(v_item ->> 'address_line1', '')), 200),
        city = left(btrim(coalesce(v_item ->> 'city', '')), 80),
        state = left(btrim(coalesce(v_item ->> 'state', '')), 40),
        postal_code = left(btrim(coalesce(v_item ->> 'postal_code', '')), 20),
        appointment_date = v_date, window_start = v_start, window_end = v_end,
        reference = left(btrim(coalesce(v_item ->> 'reference', '')), 80),
        notes = left(btrim(coalesce(v_item ->> 'notes', '')), 500),
        updated_at = now()
      where id = v_id and order_id = p_order and company_id = v_company and removed_at is null
      returning id into v_id;
    end if;
    if v_id is null then
      insert into public.order_stops (company_id, order_id, seq, kind, name, address_line1, city, state, postal_code,
                                      appointment_date, window_start, window_end, reference, notes)
      values (v_company, p_order, v_i, v_kind, left(v_name, 160),
              left(btrim(coalesce(v_item ->> 'address_line1', '')), 200), left(btrim(coalesce(v_item ->> 'city', '')), 80),
              left(btrim(coalesce(v_item ->> 'state', '')), 40), left(btrim(coalesce(v_item ->> 'postal_code', '')), 20),
              v_date, v_start, v_end,
              left(btrim(coalesce(v_item ->> 'reference', '')), 80), left(btrim(coalesce(v_item ->> 'notes', '')), 500))
      returning id into v_id;
    end if;
    v_kept := v_kept || v_id;
  end loop;

  update public.order_stops set removed_at = now(), updated_at = now()
    where order_id = p_order and company_id = v_company and removed_at is null and not (id = any (v_kept));

  perform private.log_event('order.stops_saved', 'order', p_order,
    case when v_count = 0 then format('Stops cleared on %s', v_number)
         else format('Stops for %s: %s pickup%s, %s deliver%s', v_number,
                     v_pickups, case when v_pickups = 1 then '' else 's' end,
                     v_drops, case when v_drops = 1 then 'y' else 'ies' end) end,
    jsonb_build_object('stops', v_count));
  return v_count;
end;
$$;
revoke all on function public.save_order_stops(uuid, jsonb) from public, anon;
grant execute on function public.save_order_stops(uuid, jsonb) to authenticated;

-- The stops of the signed-in driver's own loads (two days back to tomorrow), keyed by load, in order. Nothing about
-- other drivers or other loads.
create or replace function public.driver_load_stops()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_d     public.drivers%rowtype := private.portal_driver();
  v_today date := private.business_today(v_d.company_id);
begin
  return coalesce((
    select jsonb_object_agg(x.load_id, x.stops)
    from (
      select l.id as load_id,
             jsonb_agg(jsonb_build_object(
               'seq', s.seq, 'kind', s.kind, 'name', s.name,
               'address', concat_ws(', ', nullif(s.address_line1, ''), nullif(s.city, ''),
                                    nullif(concat_ws(' ', nullif(s.state, ''), nullif(s.postal_code, '')), '')),
               'appointment_date', s.appointment_date, 'window_start', s.window_start, 'window_end', s.window_end,
               'reference', s.reference, 'notes', s.notes) order by s.seq) as stops
      from public.dispatch_assignments a
      join public.order_loads l on l.id = a.load_id and l.company_id = a.company_id
      join public.order_stops s on s.order_id = l.order_id and s.company_id = l.company_id and s.removed_at is null
      where a.company_id = v_d.company_id and a.driver_id = v_d.id and a.status = 'active'
        and l.load_date between v_today - 2 and v_today + 1
      group by l.id
    ) x), '{}'::jsonb);
end;
$$;
revoke all on function public.driver_load_stops() from public, anon;
grant execute on function public.driver_load_stops() to authenticated;
