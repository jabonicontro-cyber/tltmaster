-- =============================================================================
-- Demo speed history (B86, owner 2026-10-26: "add realistic demo timings").
--
-- The Command Center "Speed" figures are measured from recorded times: when trucks were assigned for the next day,
-- when tickets were entered and accepted. Demo records are written by the seed in seconds, so those figures would read
-- "not enough measured yet" in every demo. public.demo_speed_history() spreads the demo's own past records over
-- realistic times: each past delivery day's assignments made the afternoon before, a few minutes apart; each clean,
-- accepted ticket entered shortly after its delivery and accepted in a twice-weekly afternoon review sitting, about a
-- minute apart. Only times change (assignment created_at; ticket created_at and reviewed_at; the matching ticket history
-- entries) — never who, what, quantities or statuses.
--
-- Safety:
-- * Only the active owner of an active demo company can run it (private.demo_owner_company()); real companies are
--   refused. Called by "Refresh demo data" (src/server/demo/samples.ts).
-- * The guards that keep assignments, tickets and ticket history unchangeable allow a time-only change only inside
--   this function's transaction (tlt.demo_timing, set locally) and only for demo companies. Every other change is
--   still refused exactly as before.
-- * Idempotent: only records still carrying seed-time stamps (assigned on or after their delivery day; ticket entered
--   more than a day after its delivery) are moved, so a second run changes nothing.
--
-- Reversible: supabase/rollbacks/20261120003600_demo_speed_history.down.sql (restores the guards; moved demo times
-- stay as they are, which is harmless demo data).
-- =============================================================================

-- True when a time-only demo adjustment is in progress for this company.
create or replace function private.demo_timing_allowed(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select current_setting('tlt.demo_timing', true) = 'on'
     and exists (select 1 from public.companies c where c.id = p_company and c.is_demo);
$$;
revoke all on function private.demo_timing_allowed(uuid) from public, anon, authenticated;

create or replace function private.guard_dispatch_assignment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('tlt.sample_purge', true) = 'on' then
      return old;
    end if;
    raise exception 'Dispatch assignments are history and cannot be deleted. Cancel them instead.' using errcode = '42501';
  end if;
  if old.status = 'canceled' then
    raise exception 'A canceled assignment cannot be changed.' using errcode = '42501';
  end if;
  -- Demo speed history: the creation time alone may move, in a demo, inside public.demo_speed_history().
  if new.created_at is distinct from old.created_at and private.demo_timing_allowed(old.company_id)
     and (to_jsonb(new) - 'created_at') = (to_jsonb(old) - 'created_at') then
    return new;
  end if;
  if (new.load_id, new.order_id, new.truck_id, new.trailer_id, new.driver_id, new.created_by, new.created_at,
      new.replaces_assignment_id, new.warnings, new.note)
     is distinct from
     (old.load_id, old.order_id, old.truck_id, old.trailer_id, old.driver_id, old.created_by, old.created_at,
      old.replaces_assignment_id, old.warnings, old.note) then
    raise exception 'Assignments cannot be edited. Reassign the load instead.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function private.guard_delivery_ticket()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('tlt.sample_purge', true) = 'on' then
      return old;
    end if;
    raise exception 'Delivery tickets cannot be deleted. Void them instead.' using errcode = '42501';
  end if;
  -- Demo speed history: entry and review times alone may move, in a demo, inside public.demo_speed_history().
  if (new.created_at, new.reviewed_at) is distinct from (old.created_at, old.reviewed_at) and private.demo_timing_allowed(old.company_id)
     -- ticket_ref_key is generated (not yet computed in NEW inside a BEFORE trigger), so it is left out of the comparison.
     and (to_jsonb(new) - 'created_at' - 'reviewed_at' - 'ticket_ref_key') = (to_jsonb(old) - 'created_at' - 'reviewed_at' - 'ticket_ref_key') then
    return new;
  end if;
  if (new.ticket_number, new.revision, new.supersedes_id, new.order_id, new.load_id, new.assignment_id,
      new.order_line_id, new.material_id, new.truck_id, new.trailer_id, new.driver_id, new.delivered_at,
      new.quantity, new.unit_code, new.external_reference, new.notes, new.review_reasons, new.snapshot,
      new.correction_reason, new.submission_key, new.created_by, new.created_at)
     is distinct from
     (old.ticket_number, old.revision, old.supersedes_id, old.order_id, old.load_id, old.assignment_id,
      old.order_line_id, old.material_id, old.truck_id, old.trailer_id, old.driver_id, old.delivered_at,
      old.quantity, old.unit_code, old.external_reference, old.notes, old.review_reasons, old.snapshot,
      old.correction_reason, old.submission_key, old.created_by, old.created_at) then
    raise exception 'A submitted ticket cannot be edited. Use a correction.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status in ('submitted', 'needs_review') and new.status in ('accepted', 'needs_review', 'voided', 'superseded'))
    or (old.status = 'accepted' and new.status in ('needs_review', 'voided', 'superseded'))) then
    raise exception 'A % ticket cannot become %.', old.status, new.status using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function private.prevent_modification()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('tlt.sample_purge', true) = 'on'
     and tg_table_name in ('quote_status_events', 'email_deliveries', 'documents', 'order_status_events',
                           'delivery_ticket_events', 'billing_reviews', 'portal_messages') then
    return old;
  end if;
  -- Demo speed history: a ticket history entry's time alone may move, in a demo, inside public.demo_speed_history().
  if tg_op = 'UPDATE' and tg_table_name = 'delivery_ticket_events'
     and private.demo_timing_allowed((to_jsonb(old) ->> 'company_id')::uuid)
     and (to_jsonb(new) - 'occurred_at') = (to_jsonb(old) - 'occurred_at') then
    return new;
  end if;
  raise exception '% rows are append-only and cannot be changed or deleted.', tg_table_name
    using errcode = '42501';
