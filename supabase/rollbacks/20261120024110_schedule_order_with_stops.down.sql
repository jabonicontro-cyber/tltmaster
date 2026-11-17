-- Rollback of 20261120024110_schedule_order_with_stops (not a migration; run by hand with psql -v ON_ERROR_STOP=1 -f,
-- after a backup). public.set_order_status gets its earlier body back exactly (20261027000100 with the permission line
-- of 20261120009900): scheduling again needs a job-site address or site name on the order itself; a delivery stop no
-- longer counts. Orders already scheduled stay scheduled. Function only: no rows change.
begin;

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
  if p_status = 'scheduled' and coalesce(nullif(trim(v_order.site_line1), ''), nullif(trim(v_order.site_label), '')) is null then
    raise exception 'Add the delivery location to order % before scheduling it: a job-site address, or a site name such as "Customer pickup at the yard".', v_order.order_number;
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


commit;
