-- Driver schedule notices (requirement: drivers are told when their schedule changes).
--
-- Before: a driver was told only when an assignment was canceled. Now, inside Taviron only (in-app notifications;
-- nothing is sent by email or text, and informational notices never ask a driver to acknowledge while driving):
--   * dispatch.assignment_new      — a load was assigned to them (a new active assignment, including a swap, which
--                                    cancels the old assignment and creates a new one);
--   * dispatch.assignment_changed  — the date or times of a load they are assigned to changed.
-- Each distinct new schedule is its own notice (the source key includes the new date and times), so every change
-- reaches the driver once; the same change twice is merged. Companies can turn either type off in alert settings.

insert into public.alert_event_types (code, category, label, min_priority, default_priority, default_ack_scope, default_escalation_minutes) values
  ('dispatch.assignment_new',     'dispatch', 'A load was assigned to you', 'informational', 'informational', 'any', 60),
  ('dispatch.assignment_changed', 'dispatch', 'The date or time of your load changed', 'informational', 'informational', 'any', 60)
on conflict (code) do nothing;

-- "O-2026-0042 load 2 on Mon Oct 19, 7:00–8:30" (internal).
create or replace function private.load_schedule_label(p_load uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select o.order_number || ' load ' || l.load_number || ' on ' || to_char(l.load_date, 'Dy Mon FMDD') || ', '
         || to_char(l.start_time, 'FMHH24:MI') || '–' || to_char(l.end_time, 'FMHH24:MI')
  from public.order_loads l join public.orders o on o.id = l.order_id and o.company_id = l.company_id
  where l.id = p_load
$$;
revoke all on function private.load_schedule_label(uuid) from public, anon, authenticated;

-- New active assignment → its driver is told (drivers without a login cannot be notified).
create or replace function private.alerts_from_new_assignments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
$$;
revoke all on function private.alerts_from_new_assignments() from public, anon, authenticated;
drop trigger if exists alerts_new_assignments on public.dispatch_assignments;
create trigger alerts_new_assignments after insert on public.dispatch_assignments
  for each row execute function private.alerts_from_new_assignments();

-- A load's date or times changed → the drivers on its active assignments are told.
create or replace function private.alerts_from_load_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_label text;
begin
  if (new.load_date, new.start_time, new.end_time) is distinct from (old.load_date, old.start_time, old.end_time) then
    v_label := private.load_schedule_label(new.id);
    for r in
      select a.id, d.user_id from public.dispatch_assignments a
      join public.drivers d on d.id = a.driver_id and d.company_id = a.company_id
      where a.load_id = new.id and a.company_id = new.company_id and a.status = 'active' and d.user_id is not null
    loop
      perform private.comm_raise_alert(new.company_id, 'dispatch.assignment_changed',
        r.id::text || ':' || new.load_date || ':' || new.start_time || ':' || new.end_time, 'load', new.id,
        'Changed: ' || coalesce(v_label, 'your load'),
        'Was ' || to_char(old.load_date, 'Dy Mon FMDD') || ', ' || to_char(old.start_time, 'FMHH24:MI') || '–' || to_char(old.end_time, 'FMHH24:MI') || '. Check My Day.',
        '/driver', array[r.user_id]);
    end loop;
  end if;
  return null;
end;
$$;
revoke all on function private.alerts_from_load_changes() from public, anon, authenticated;
drop trigger if exists alerts_load_changes on public.order_loads;
create trigger alerts_load_changes after update of load_date, start_time, end_time on public.order_loads
  for each row execute function private.alerts_from_load_changes();
