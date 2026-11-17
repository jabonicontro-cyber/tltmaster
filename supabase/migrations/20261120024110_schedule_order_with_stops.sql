-- =============================================================================
-- An order with delivery stops can be scheduled (first-day office walkthrough 2026-11-14, finding D9: blocker for
-- freight).
--
-- public.set_order_status refused "Mark scheduled" for an order with no job-site address or site name, even when the
-- order lists its stops (20261120007800) with a delivery stop: a freight order entered the normal way could not be
-- scheduled until the address was typed a second time on the order.
--
-- Now a current (not removed) delivery stop counts as the delivery location, as the job-site address and the site name
-- already did. An order with neither a site nor a delivery stop is still refused, with the same message plus the stop
-- option. Everything else in the function is its installed definition (20261027000100, permission line from
-- 20261120009900), unchanged: the same transitions, permissions, reasons, edit check, history and audit.
-- Function only: no tables, no rows.
-- Reversible: supabase/rollbacks/20261120024110_schedule_order_with_stops.down.sql
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_order_status(p_order_id uuid, p_status order_status, p_note text DEFAULT ''::text, p_expected_edit_seq integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_order   public.orders%rowtype;
  v_company uuid;
  v_note    text := private.clean_text(p_note, 1000, 'Note');
  v_from    public.order_status;
begin
  v_company := private.require_company();

  select * into v_order from public.orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  v_from := v_order.status;
  if p_status is null or p_status = v_order.status then
    raise exception 'Order % is already %.', v_order.order_number, replace(v_order.status::text, '_', ' ');
  end if;
  if not private.order_transition_allowed(v_order.status, p_status) then
    raise exception 'Order % cannot move from % to %.', v_order.order_number,
      replace(v_order.status::text, '_', ' '), replace(p_status::text, '_', ' ');
  end if;
  perform private.require_order_transition(v_order.id, v_order.status, p_status);
  if p_expected_edit_seq is not null and p_expected_edit_seq <> v_order.edit_seq then
    raise exception 'This order was changed by someone else. Reload to see the latest version.'
      using errcode = 'PT409';
  end if;

  if p_status in ('on_hold', 'canceled') and length(v_note) = 0 then
    raise exception 'Enter a reason for putting the order %.',
      case when p_status = 'canceled' then 'as canceled' else 'on hold' end;
  end if;
  if p_status in ('scheduled', 'dispatched', 'in_progress') and v_order.scheduled_start is null then
    raise exception 'Set a scheduled date before marking the order %.', replace(p_status::text, '_', ' ');
  end if;
  -- The delivery location: a job-site address, a site name, or a current delivery stop (D9).
  if p_status = 'scheduled' and coalesce(nullif(trim(v_order.site_line1), ''), nullif(trim(v_order.site_label), '')) is null
     and not exists (select 1 from public.order_stops s
                      where s.order_id = v_order.id and s.company_id = v_company and s.kind = 'delivery' and s.removed_at is null) then
    raise exception 'Add the delivery location to order % before scheduling it: a job-site address, a site name such as "Customer pickup at the yard", or a delivery stop.', v_order.order_number;
  end if;
  if p_status = 'confirmed' and not exists (select 1 from public.order_lines where order_id = v_order.id) then
    raise exception 'Add at least one line before confirming the order.';
  end if;

  update public.orders set
    status           = p_status,
    status_note      = v_note,
    bill_to_snapshot = case when v_order.status = 'draft' and v_order.source_quote_id is null
                            then private.customer_bill_to(v_order.customer_id) else bill_to_snapshot end,
    confirmed_at     = case when p_status = 'confirmed' then coalesce(confirmed_at, now()) else confirmed_at end,
    completed_at     = case when p_status = 'completed' then now() else completed_at end,
    canceled_at      = case when p_status = 'canceled' then now() else canceled_at end,
    edit_seq         = edit_seq + 1,
    updated_by       = auth.uid()
  where id = v_order.id
  returning * into v_order;

  insert into public.order_status_events (company_id, order_id, from_status, to_status, note, actor_id)
  values (v_company, v_order.id, v_from, p_status, v_note, auth.uid());

  perform private.log_event('order.status_changed', 'order', v_order.id,
    format('%s: %s → %s%s', v_order.order_number, replace(v_from::text, '_', ' '),
           replace(p_status::text, '_', ' '), case when length(v_note) > 0 then ' (' || v_note || ')' else '' end),
    jsonb_build_object('from', v_from, 'to', p_status, 'note', v_note, 'edit_seq', v_order.edit_seq));

  return jsonb_build_object('order_id', v_order.id, 'status', v_order.status, 'edit_seq', v_order.edit_seq);
end;
$function$;

