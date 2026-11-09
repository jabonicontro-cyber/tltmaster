-- Truck-only swap notices (owner 2026-11-09: "a truck swap should not look like I lost my load").
--
-- A reassignment cancels the old assignment and creates a new one (assign_load). When only the truck or trailer
-- changes (same driver, same load, same times), the driver used to get two notices: "Your assignment ... was canceled"
-- and "New load: ...". Now they get one, inside Taviron only: "Truck changed: <load>", naming the new and the old
-- equipment. Every other case is told as before.
--   * private.alerts_from_new_assignments: a new assignment that replaces one of the same driver, load and times raises
--     dispatch.assignment_truck instead of dispatch.assignment_new.
--   * The cancel notice (private.alerts_from_assignments, 20261105000300) now runs when the change is saved (a deferred
--     trigger, at commit), so it can see the replacement made in the same save, and stays silent for such a swap.
-- Nothing is sent by email or text. Companies can turn the new type off in alert settings, like the others.
-- Reversible: supabase/rollbacks/20261120011400_truck_swap_notice.down.sql

insert into public.alert_event_types (code, category, label, min_priority, default_priority, default_ack_scope, default_escalation_minutes) values
  ('dispatch.assignment_truck', 'dispatch', 'The truck or trailer on your load changed', 'informational', 'informational', 'any', 60)
on conflict (code) do nothing;

-- Whether an assignment is a truck-only swap of another: same driver, load and times.
create or replace function private.is_truck_only_swap(p_old public.dispatch_assignments, p_new public.dispatch_assignments)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_old.id is not null and p_new.driver_id is not null
     and p_old.company_id = p_new.company_id and p_old.load_id = p_new.load_id
     and p_old.driver_id = p_new.driver_id
     and p_old.starts_at is not distinct from p_new.starts_at and p_old.ends_at is not distinct from p_new.ends_at
$$;
revoke all on function private.is_truck_only_swap(public.dispatch_assignments, public.dispatch_assignments) from public, anon, authenticated;

create or replace function private.alerts_from_new_assignments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_old  public.dispatch_assignments%rowtype;
begin
  if new.status = 'active' and new.driver_id is not null then
    select user_id into v_user from public.drivers where id = new.driver_id and company_id = new.company_id;
    if v_user is not null then
      if new.replaces_assignment_id is not null then
        select * into v_old from public.dispatch_assignments where id = new.replaces_assignment_id and company_id = new.company_id;
      end if;
      if new.replaces_assignment_id is not null and private.is_truck_only_swap(v_old, new) then
        perform private.comm_raise_alert(new.company_id, 'dispatch.assignment_truck', new.id::text, 'load', new.load_id,
          'Truck changed: ' || coalesce(private.load_schedule_label(new.load_id), 'your load'),
          'Now ' || coalesce(nullif(private.assignment_label(new.truck_id, new.trailer_id, null), ''), 'no truck')
            || '. Was ' || coalesce(nullif(private.assignment_label(v_old.truck_id, v_old.trailer_id, null), ''), 'no truck')
            || '. Same load and times. Check My Day.',
          '/driver', array[v_user]);
      else
        perform private.comm_raise_alert(new.company_id, 'dispatch.assignment_new', new.id::text, 'load', new.load_id,
          'New load: ' || coalesce(private.load_schedule_label(new.load_id), 'a load'), 'It is on My Day.', '/driver', array[v_user]);
      end if;
    end if;
  end if;
  return null;
end;
$$;
revoke all on function private.alerts_from_new_assignments() from public, anon, authenticated;

create or replace function private.alerts_from_assignments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_label text;
begin
  if new.status = 'canceled' and old.status = 'active' then
    -- Told once as "Truck changed" by the replacement (alerts_from_new_assignments) when only the equipment changed.
    if exists (select 1 from public.dispatch_assignments n
               where n.replaces_assignment_id = new.id and n.company_id = new.company_id and n.status = 'active'
                 and private.is_truck_only_swap(new, n)) then
      return null;
    end if;
    select user_id into v_user from public.drivers where id = new.driver_id;
    if v_user is not null then
      select o.order_number || ' load ' || l.load_number into v_label from public.order_loads l join public.orders o on o.id = l.order_id where l.id = new.load_id;
      perform private.comm_raise_alert(new.company_id, 'dispatch.assignment_canceled', new.id::text, 'load', new.load_id,
        'Your assignment on ' || coalesce(v_label, 'a load') || ' was canceled', 'Check My Day for your current loads.', '/driver', array[v_user]);
    end if;
  end if;
  return null;
end;
$$;
revoke all on function private.alerts_from_assignments() from public, anon, authenticated;

-- At commit (after the replacement exists), not at the moment of the cancel.
drop trigger if exists alerts_assignments on public.dispatch_assignments;
create constraint trigger alerts_assignments after update of status on public.dispatch_assignments
  deferrable initially deferred
  for each row execute function private.alerts_from_assignments();
