-- =============================================================================
-- Demo sample: a shop job scheduled before its ordered part arrives (owner decision 2026-11-16/17, WK3).
--
-- The app now warns when a job is scheduled before a part it waits for is expected, and offers "Move to <arrival
-- date>" (the person decides; nothing moves on its own): on the work order, the Maintenance overview (next 7 days),
-- Shop capacity (next 14 days), My jobs and the edit form. So demos show it, public.demo_part_arrival_sample() adds,
-- once per demo, a scheduled job two days out ("Replace wiper motor (demo)") on an in-service truck, led by the demo
-- owner running the samples (so the Mechanic preview's My jobs shows it too), with its part on order expected five days
-- out. Made through the work order functions (maintenance_create_work_order, maintenance_set_estimate, part_wait_add);
-- the job is not started, so the truck keeps running (the part-on-order rule, 20261120015000). Found again by its title,
-- so Refresh adds nothing twice.
--
-- Safety: SECURITY DEFINER, search_path = ''. Only the active owner of an active demo company
-- (private.demo_owner_company()); real companies are refused (42501). Fictional records only; nothing is sent.
-- Additive (a new function); works with the code before and after it.
-- Reversible: supabase/rollbacks/20261120024630_demo_part_arrival_sample.down.sql
-- =============================================================================

create or replace function public.demo_part_arrival_sample()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_title constant text := 'Replace wiper motor (demo)';
  v_demo  uuid := private.demo_owner_company();
  v_today date;
  v_truck uuid;
  v_wo    uuid;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.work_orders where company_id = v_demo and title = c_title) then
    return 0;
  end if;
  v_today := private.business_today(v_demo);
  -- An in-service truck of the demo's own, preferring one with no open shop work.
  select t.id into v_truck from public.trucks t
   where t.company_id = v_demo and t.active and t.service_status = 'in_service' and t.hauler_id is null
   order by exists (select 1 from public.work_orders w where w.company_id = v_demo and w.truck_id = t.id
                     and w.status not in ('completed', 'closed', 'canceled')), t.unit_number desc
   limit 1;
  if v_truck is null then
    return 0;
  end if;
  v_wo := (public.maintenance_create_work_order(jsonb_build_object(
    'truck_id', v_truck, 'title', c_title, 'category', 'electrical', 'urgency', 'normal', 'safety_critical', false,
    'scheduled_for', v_today + 2, 'assigned_to', auth.uid(),
    'description', 'Demo: the wiper motor is on order and expected after the day this job is booked.')) ->> 'id')::uuid;
  perform public.maintenance_set_estimate(v_wo, 1.0);
  perform public.part_wait_add(v_wo, jsonb_build_object('description', 'Wiper motor (demo)', 'part_number', 'WM-410',
    'vendor_name', 'Fictional Truck Parts (demo)', 'po_number', 'PO-DEMO-1093', 'expected_on', v_today + 5, 'set_waiting', false));
  return 1;
end;
$$;
revoke all on function public.demo_part_arrival_sample() from public, anon;
grant execute on function public.demo_part_arrival_sample() to authenticated;
