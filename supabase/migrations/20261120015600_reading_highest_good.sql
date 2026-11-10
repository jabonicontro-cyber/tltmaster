-- =============================================================================
-- The truck's current reading is its highest reading not set aside, everywhere (owner decision 2026-11-09, MD1).
--
-- 20261120015100 lets a person set a wrong reading aside. The reading feed (private.feed_truck_reading) already takes
-- the highest reading not set aside as the current one. The other places took the latest one by time, which is the same
-- reading as long as readings only go up, but not when an old record (entered before readings were checked) is lower
-- than an earlier one. Now they all take the highest reading not set aside (the latest one among equal values):
--   private.pm_due (preventive due by miles or hours, maintenance_pm_status; the time of that reading is still the one
--     used for "readings older than 30 days"),
--   private.wo_complete_schedule (the reading stored when a preventive job is completed),
--   public.record_truck_reading (the Preventive page's "cannot go down" check; same message).
-- The truck's page shows the same: the highest reading not marked wrong (src/components/fleet/vehicle-sections.tsx).
-- Bodies otherwise identical to 20261120015100.
-- Additive; works with the code before and after it.
-- Reversible: supabase/rollbacks/20261120015600_reading_highest_good.down.sql
-- =============================================================================

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
      order by r.odometer_miles desc, r.read_at desc limit 1) m on true
    left join lateral (select r.engine_hours, r.read_at from public.truck_readings r
      where r.company_id = s.company_id and r.truck_id = s.truck_id and r.engine_hours is not null and r.set_aside_at is null
      order by r.engine_hours desc, r.read_at desc limit 1) h on true
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
      (select max(r.odometer_miles) from public.truck_readings r where r.company_id = v_wo.company_id
         and r.truck_id = v_wo.truck_id and r.set_aside_at is null),
      case when s.interval_miles is null then s.last_done_miles end),
    last_done_hours = coalesce(v_wo.engine_hours_at_service,
      (select max(r.engine_hours) from public.truck_readings r where r.company_id = v_wo.company_id
         and r.truck_id = v_wo.truck_id and r.set_aside_at is null),
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
    select max(odometer_miles) into v_last from public.truck_readings
    where company_id = v_company and truck_id = p_truck_id and set_aside_at is null;
    if v_last is not null and p_miles < v_last then
      raise exception 'The odometer cannot go down: the last reading was % miles.', v_last using errcode = '22023';
    end if;
  end if;
  if p_hours is not null then
    select max(engine_hours) into v_last from public.truck_readings
    where company_id = v_company and truck_id = p_truck_id and set_aside_at is null;
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
