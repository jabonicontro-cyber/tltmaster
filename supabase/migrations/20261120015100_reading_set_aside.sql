-- =============================================================================
-- A wrong odometer or engine-hour reading can be set aside (owner decision 2026-11-09, master plan MD1).
--
-- Since 20261120012200 readings come from inspections, trip sheets, fuel entries and work orders, and a reading lower
-- than the truck's current one is not used (audit 'truck.reading_ignored'). One typo too high (101,500 for 100,150)
-- therefore made every correct reading after it "lower" and ignored, with no way out.
--
-- Now, on the truck's page, a person with maintenance.manage or fleet.edit marks a reading as wrong:
--   public.truck_reading_set_aside(reading, reason)
--     The reading is kept (never removed) with set_aside_at / set_aside_by / set_aside_reason, and the audit log
--     records 'truck.reading_set_aside' on the truck (the value, where it came from, the reason, the current reading
--     after it). Returns the truck's current reading after it. The caller's company only; the dispatch-base guard on
--     truck_readings applies (a base-limited person cannot change another base's truck).
-- Every place that works out the current reading uses only readings not set aside, so the last good reading counts
-- again and later correct readings are used:
--   private.feed_truck_reading (the feed's "lower than the current reading" and 2,000 mi / 24 h per day checks),
--   private.pm_due (preventive due by miles or hours, through maintenance_pm_status),
--   private.wo_complete_schedule (the reading stored when a preventive job is completed),
--   public.record_truck_reading (the Preventive page's "cannot go down" check).
-- Bodies otherwise identical to 20261120012200 / 20261101000100. Readings ignored earlier are not replayed: they stay
-- listed on the truck's page with the reason they were not used.
-- Additive; works with the code before and after it.
-- Reversible: supabase/rollbacks/20261120015100_reading_set_aside.down.sql
-- =============================================================================

alter table public.truck_readings add column if not exists set_aside_at timestamptz;
alter table public.truck_readings add column if not exists set_aside_by uuid references auth.users (id) on delete set null;
alter table public.truck_readings add column if not exists set_aside_reason text not null default ''
  check (length(set_aside_reason) <= 300);
alter table public.truck_readings add constraint truck_readings_set_aside_reason
  check (set_aside_at is not null or set_aside_reason = '');
comment on column public.truck_readings.set_aside_at is
  'When a person marked this reading as wrong (truck_reading_set_aside). Kept for history; never used as the current reading.';
create index if not exists truck_readings_good_idx on public.truck_readings (company_id, truck_id, read_at desc)
  where set_aside_at is null;

create or replace function public.truck_reading_set_aside(p_reading uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_reason  text := left(trim(coalesce(p_reason, '')), 300);
  v_row     public.truck_readings%rowtype;
  v_unit    text;
  v_miles   numeric;
  v_hours   numeric;
  v_what    text;
begin
  if not (private.has_permission('maintenance.manage') or private.has_permission('fleet.edit')) then
    raise exception 'You do not have permission to perform this action (maintenance.manage or fleet.edit).' using errcode = '42501';
  end if;
  select * into v_row from public.truck_readings where id = p_reading and company_id = v_company for update;
  if not found then
    raise exception 'Reading not found.' using errcode = 'P0002';
  end if;
  if v_row.set_aside_at is not null then
    raise exception 'This reading was already marked wrong.' using errcode = 'P0001';
  end if;
  if length(v_reason) < 3 then
    raise exception 'Say why the reading is wrong (for example, a typo on the fuel slip).' using errcode = '22023';
  end if;
  select unit_number into v_unit from public.trucks where id = v_row.truck_id and company_id = v_company for update;

  update public.truck_readings set set_aside_at = now(), set_aside_by = auth.uid(), set_aside_reason = v_reason
  where id = v_row.id;

  select max(r.odometer_miles), max(r.engine_hours) into v_miles, v_hours
  from public.truck_readings r where r.company_id = v_company and r.truck_id = v_row.truck_id and r.set_aside_at is null;
  v_what := concat_ws(' and ',
    case when v_row.odometer_miles is not null then format('odometer %s mi', v_row.odometer_miles) end,
    case when v_row.engine_hours is not null then format('engine hours %s', v_row.engine_hours) end);
  perform private.log_event('truck.reading_set_aside', 'truck', v_row.truck_id,
    left(format('Reading marked wrong on truck %s: %s (%s). %s', v_unit, v_what, v_reason,
      case when v_miles is null and v_hours is null then 'No good reading is left.'
           else 'Current reading now ' || concat_ws(', ', case when v_miles is not null then v_miles || ' mi' end,
                                                         case when v_hours is not null then v_hours || ' h' end) || '.' end), 500),
    jsonb_build_object('reading_id', v_row.id, 'odometer_miles', v_row.odometer_miles, 'engine_hours', v_row.engine_hours,
      'read_at', v_row.read_at, 'source', v_row.source, 'source_id', v_row.source_id, 'reason', v_reason,
      'current_miles', v_miles, 'current_hours', v_hours));
  return jsonb_build_object('current_miles', v_miles, 'current_hours', v_hours);
end;
$$;
revoke all on function public.truck_reading_set_aside(uuid, text) from public, anon;
grant execute on function public.truck_reading_set_aside(uuid, text) to authenticated;

create or replace function private.feed_truck_reading(
  p_company uuid, p_truck uuid, p_miles numeric, p_hours numeric, p_source text, p_source_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unit   text;
  v_miles  numeric;  v_miles_at timestamptz;
  v_hours  numeric;  v_hours_at timestamptz;
  v_days   numeric;
  v_use_m  numeric;
  v_use_h  numeric;
  v_m      text := 'none';
  v_h      text := 'none';
  v_from   text := case p_source when 'inspection' then 'an inspection' when 'trip_sheet' then 'a trip sheet'
                                 when 'fuel' then 'a fuel entry' when 'work_order' then 'a work order' else 'an entry' end;
begin
  if p_truck is null or (p_miles is null and p_hours is null) then
    return jsonb_build_object('miles', v_m, 'hours', v_h);
  end if;
  select unit_number into v_unit from public.trucks where id = p_truck and company_id = p_company for update;
  if not found then
    return jsonb_build_object('miles', v_m, 'hours', v_h);
  end if;
  select max(r.odometer_miles), max(r.read_at) filter (where r.odometer_miles is not null),
         max(r.engine_hours), max(r.read_at) filter (where r.engine_hours is not null)
    into v_miles, v_miles_at, v_hours, v_hours_at
  from public.truck_readings r where r.company_id = p_company and r.truck_id = p_truck and r.set_aside_at is null;

  if p_miles is not null and p_miles >= 0 and p_miles <= 9999999 then
    v_days := greatest(1, ceil(extract(epoch from (clock_timestamp() - coalesce(v_miles_at, clock_timestamp()))) / 86400));
    if v_miles is null or (p_miles > v_miles and p_miles - v_miles <= 2000 * v_days) then
      v_use_m := p_miles; v_m := 'recorded';
    elsif p_miles = v_miles then v_m := 'same';
    elsif p_miles < v_miles then v_m := 'lower';
    else v_m := 'implausible';
    end if;
  end if;
  if p_hours is not null and p_hours >= 0 and p_hours <= 999999 then
    v_days := greatest(1, ceil(extract(epoch from (clock_timestamp() - coalesce(v_hours_at, clock_timestamp()))) / 86400));
    if v_hours is null or (p_hours > v_hours and p_hours - v_hours <= 24 * v_days) then
      v_use_h := p_hours; v_h := 'recorded';
    elsif p_hours = v_hours then v_h := 'same';
    elsif p_hours < v_hours then v_h := 'lower';
    else v_h := 'implausible';
    end if;
  end if;

  if v_use_m is not null or v_use_h is not null then
    begin
      insert into public.truck_readings (company_id, truck_id, odometer_miles, engine_hours, note, recorded_by, source, source_id)
      values (p_company, p_truck, v_use_m, v_use_h, left('From ' || v_from, 300), auth.uid(), p_source, p_source_id);
    exception when insufficient_privilege then
      -- A person limited to other dispatch bases: the source record is kept; the reading is left for the shop.
      v_m := case when v_m = 'recorded' then 'none' else v_m end;
      v_h := case when v_h = 'recorded' then 'none' else v_h end;
    end;
  end if;
  if v_m in ('lower', 'implausible') then
    insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
    values (p_company, auth.uid(), 'truck.reading_ignored', 'truck', p_truck,
      left(format('Odometer %s mi from %s on truck %s was not used: %s the current %s mi.', p_miles, v_from, v_unit,
        case v_m when 'lower' then 'lower than' else 'too far above' end, v_miles), 500),
      jsonb_build_object('value', p_miles, 'current', v_miles, 'kind', 'odometer', 'why', v_m, 'source', p_source, 'source_id', p_source_id));
  end if;
  if v_h in ('lower', 'implausible') then
    insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
    values (p_company, auth.uid(), 'truck.reading_ignored', 'truck', p_truck,
      left(format('Engine hours %s from %s on truck %s were not used: %s the current %s h.', p_hours, v_from, v_unit,
        case v_h when 'lower' then 'lower than' else 'too far above' end, v_hours), 500),
      jsonb_build_object('value', p_hours, 'current', v_hours, 'kind', 'engine_hours', 'why', v_h, 'source', p_source, 'source_id', p_source_id));
  end if;
  return jsonb_build_object('miles', v_m, 'hours', v_h);
end;
$$;

CREATE OR REPLACE FUNCTION private.pm_due(p_company uuid)
 RETURNS TABLE(schedule_id uuid, truck_id uuid, unit_number text, name text, interval_days integer, interval_miles numeric, interval_hours numeric, last_done_on date, last_done_miles numeric, last_done_hours numeric, next_due_on date, next_due_miles numeric, next_due_hours numeric, current_miles numeric, miles_read_at timestamp with time zone, current_hours numeric, hours_read_at timestamp with time zone, days_state text, miles_state text, hours_state text, state text, readings_stale boolean, open_work_order_id uuid, open_work_order_number text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with base as (
    select s.*, t.unit_number, private.business_today(s.company_id) as today,
      m.odometer_miles as cur_miles, m.read_at as cur_miles_at,
      h.engine_hours as cur_hours, h.read_at as cur_hours_at
    from public.maintenance_schedules s
    join public.trucks t on t.company_id = s.company_id and t.id = s.truck_id and t.active
    left join lateral (select r.odometer_miles, r.read_at from public.truck_readings r
      where r.company_id = s.company_id and r.truck_id = s.truck_id and r.odometer_miles is not null and r.set_aside_at is null
      order by r.read_at desc, r.odometer_miles desc limit 1) m on true
    left join lateral (select r.engine_hours, r.read_at from public.truck_readings r
      where r.company_id = s.company_id and r.truck_id = s.truck_id and r.engine_hours is not null and r.set_aside_at is null
      order by r.read_at desc, r.engine_hours desc limit 1) h on true
    where s.company_id = p_company and s.active
  ), nxt as (
    select b.*,
      case when b.interval_days is not null and b.last_done_on is not null then b.last_done_on + b.interval_days end as n_on,
      case when b.interval_miles is not null and b.last_done_miles is not null then b.last_done_miles + b.interval_miles end as n_miles,
      case when b.interval_hours is not null and b.last_done_hours is not null then b.last_done_hours + b.interval_hours end as n_hours
    from base b
  ), st as (
    select n.*,
      case when n.interval_days is null then null
           when n.n_on is null then 'unknown'
           when n.today >= n.n_on then 'overdue'
           when n.today >= n.n_on - n.warn_days then 'due_soon'
           else 'ok' end as d_state,
      case when n.interval_miles is null then null
           when n.n_miles is null or n.cur_miles is null then 'unknown'
           when n.cur_miles >= n.n_miles then 'overdue'
           when n.cur_miles >= n.n_miles - n.warn_miles then 'due_soon'
           else 'ok' end as m_state,
      case when n.interval_hours is null then null
           when n.n_hours is null or n.cur_hours is null then 'unknown'
           when n.cur_hours >= n.n_hours then 'overdue'
           when n.cur_hours >= n.n_hours - n.warn_hours then 'due_soon'
           else 'ok' end as h_state
    from nxt n
  )
  select st.id, st.truck_id, st.unit_number, st.name,
    st.interval_days, st.interval_miles, st.interval_hours,
    st.last_done_on, st.last_done_miles, st.last_done_hours,
    st.n_on, st.n_miles, st.n_hours,
    st.cur_miles, st.cur_miles_at, st.cur_hours, st.cur_hours_at,
    st.d_state, st.m_state, st.h_state,
    case when 'overdue' in (st.d_state, st.m_state, st.h_state) then 'overdue'
         when 'due_soon' in (st.d_state, st.m_state, st.h_state) then 'due_soon'
         when 'ok' in (st.d_state, st.m_state, st.h_state) then 'ok'
         else 'unknown' end,
    coalesce(st.interval_miles is not null and st.cur_miles_at < now() - interval '30 days', false)
      or coalesce(st.interval_hours is not null and st.cur_hours_at < now() - interval '30 days', false),
    w.id, w.number
  from st
  left join public.work_orders w on w.schedule_id = st.id and w.status not in ('completed', 'closed', 'canceled');
$function$;

CREATE OR REPLACE FUNCTION private.wo_complete_schedule(p_wo uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_wo public.work_orders%rowtype;
begin
  select * into v_wo from public.work_orders where id = p_wo;
  if v_wo.schedule_id is null then
    return;
  end if;
  update public.maintenance_schedules s set
    last_done_on    = private.business_today(v_wo.company_id),
    last_done_miles = coalesce(v_wo.odometer_at_service,
      (select r.odometer_miles from public.truck_readings r where r.company_id = v_wo.company_id
         and r.truck_id = v_wo.truck_id and r.odometer_miles is not null and r.set_aside_at is null order by r.read_at desc, r.odometer_miles desc limit 1),
      case when s.interval_miles is null then s.last_done_miles end),
    last_done_hours = coalesce(v_wo.engine_hours_at_service,
      (select r.engine_hours from public.truck_readings r where r.company_id = v_wo.company_id
         and r.truck_id = v_wo.truck_id and r.engine_hours is not null and r.set_aside_at is null order by r.read_at desc, r.engine_hours desc limit 1),
      case when s.interval_hours is null then s.last_done_hours end),
    updated_at = now()
  where s.id = v_wo.schedule_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_truck_reading(p_truck_id uuid, p_miles numeric, p_hours numeric, p_note text DEFAULT ''::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid := private.require_company();
  v_last    numeric;
  v_id      uuid;
begin
  perform private.require_permission('maintenance.manage');
  if p_miles is null and p_hours is null then
    raise exception 'Enter the odometer, the engine hours, or both.';
  end if;
  perform 1 from public.trucks where id = p_truck_id and company_id = v_company for update;
  if not found then
    raise exception 'Truck not found.' using errcode = 'P0002';
  end if;
  if p_miles is not null then
    select odometer_miles into v_last from public.truck_readings
    where company_id = v_company and truck_id = p_truck_id and odometer_miles is not null and set_aside_at is null order by read_at desc, odometer_miles desc limit 1;
    if v_last is not null and p_miles < v_last then
      raise exception 'The odometer cannot go down: the last reading was % miles.', v_last using errcode = '22023';
    end if;
  end if;
  if p_hours is not null then
    select engine_hours into v_last from public.truck_readings
    where company_id = v_company and truck_id = p_truck_id and engine_hours is not null and set_aside_at is null order by read_at desc, engine_hours desc limit 1;
    if v_last is not null and p_hours < v_last then
      raise exception 'Engine hours cannot go down: the last reading was % hours.', v_last using errcode = '22023';
    end if;
  end if;
  insert into public.truck_readings (company_id, truck_id, odometer_miles, engine_hours, note, recorded_by)
  values (v_company, p_truck_id, p_miles, p_hours, private.clean_text(p_note, 300, 'Note'), auth.uid())
  returning id into v_id;
  return v_id;
end;
$function$;
