-- =============================================================================
-- Demo shop samples when every truck already has open shop work (MD1 demo parity, 2026-11-11).
--
-- public.demo_shop_decision_samples() (20261120015500) picks trucks with no open work order. In the Cobalt Plains
-- Freight demo every truck already has an open job once the other maintenance samples are added, and in the Prairie
-- Lantern demo the free trucks are booked for the rest of the day in the morning, so those demos got no inspection
-- certificate to check and no unit "parked by hand, shop work done". Redefined from 20261120015500 with fallbacks; the
-- rest (permission, demo-only, once per sample, found again by its title or note) is unchanged:
--   3. Inspection certificate: a truck with no open work order as before; else an in-service trailer with no open work
--      order; else an in-service truck whose open jobs are none of them safety-critical. A vehicle whose current
--      inspection expires within 30 days is skipped (it is the "inspection due" sample, which recording would replace).
--   4. Parked by hand, shop work done: a parked or free truck as before; else a trailer: one already out of service with
--      no open work order, else an in-service trailer with no open work order and nothing booked from now on, parked
--      first ("Parked until the new tires are on (demo)"). A truck with open jobs is never used here: its shop work
--      is not done.
-- Trailers use the same functions as trucks (maintenance_create_work_order with trailer_id, maintenance_record_inspection,
-- private.apply_service_status 'trailer'); the office's certificate list, its alert and "Put it back in service?" already
-- cover trailers. Demo companies only, fictional records only; nothing is sent. Function only: no table, column or row
-- changes (demos get the samples at their next Refresh).
-- Works with the code before and after it. Reversible: supabase/rollbacks/20261120019500_demo_shop_samples_fallback.down.sql
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
  v_unit  uuid;
  v_kind  text;
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

  -- 3. An inspection certificate the shop recorded, not checked yet: a truck with no open work order; else a trailer
  --    with none; else a truck whose open jobs are none of them safety-critical. Never a vehicle whose current
  --    inspection expires within 30 days (the "inspection due" sample).
  if not exists (select 1 from public.work_orders where company_id = v_demo and title = 'Annual DOT inspection (demo)') then
    v_unit := null;
    v_kind := 'truck';
    select t.id into v_unit from public.trucks t
    where t.company_id = v_demo and t.active and t.service_status = 'in_service' and t.hauler_id is null and not (t.id = any (v_used))
      and not exists (select 1 from public.work_orders w where w.company_id = v_demo and w.truck_id = t.id
                      and w.status not in ('completed', 'closed', 'canceled'))
    order by t.unit_number desc limit 1;
    if v_unit is null then
      v_kind := 'trailer';
      select t.id into v_unit from public.trailers t
      where t.company_id = v_demo and t.active and t.service_status = 'in_service' and not (t.id = any (v_used))
        and not exists (select 1 from public.work_orders w where w.company_id = v_demo and w.trailer_id = t.id
                        and w.status not in ('completed', 'closed', 'canceled'))
        and not exists (select 1 from public.vehicle_documents d where d.company_id = v_demo and d.trailer_id = t.id
                        and d.kind = 'inspection' and d.archived_at is null and d.expires_on < v_today + 30)
      order by t.unit_number desc limit 1;
    end if;
    if v_unit is null then
      v_kind := 'truck';
      select t.id into v_unit from public.trucks t
      where t.company_id = v_demo and t.active and t.service_status = 'in_service' and t.hauler_id is null and not (t.id = any (v_used))
        and not exists (select 1 from public.work_orders w where w.company_id = v_demo and w.truck_id = t.id
                        and w.status not in ('completed', 'closed', 'canceled') and w.safety_critical)
        and not exists (select 1 from public.vehicle_documents d where d.company_id = v_demo and d.truck_id = t.id
                        and d.kind = 'inspection' and d.archived_at is null and d.expires_on < v_today + 30)
      order by t.unit_number desc limit 1;
    end if;
    if v_unit is not null then
      v_wo := (public.maintenance_create_work_order(jsonb_build_object(v_kind || '_id', v_unit, 'title', 'Annual DOT inspection (demo)',
        'category', 'inspection', 'urgency', 'normal', 'safety_critical', false,
        'description', 'Demo: annual inspection done in the shop; the certificate waits for the office to check it.')) ->> 'id')::uuid;
      perform public.maintenance_set_status(v_wo, 'in_progress', '', null);
      perform public.maintenance_set_status(v_wo, 'completed', 'Passed (demo).', null);
      perform public.maintenance_record_inspection(v_wo, jsonb_build_object('inspected_on', v_today - 1, 'expires_on', v_today + 364,
        'inspector', 'Shop inspector (demo)', 'reference', 'DOT-DEMO-2211'));
      v_used := v_used || v_unit;
      v_n := v_n + 1;
    end if;
  end if;

  -- 4. A unit parked by hand, its shop work all done. The demo's own parked truck (the seeds take one out of service by
  --    hand) gets its repair finished; without one, a free truck (nothing booked from now on) is parked first; without
  --    either, the same with a trailer. A unit with open shop work is never used: its shop work is not done.
  if not exists (select 1 from public.work_orders where company_id = v_demo and description = 'Demo: the work this truck was parked for is done. A person puts it back in service.')
     and not exists (select 1 from public.work_orders where company_id = v_demo and description = 'Demo: the work this trailer was parked for is done. A person puts it back in service.') then
    v_unit := null;
    v_kind := 'truck';
    select t.id, t.out_of_service_reason into v_unit, v_reason from public.trucks t
    where t.company_id = v_demo and t.active and t.service_status = 'out_of_service' and t.hauler_id is null and not (t.id = any (v_used))
      and not exists (select 1 from public.work_orders w where w.company_id = v_demo and w.truck_id = t.id
                      and w.status not in ('completed', 'closed', 'canceled'))
    order by t.unit_number limit 1;
    if v_unit is null then
      select t.id into v_unit from public.trucks t
      where t.company_id = v_demo and t.active and t.service_status = 'in_service' and t.hauler_id is null and not (t.id = any (v_used))
        and not exists (select 1 from public.work_orders w where w.company_id = v_demo and w.truck_id = t.id
                        and w.status not in ('completed', 'closed', 'canceled'))
        and not exists (select 1 from public.dispatch_assignments a
                        where a.company_id = v_demo and a.truck_id = t.id and a.status = 'active' and a.ends_at > now())
      order by t.unit_number desc limit 1;
      if v_unit is not null then
        v_reason := 'Parked until the new steer tires are on (demo)';
        perform private.apply_service_status(v_demo, 'truck', v_unit, 'out_of_service', v_reason, null);
      end if;
    end if;
    if v_unit is null then
      v_kind := 'trailer';
      select t.id, t.out_of_service_reason into v_unit, v_reason from public.trailers t
      where t.company_id = v_demo and t.active and t.service_status = 'out_of_service' and not (t.id = any (v_used))
        and not exists (select 1 from public.work_orders w where w.company_id = v_demo and w.trailer_id = t.id
                        and w.status not in ('completed', 'closed', 'canceled'))
      order by t.unit_number limit 1;
    end if;
    if v_unit is null then
      select t.id into v_unit from public.trailers t
      where t.company_id = v_demo and t.active and t.service_status = 'in_service' and not (t.id = any (v_used))
        and not exists (select 1 from public.work_orders w where w.company_id = v_demo and w.trailer_id = t.id
                        and w.status not in ('completed', 'closed', 'canceled'))
        and not exists (select 1 from public.dispatch_assignments a
                        where a.company_id = v_demo and a.trailer_id = t.id and a.status = 'active' and a.ends_at > now())
      order by t.unit_number desc limit 1;
      if v_unit is not null then
        v_reason := 'Parked until the new tires are on (demo)';
        perform private.apply_service_status(v_demo, 'trailer', v_unit, 'out_of_service', v_reason, null);
      end if;
    end if;
    if v_unit is not null then
      v_wo := (public.maintenance_create_work_order(jsonb_build_object(v_kind || '_id', v_unit,
        'title', left(coalesce(nullif(regexp_replace(v_reason, '\s*\(demo\)\s*$', ''), ''), 'Repair') || ' (demo)', 200),
        'category', 'repair', 'urgency', 'normal', 'safety_critical', false,
        'description', format('Demo: the work this %s was parked for is done. A person puts it back in service.', v_kind))) ->> 'id')::uuid;
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

-- Verification: still a pinned security definer function, demo-only.
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'demo_shop_decision_samples'
      and p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'])
  then
    raise exception 'public.demo_shop_decision_samples is not a pinned security definer function.';
  end if;
  if position('private.demo_owner_company()' in pg_get_functiondef('public.demo_shop_decision_samples()'::regprocedure)) = 0 then
    raise exception 'public.demo_shop_decision_samples must stay limited to demo companies.';
  end if;
end;
$$;
