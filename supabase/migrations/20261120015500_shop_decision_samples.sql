-- =============================================================================
-- Demo samples for the mechanic and dispatcher decisions of 2026-11-09 (master plan MD1).
--
-- public.demo_shop_decision_samples(): demo owner only (private.demo_owner_company); each sample once, found again by
-- its fictional title or note, so Refresh adds nothing twice. Fictional records only, through the app's own functions
-- where one exists; nothing is sent. In the demo:
--   1. a job waiting for a part that has not started (a seat cushion, not a safety repair) on an in-service truck: the
--      truck stays dispatchable and the board shows "Part on order: ..., expected ..." (20261120015000);
--   2. a wrong odometer reading (one digit typed wrong, entered in Maintenance) and a correct reading after it that the feed did not use
--      ('truck.reading_ignored'), so the truck's page shows the problem and "Mark as wrong" (20261120015100);
--   3. an annual inspection certificate recorded by the shop from its inspection work order, not checked yet, so the
--      office's to-do lists it (20261120015200);
--   4. a truck a person took out of service whose shop work is all done, so the shop and dispatch see
--      "Put it back in service?" (20261120015300): the demo's own parked truck (the seeds park one by hand) gets its
--      repair finished; a demo without one parks a free truck first.
-- Trucks are picked among the company's own (not hired), active trucks with no open work order; a truck parked for 4 has
-- nothing booked from now on, so no booked work is disturbed (Refresh runs this last, after every sample assignment).
-- Additive; works with the code before and after it.
-- Reversible: supabase/rollbacks/20261120015500_shop_decision_samples.down.sql
-- =============================================================================

