-- Rollback of 20261120011400_truck_swap_notice: a truck-only swap is told as a cancel plus a new load again, and the
-- cancel notice fires at the moment of the cancel (20261105000300 / 20261114000500 definitions). The alert type
-- dispatch.assignment_truck is kept (notices already raised refer to it); nothing raises it any more.
begin;
CREATE OR REPLACE FUNCTION private.alerts_from_new_assignments()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid;
begin
  if new.status = 'active' and new.driver_id is not null then
    select user_id into v_user from public.drivers where id = new.driver_id and company_id = new.company_id;
    if v_user is not null then
      perform private.comm_raise_alert(new.company_id, 'dispatch.assignment_new', new.id::text, 'load', new.load_id,
        'New load: ' || coalesce(private.load_schedule_label(new.load_id), 'a load'), 'It is on My Day.', '/driver', array[v_user]);
    end if;
  end if;
  return null;
end;
$function$

;
CREATE OR REPLACE FUNCTION private.alerts_from_assignments()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid;
  v_label text;
begin
  if new.status = 'canceled' and old.status = 'active' then
    select user_id into v_user from public.drivers where id = new.driver_id;
    if v_user is not null then
      select o.order_number || ' load ' || l.load_number into v_label from public.order_loads l join public.orders o on o.id = l.order_id where l.id = new.load_id;
      perform private.comm_raise_alert(new.company_id, 'dispatch.assignment_canceled', new.id::text, 'load', new.load_id,
        'Your assignment on ' || coalesce(v_label, 'a load') || ' was canceled', 'Check My Day for your current loads.', '/driver', array[v_user]);
    end if;
  end if;
  return null;
end;
$function$

;
revoke all on function private.alerts_from_new_assignments() from public, anon, authenticated;
revoke all on function private.alerts_from_assignments() from public, anon, authenticated;
drop trigger if exists alerts_assignments on public.dispatch_assignments;
create trigger alerts_assignments after update of status on public.dispatch_assignments
  for each row execute function private.alerts_from_assignments();
drop function if exists private.is_truck_only_swap(public.dispatch_assignments, public.dispatch_assignments);
commit;
