-- =============================================================================
-- Tell the driver when a stop is added to their load (owner decision 2026-11-16/17, WK3: "yes", in the app, no texts).
--
-- Until now a driver was told when a load was assigned to them, when its date or times changed and when its truck
-- changed (20261114000500, 20261120011400), but not when the office added a pickup or a delivery to the order of a load
-- they are already assigned. Now, inside Taviron only (an in-app notice on My Day under "Updates from dispatch", which
-- they dismiss with "Got it"; nothing is sent by email or text):
--   * dispatch.stop_added  a stop (or several, saved together) was added to the order of a load they are assigned to,
--                          from today on (the load is planned, not released, and the assignment is active).
-- One notice per assignment per save: "Stop added: O-2026-0042 load 2 on Mon Oct 19, 7:00–8:30" (or "2 stops added:"),
-- with the new stops named in the detail. Drivers without a login cannot be told (as for the other dispatch notices).
-- Changing or removing a stop raises nothing new. Companies can turn the type off in alert settings, like the others.
--
-- private.alerts_from_new_stops: a deferred row trigger on inserts into public.order_stops (inserts come from
-- public.save_order_stops, which checks orders.edit or the person's own order, and from the demo samples). It runs when
-- the save is committed, so it sees the whole save: public.save_order_stops inserts each new stop separately, and a
-- save is one transaction, so the stops of one save are the order's current stops created at the same transaction
-- time. The first of them raises the notice; the others find it (same source key: assignment and first new stop) and
-- add nothing. A stop removed again before the commit is not told. SECURITY DEFINER, search_path = '': it reads the
-- inserted stop's own company (never the caller's) and notifies only the drivers on that company's active assignments
-- of the stop's own order.
-- Additive (a new alert type, a new function and trigger); works with the code before and after it.
-- Reversible: supabase/rollbacks/20261120024600_stop_added_notice.down.sql
-- =============================================================================

insert into public.alert_event_types (code, category, label, min_priority, default_priority, default_ack_scope, default_escalation_minutes) values
  ('dispatch.stop_added', 'dispatch', 'A stop was added to your load', 'informational', 'informational', 'any', 60)
on conflict (code) do nothing;

create or replace function private.alerts_from_new_stops()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r       record;
  v_first uuid;
  v_key   text;
begin
  -- The stops of this save: the order's current stops created in the same transaction.
  if not exists (select 1 from public.order_stops where id = new.id and company_id = new.company_id and removed_at is null) then
    return null;
  end if;
  select s.id into v_first from public.order_stops s
   where s.order_id = new.order_id and s.company_id = new.company_id and s.created_at = new.created_at and s.removed_at is null
   order by s.seq, s.id limit 1;
  for r in
    select a.id as assignment_id, a.load_id, d.user_id,
           count(*) as stops,
           string_agg(
             case n.kind when 'pickup' then 'Pickup at ' else 'Delivery at ' end || n.name
             || coalesce(' (' || nullif(concat_ws(', ', nullif(n.city, ''), nullif(n.state, '')), '') || ')', '')
             || case when n.appointment_date is null then ''
                     else ', ' || to_char(n.appointment_date, 'Dy Mon FMDD')
                          || coalesce(' ' || to_char(n.window_start, 'FMHH24:MI') || '–' || to_char(n.window_end, 'FMHH24:MI'), '') end,
             '; ' order by n.seq, n.id) as places
      from public.order_stops n
      join public.order_loads l on l.order_id = n.order_id and l.company_id = n.company_id
      join public.dispatch_assignments a on a.load_id = l.id and a.company_id = l.company_id and a.status = 'active'
      join public.drivers d on d.id = a.driver_id and d.company_id = a.company_id
     where n.order_id = new.order_id and n.company_id = new.company_id and n.created_at = new.created_at and n.removed_at is null
       and l.status = 'planned' and l.released_at is null
       and l.load_date >= private.business_today(new.company_id)
       and d.user_id is not null
     group by a.id, a.load_id, d.user_id
  loop
    v_key := r.assignment_id::text || ':stop:' || v_first::text;
    continue when exists (select 1 from public.alerts x
                           where x.company_id = new.company_id and x.event_type = 'dispatch.stop_added' and x.source_key = v_key);
    perform private.comm_raise_alert(new.company_id, 'dispatch.stop_added', v_key, 'load', r.load_id,
      case when r.stops = 1 then 'Stop added: ' else r.stops || ' stops added: ' end
        || coalesce(private.load_schedule_label(r.load_id), 'your load'),
      left(r.places, 900) || '. Check My Day.',
      '/driver', array[r.user_id]);
  end loop;
  return null;
end;
$$;
revoke all on function private.alerts_from_new_stops() from public, anon, authenticated;

drop trigger if exists alerts_new_stops on public.order_stops;
create constraint trigger alerts_new_stops after insert on public.order_stops
  deferrable initially deferred
  for each row execute function private.alerts_from_new_stops();
