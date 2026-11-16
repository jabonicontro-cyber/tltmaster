-- Rollback of 20261120023100_tickets_without_dispatch.sql (not a migration; run by hand with a backup first).
-- Every ticket again needs its load's assignment, truck and driver. It stops, changing nothing, when a ticket was
-- already entered without dispatch: those are records (never deleted); keep the migration, or void and re-enter them
-- through dispatch first. Run 20261120023200's rollback before this one.
do $$
begin
  if exists (select 1 from public.delivery_tickets where without_dispatch)
     or exists (select 1 from public.order_loads where from_ticket) then
    raise exception 'Tickets were entered without dispatch; this rollback would lose them. Nothing was changed.';
  end if;
end;
$$;

drop trigger if exists z_ticket_load_on_void on public.delivery_tickets;
drop trigger if exists b_ticket_dispatch_check on public.delivery_tickets;
drop trigger if exists b_no_assignment_on_ticket_load on public.dispatch_assignments;
drop trigger if exists b_ticket_load_guard on public.order_loads;
drop function if exists public.create_ticket_job(jsonb);
drop function if exists public.submit_ticket_without_dispatch(jsonb);
drop function if exists private.prepare_ticket_without_dispatch(uuid, jsonb, text, uuid);
drop function if exists private.ticket_load_follow(uuid, timestamptz);
drop function if exists private.ticket_load_on_void();
drop function if exists private.check_ticket_dispatch();
drop function if exists private.refuse_assignment_on_ticket_load();
drop function if exists private.guard_ticket_load();

-- The previous versions of the replaced functions (as before this migration).
create or replace function private.guard_delivery_ticket()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$

;