create or replace function public.demo_shop_decision_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo  uuid := private.demo_owner_company();
  v_today date;
  v_n     integer := 0;
  v_used  uuid[] := '{}';
  v_truck uuid;
  v_wo    uuid;
  v_cur   numeric;
  v_reason text;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  v_today := private.business_today(v_demo);

  -- 1. Part on order, job not started.
  if not exists (select 1 from public.work_orders where company_id = v_demo and title = 'Replace torn driver seat cushion (demo)') then
    select t.id into v_truck from public.trucks t
    where t.company_id = v_demo and t.active and t.service_status = 'in_service' and t.hauler_id is null
      and not exists (select 1 from public.work_orders w where w.company_id = v_demo and w.truck_id = t.id
                      and w.status not in ('completed', 'closed', 'canceled'))
    order by t.unit_number limit 1;
    if v_truck is not null then
      v_wo := (public.maintenance_create_work_order(jsonb_build_object('truck_id', v_truck, 'title', 'Replace torn driver seat cushion (demo)',
        'category', 'body', 'urgency', 'low', 'safety_critical', false,
        'description', 'Demo: the cushion is on order. The truck keeps running until the shop starts the job.')) ->> 'id')::uuid;
      perform public.part_wait_add(v_wo, jsonb_build_object('description', 'Driver seat cushion (demo)', 'part_number', 'SC-220',
        'vendor_name', 'Fictional Truck Parts (demo)', 'po_number', 'PO-DEMO-1077', 'expected_on', v_today + 4, 'set_waiting', true));
      -- The shop's estimate, like the demo's other open jobs (Shop capacity counts estimated work).
      perform public.maintenance_set_estimate(v_wo, 1.5);
      v_used := v_used || v_truck;
      v_n := v_n + 1;
    end if;
  end if;

  -- 2. A wrong reading, and a correct one after it that was not used.
  if not exists (select 1 from public.truck_readings where company_id = v_demo and note = 'Demo: one digit typed wrong') then
    v_truck := null;
    select r.truck_id, max(r.odometer_miles) into v_truck, v_cur from public.truck_readings r
    join public.trucks t on t.id = r.truck_id and t.company_id = r.company_id and t.active and t.hauler_id is null
    where r.company_id = v_demo and r.odometer_miles is not null and r.set_aside_at is null and not (r.truck_id = any (v_used))
    group by r.truck_id order by r.truck_id limit 1;
    if v_truck is not null then
      insert into public.truck_readings (company_id, truck_id, odometer_miles, note, recorded_by, source, read_at)
      values (v_demo, v_truck, v_cur + 1000, 'Demo: one digit typed wrong', auth.uid(), 'manual', now() - interval '2 days');
      perform private.feed_truck_reading(v_demo, v_truck, v_cur + 140, null, 'inspection', null);
      v_used := v_used || v_truck;
      v_n := v_n + 1;
    end if;
  end if;

  -- 3. An inspection certificate the shop recorded, not checked yet.
  if not exists (select 1 from public.work_orders where company_id = v_demo and title = 'Annual DOT inspection (demo)') then
    v_truck := null;
    select t.id into v_truck from public.trucks t
    where t.company_id = v_demo and t.active and t.service_status = 'in_service' and t.hauler_id is null and not (t.id = any (v_used))
      and not exists (select 1 from public.work_orders w where w.company_id = v_demo and w.truck_id = t.id
                      and w.status not in ('completed', 'closed', 'canceled'))
    order by t.unit_number desc limit 1;
    if v_truck is not null then
      v_wo := (public.maintenance_create_work_order(jsonb_build_object('truck_id', v_truck, 'title', 'Annual DOT inspection (demo)',
        'category', 'inspection', 'urgency', 'normal', 'safety_critical', false,
        'description', 'Demo: annual inspection done in the shop; the certificate waits for the office to check it.')) ->> 'id')::uuid;
      perform public.maintenance_set_status(v_wo, 'in_progress', '', null);
      perform public.maintenance_set_status(v_wo, 'completed', 'Passed (demo).', null);
      perform public.maintenance_record_inspection(v_wo, jsonb_build_object('inspected_on', v_today - 1, 'expires_on', v_today + 364,
        'inspector', 'Shop inspector (demo)', 'reference', 'DOT-DEMO-2211'));
      v_used := v_used || v_truck;
      v_n := v_n + 1;
    end if;
  end if;

  -- 4. A truck parked by hand, its shop work all done. The demo's own parked truck (the seeds take one out of service by
  --    hand) gets its repair finished; without one, a free truck (nothing booked from now on) is parked first.
  if not exists (select 1 from public.work_orders where company_id = v_demo and description = 'Demo: the work this truck was parked for is done. A person puts it back in service.') then
    v_truck := null;
    select t.id, t.out_of_service_reason into v_truck, v_reason from public.trucks t
    where t.company_id = v_demo and t.active and t.service_status = 'out_of_service' and t.hauler_id is null and not (t.id = any (v_used))
      and not exists (select 1 from public.work_orders w where w.company_id = v_demo and w.truck_id = t.id
                      and w.status not in ('completed', 'closed', 'canceled'))
    order by t.unit_number limit 1;
    if v_truck is null then
      select t.id into v_truck from public.trucks t
      where t.company_id = v_demo and t.active and t.service_status = 'in_service' and t.hauler_id is null and not (t.id = any (v_used))
        and not exists (select 1 from public.work_orders w where w.company_id = v_demo and w.truck_id = t.id
                        and w.status not in ('completed', 'closed', 'canceled'))
        and not exists (select 1 from public.dispatch_assignments a
                        where a.company_id = v_demo and a.truck_id = t.id and a.status = 'active' and a.ends_at > now())
      order by t.unit_number desc limit 1;
      if v_truck is not null then
        v_reason := 'Parked until the new steer tires are on (demo)';
        perform private.apply_service_status(v_demo, 'truck', v_truck, 'out_of_service', v_reason, null);
      end if;
    end if;
    if v_truck is not null then
      v_wo := (public.maintenance_create_work_order(jsonb_build_object('truck_id', v_truck,
        'title', left(coalesce(nullif(regexp_replace(v_reason, '\s*\(demo\)\s*$', ''), ''), 'Repair') || ' (demo)', 200),
        'category', 'repair', 'urgency', 'normal', 'safety_critical', false,
        'description', 'Demo: the work this truck was parked for is done. A person puts it back in service.')) ->> 'id')::uuid;
      perform public.maintenance_set_status(v_wo, 'in_progress', '', null);
      perform public.maintenance_set_status(v_wo, 'completed', 'Done (demo).', null);
      v_n := v_n + 1;
    end if;
  end if;
  return v_n;
end;
$$;
revoke all on function public.demo_shop_decision_samples() from public, anon;
grant execute on function public.demo_shop_decision_samples() to authenticated;