end;
$$;

create or replace function public.demo_speed_history()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_tz text;
  v_today date;
  v_assignments int := 0;
  v_tickets int := 0;
begin
  if v_demo is null then
    raise exception 'Demo timings are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  select s.timezone into v_tz from public.company_settings s where s.company_id = v_demo;
  v_tz := coalesce(nullif(v_tz, ''), 'America/Chicago');
  v_today := (now() at time zone v_tz)::date;
  perform set_config('tlt.demo_timing', 'on', true);

  -- Planning: each past delivery day's trucks assigned the afternoon before, about four minutes apart.
  with targets as (
    select a.id, (a.starts_at at time zone v_tz)::date as d,
           row_number() over (partition by (a.starts_at at time zone v_tz)::date order by a.starts_at, a.id) as rn
    from public.dispatch_assignments a
    where a.company_id = v_demo
      and a.status = 'active'
      and (a.starts_at at time zone v_tz)::date between v_today - 28 and v_today - 1
      and (a.created_at at time zone v_tz)::date >= (a.starts_at at time zone v_tz)::date
  )
  update public.dispatch_assignments a
     set created_at = ((t.d - 1) + time '13:30'
                       + make_interval(mins => (extract(dow from t.d)::int % 4) * 12)
                       + make_interval(secs => t.rn * 220)) at time zone v_tz
    from targets t
   where a.id = t.id;
  get diagnostics v_assignments = row_count;

  -- Tickets: clean first revisions accepted later than a day after delivery (seeded). Entered 25–61 minutes after the
  -- delivery; accepted in the office's Tuesday and Friday afternoon review sittings (from 3:45 PM; a delivery after 3 PM
  -- waits for the next one), about a minute apart, never before the entry.
  with targets as (
    select t.id, t.delivered_at,
           t.delivered_at + make_interval(mins => 25 + (row_number() over (order by t.delivered_at, t.id))::int % 5 * 9) as entered,
           (select min(x)::date
              from generate_series(case when (t.delivered_at at time zone v_tz)::time < time '15:00'
                                        then (t.delivered_at at time zone v_tz)::date
                                        else (t.delivered_at at time zone v_tz)::date + 1 end::timestamp,
                                   (t.delivered_at at time zone v_tz)::date + 8, interval '1 day') x
             where extract(dow from x) in (2, 5)) as review_day
    from public.delivery_tickets t
    where t.company_id = v_demo
      and t.status = 'accepted'
      and t.revision = 1
      and cardinality(t.review_reasons) = 0
      and (t.delivered_at at time zone v_tz)::date between v_today - 28 and v_today - 1
      and t.created_at > t.delivered_at + interval '1 day'
      and not exists (select 1 from public.delivery_ticket_events e where e.ticket_id = t.id and e.action in ('flagged', 'corrected'))
  ), timed as (
    select x.*, row_number() over (partition by x.review_day order by x.delivered_at, x.id) as rn
    from targets x
  ), moved as (
    update public.delivery_tickets t
       set created_at = m.entered,
           reviewed_at = greatest(((m.review_day + time '15:45') at time zone v_tz)
                                  + make_interval(secs => m.rn * 70 + (m.rn % 5) * 9), m.entered + interval '5 minutes')
      from timed m
     where t.id = m.id
    returning t.id, t.created_at, t.reviewed_at
  ), ev as (
    update public.delivery_ticket_events e
       set occurred_at = case e.action when 'submitted' then m.created_at else m.reviewed_at end
      from moved m
     where e.ticket_id = m.id and e.action in ('submitted', 'accepted')
    returning 1
  )
  select count(*) into v_tickets from moved;

  return jsonb_build_object('assignments', v_assignments, 'tickets', v_tickets);
end;
$$;
revoke all on function public.demo_speed_history() from public, anon;
grant execute on function public.demo_speed_history() to authenticated;