create or replace function public.correct_delivery_ticket(p_ticket_id uuid, p_payload jsonb, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid;
  v_old     public.delivery_tickets%rowtype;
  v_new     public.delivery_tickets%rowtype;
  v_p       jsonb;
  v_reason  text := private.clean_text(p_reason, 500, 'Reason');
  v_status  public.ticket_status;
begin
  perform private.require_permission('tickets.edit');
  v_company := private.require_company();

  select * into v_old from public.delivery_tickets where id = p_ticket_id and company_id = v_company for update;
  if not found then raise exception 'Ticket not found.'; end if;
  if v_old.status in ('voided', 'superseded') then
    raise exception 'Ticket % revision % is %. Only the current revision of a live ticket can be corrected.',
      v_old.ticket_number, v_old.revision, v_old.status;
  end if;
  if v_old.status = 'accepted' and not private.has_permission('tickets.review') then
    raise exception 'Ticket % was accepted. Only a reviewer can correct it.', v_old.ticket_number using errcode = '42501';
  end if;
  if length(v_reason) = 0 then raise exception 'Enter the reason for the correction.'; end if;
  if nullif(p_payload ->> 'load_id', '')::uuid is distinct from v_old.load_id then
    raise exception 'A correction cannot move the ticket to another load. Void it and enter a new ticket.';
  end if;

  v_p := private.prepare_ticket(v_company, p_payload, v_old.ticket_number, v_old.assignment_id);
  -- A correction is always reviewed again.
  v_status := case when jsonb_array_length(v_p -> 'review_reasons') > 0 then 'needs_review' else 'submitted' end;

  update public.delivery_tickets set status = 'superseded' where id = v_old.id;
  insert into public.delivery_tickets (
    company_id, ticket_number, revision, supersedes_id, status, order_id, load_id, assignment_id, order_line_id,
    material_id, truck_id, trailer_id, driver_id, delivered_at, quantity, unit_code, external_reference, notes,
    review_reasons, snapshot, correction_reason, created_by)
  values (
    v_company, v_old.ticket_number, v_old.revision + 1, v_old.id, v_status,
    v_old.order_id, v_old.load_id, (v_p ->> 'assignment_id')::uuid, (v_p ->> 'order_line_id')::uuid,
    nullif(v_p ->> 'material_id', '')::uuid, (v_p ->> 'truck_id')::uuid, nullif(v_p ->> 'trailer_id', '')::uuid,
    (v_p ->> 'driver_id')::uuid, (v_p ->> 'delivered_at')::timestamptz, (v_p ->> 'quantity')::numeric,
    v_p ->> 'unit_code', v_p ->> 'external_reference', v_p ->> 'notes',
    array(select jsonb_array_elements_text(v_p -> 'review_reasons')), v_p -> 'snapshot', v_reason, auth.uid())
  returning * into v_new;

  insert into public.delivery_ticket_events (company_id, ticket_id, ticket_number, action, from_status, to_status, note, details, actor_id)
  values (v_company, v_new.id, v_new.ticket_number, 'corrected', v_old.status, v_new.status, v_reason,
          jsonb_build_object('previous_revision', v_old.revision, 'revision', v_new.revision,
                             'changes', private.jsonb_changes(to_jsonb(v_old), to_jsonb(v_new),
                               array['quantity', 'unit_code', 'delivered_at', 'external_reference', 'order_line_id',
                                     'truck_id', 'trailer_id', 'driver_id', 'notes'])),
          auth.uid());
  perform private.log_event('ticket.corrected', 'order', v_new.order_id,
    format('Ticket %s corrected (revision %s): %s', v_new.ticket_number, v_new.revision, v_reason),
    jsonb_build_object('ticket_id', v_new.id, 'ticket_number', v_new.ticket_number, 'revision', v_new.revision));

  return jsonb_build_object('ticket_id', v_new.id, 'ticket_number', v_new.ticket_number, 'revision', v_new.revision, 'status', v_new.status);
end;
$function$

;

create or replace function public.report_profit(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid := private.require_company();
  v_tz text;
  r public.company_cost_rates%rowtype;
  v_has_rates boolean;
  v_out jsonb;
begin
  perform private.require_permission('billing.view');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'Choose a period of up to one year.' using errcode = '22023';
  end if;
  v_tz := private.business_timezone(v_company);
  select * into r from public.company_cost_rates where company_id = v_company;
  v_has_rates := found and (r.truck_hour_cents is not null or r.driver_hour_cents is not null or r.per_load_cents is not null);

  with tickets as (
    select t.assignment_id, t.order_id, t.truck_id,
           case when t.unit_code = l.unit_code and l.calc_method = 'per_unit' and l.unit_rate_cents > 0
                then round(t.quantity * l.unit_rate_cents)::bigint end as value_cents
      from public.delivery_tickets t
      left join public.order_lines l on l.id = t.order_line_id and l.company_id = v_company
     where t.company_id = v_company and t.status = 'accepted'
       and (t.delivered_at at time zone v_tz)::date between p_from and p_to
  ), loads as (
    select tk.assignment_id, min(tk.order_id::text)::uuid as order_id, min(tk.truck_id::text)::uuid as truck_id,
           sum(tk.value_cents) as revenue_cents, bool_or(tk.value_cents is null) as has_unpriced,
           round(extract(epoch from (a.ends_at - a.starts_at)) / 3600.0, 2) as hours
      from tickets tk
      left join public.dispatch_assignments a on a.id = tk.assignment_id and a.company_id = v_company
     group by tk.assignment_id, a.starts_at, a.ends_at
  ), costed as (
    select l.*, o.customer_id,
           case when v_has_rates and l.hours is not null and l.hours > 0
                then round(l.hours * (coalesce(r.truck_hour_cents, 0) + coalesce(r.driver_hour_cents, 0)) + coalesce(r.per_load_cents, 0))::bigint end as cost_cents
      from loads l
      left join public.orders o on o.id = l.order_id and o.company_id = v_company
  ), complete as (
    select * from costed where revenue_cents is not null and cost_cents is not null
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'has_rates', v_has_rates,
    'rates', case when v_has_rates then jsonb_build_object('truck_hour_cents', r.truck_hour_cents, 'driver_hour_cents', r.driver_hour_cents, 'per_load_cents', r.per_load_cents) end,
    'loads', (select count(*) from costed),
    'loads_costed', (select count(*) from complete),
    'loads_without_price', (select count(*) from costed where revenue_cents is null),
    'loads_with_unpriced_tickets', (select count(*) from costed where has_unpriced and revenue_cents is not null),
    'loads_without_hours', (select count(*) from costed where hours is null or hours <= 0),
    'revenue_cents', (select coalesce(sum(revenue_cents), 0) from complete),
    'cost_cents', (select coalesce(sum(cost_cents), 0) from complete),
    'hours', (select coalesce(sum(hours), 0) from complete),
    'by_customer', coalesce((select jsonb_agg(x order by x.profit_cents desc) from (
        select coalesce(c.name, 'Unknown customer') as name, count(*) as loads, sum(k.revenue_cents) as revenue_cents, sum(k.cost_cents) as cost_cents,
               sum(k.revenue_cents) - sum(k.cost_cents) as profit_cents
          from complete k left join public.customers c on c.id = k.customer_id and c.company_id = v_company
         group by c.name order by sum(k.revenue_cents) - sum(k.cost_cents) desc limit 15) x), '[]'),
    'by_truck', coalesce((select jsonb_agg(x order by x.profit_cents desc) from (
        select coalesce(tr.unit_number, 'No truck') as name, count(*) as loads, sum(k.revenue_cents) as revenue_cents, sum(k.cost_cents) as cost_cents,
               sum(k.revenue_cents) - sum(k.cost_cents) as profit_cents, sum(k.hours) as hours
          from complete k left join public.trucks tr on tr.id = k.truck_id and tr.company_id = v_company
         group by tr.unit_number order by sum(k.revenue_cents) - sum(k.cost_cents) desc limit 15) x), '[]'))
  into v_out;
  return v_out;
end;
$function$

;


alter table public.delivery_tickets drop constraint if exists delivery_tickets_without_dispatch_unassigned;
alter table public.delivery_tickets drop constraint if exists delivery_tickets_dispatch_refs;
alter table public.ticket_attachments alter column assignment_id set not null;
alter table public.delivery_tickets alter column assignment_id set not null;
alter table public.delivery_tickets alter column truck_id set not null;
alter table public.delivery_tickets alter column driver_id set not null;
alter table public.delivery_tickets drop column if exists without_dispatch;
alter table public.order_loads drop column if exists from_ticket;
