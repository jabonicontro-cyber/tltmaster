-- =============================================================================
-- Realistic sample repair history in demos (owner decision 2026-11-16/17, WK3: "At risk" default 3 "and realistic demo
-- repairs").
--
-- Demos get fourteen completed sample jobs with recorded labor so Time estimates have history (src/server/demo/
-- samples.ts maintenanceHistory, marked by their description). They were all opened on the day the demo was made and
-- spread over the trucks in service, so with the sample open jobs nearly every demo truck had two or three unplanned
-- repairs "in the last 90 days" and read At risk. A real shop's history is spread over months.
--
-- public.demo_repair_history() moves, in a demo only, the sample history jobs back in time so that:
--   * every other truck keeps none of them recent: its level then comes from its own open jobs and records (Good with
--     none, Watch with one or two), as in a real shop;
--   * one truck keeps all its recent sample repairs, so the "3 unplanned repairs in 90 days" rule is still shown:
--     when the demo already has two or more trucks At risk for a mandatory reason (out of service, an open
--     safety-critical defect or restriction), that truck is one of them (the count of At risk trucks does not grow);
--     otherwise the truck with the most recent repairs. So one or two demo trucks read At risk;
--   * the jobs it moves land on their own days from about 130 days ago, nine days apart, where their recorded time
--     overlaps no one's other recorded time (most within the year the estimates use):
--     opened, started, worked (time entries), completed and closed move together by the same number of days, with their
--     history entries and crew, so every job still reads in the right order.
-- Only times move: never what, who, hours, status or truck. Only jobs carrying the sample description are touched, and
-- only in the caller's own demo company. Idempotent: a second run moves nothing (returns 0).
--
-- Safety: SECURITY DEFINER, search_path = ''. Only the active owner of an active demo company (private.
-- demo_owner_company()); real companies are refused (42501). Called by "Refresh demo data" and the demo seeds through
-- src/server/demo/samples.ts, after every other sample.
-- Additive (a new function); works with the code before and after it.
-- Reversible: supabase/rollbacks/20261120024620_demo_repair_history.down.sql
-- =============================================================================

create or replace function public.demo_repair_history()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_mark   constant text := 'Demo: a completed job, so maintenance estimates have history.';
  v_demo   uuid := private.demo_owner_company();
  v_today  date;
  v_since  timestamptz;
  v_focus  uuid;
  r        record;
  v_day    date;
  v_shift  interval;
  v_try    interval;
  v_k      integer;
  n        integer := 0;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  v_today := private.company_today(v_demo);
  -- The app counts repairs opened since midnight (UTC) 90 days ago (src/server/data/truck-health.ts).
  v_since := ((v_today - 90)::text || 'T00:00:00Z')::timestamptz;

  -- The demo's own trucks: whether each is At risk for a mandatory reason (out of service, an open safety-critical
  -- defect or restriction), its recent unplanned repairs other than the sample history, and its recent sample history.
  with t as (
    select t.id as truck_id, t.unit_number as unit,
           t.service_status = 'out_of_service'
             or exists (select 1 from public.work_orders w
                         where w.company_id = v_demo and w.truck_id = t.id
                           and w.status in ('reported', 'triaged', 'scheduled', 'in_progress', 'awaiting_parts', 'awaiting_inspection')
                           and (w.safety_critical or w.restricted_truck)) as hard,
           (select count(*) from public.work_orders w
             where w.company_id = v_demo and w.truck_id = t.id and w.created_at >= v_since and w.status <> 'canceled'
               and w.category not in ('preventive', 'inspection') and w.source <> 'preventive' and w.description <> c_mark) as other_recent,
           (select count(*) from public.work_orders w
             where w.company_id = v_demo and w.truck_id = t.id and w.created_at >= v_since and w.status <> 'canceled'
               and w.description = c_mark) as sample_recent
      from public.trucks t
     where t.company_id = v_demo and t.active and t.hauler_id is null
  )
  select case when (select count(*) from t where hard) >= 2
              then (select truck_id from t where hard and sample_recent > 0 order by sample_recent + other_recent desc, unit limit 1)
              else (select truck_id from t where sample_recent + other_recent > 0 order by sample_recent + other_recent desc, unit limit 1) end
    into v_focus;

  -- Days already taken by moved sample jobs (a second run continues after them, never on the same day).
  select coalesce(count(*), 0) into v_k from public.work_orders w
   where w.company_id = v_demo and w.description = c_mark and w.created_at < v_since;

  for r in
    select x.id, x.started from (
      select w.id, w.truck_id,
             coalesce((select min(e.started_at) from public.work_order_time_entries e where e.work_order_id = w.id and e.company_id = v_demo), w.created_at) as started,
             row_number() over (partition by w.truck_id order by w.created_at desc, w.id) as nth,
             dt.other_recent
        from public.work_orders w
        cross join lateral (
          select count(*) as other_recent from public.work_orders o
           where o.company_id = v_demo and o.truck_id = w.truck_id and o.created_at >= v_since and o.status <> 'canceled'
             and o.category not in ('preventive', 'inspection') and o.source <> 'preventive' and o.description <> c_mark) dt
       where w.company_id = v_demo and w.description = c_mark and w.created_at >= v_since
         and w.truck_id is distinct from v_focus
    ) x
    -- Every truck but the one that shows the rule: no recent sample repair.
    where x.nth >= 1
    order by x.started, x.id
  loop
    -- Its work goes on a day of its own, about 130 to 670 days ago (opened and completed shortly after, still more than
    -- 90 days ago), where none of its recorded time would overlap anyone's other recorded time. A job with no such day
    -- (not expected) is left where it is.
    v_shift := null;
    loop
      exit when v_k > 60;
      v_day := v_today - (130 + 9 * v_k);
      v_k := v_k + 1;
      v_try := (v_day - (r.started at time zone 'UTC')::date) * interval '1 day';
      if not exists (
        select 1 from public.work_order_time_entries e
          join public.work_order_time_entries o
            on o.company_id = e.company_id and o.user_id = e.user_id and o.work_order_id <> e.work_order_id and o.voided_at is null
         where e.company_id = v_demo and e.work_order_id = r.id and e.voided_at is null
           and tstzrange(e.started_at + v_try, coalesce(e.ended_at + v_try, 'infinity'::timestamptz), '[)')
               && tstzrange(o.started_at, coalesce(o.ended_at, 'infinity'::timestamptz), '[)')) then
        v_shift := v_try;
        exit;
      end if;
    end loop;
    continue when v_shift is null;
    update public.work_orders set
      created_at = created_at + v_shift, updated_at = updated_at + v_shift,
      work_started_at = work_started_at + v_shift, completed_at = completed_at + v_shift,
      closed_at = closed_at + v_shift, cleared_at = cleared_at + v_shift
     where id = r.id and company_id = v_demo;
    update public.work_order_time_entries set
      started_at = started_at + v_shift, ended_at = ended_at + v_shift, created_at = created_at + v_shift,
      voided_at = voided_at + v_shift
     where work_order_id = r.id and company_id = v_demo;
    update public.work_order_events set created_at = created_at + v_shift where work_order_id = r.id and company_id = v_demo;
    update public.work_order_mechanics set added_at = added_at + v_shift, updated_at = updated_at + v_shift
     where work_order_id = r.id and company_id = v_demo;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.demo_repair_history() from public, anon;
grant execute on function public.demo_repair_history() to authenticated;
