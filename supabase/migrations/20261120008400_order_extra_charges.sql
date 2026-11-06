-- Extra charges after the work (MK2 accessorials, owner 2026-11-05: lumper, truck ordered not used, layover, and any
-- charge billed per occurrence): billing adds one to a scheduled or completed order before the billing handoff. Only
-- charges marked "not billed from delivery tickets" (charge_items.ticket_required = false, 20261120008200) qualify, so
-- delivered quantities still come only from tickets. The line goes out with the order's invoice; audited.
-- Rollback: supabase/rollbacks/20261120008400_order_extra_charges.down.sql

create or replace function public.order_add_charge(p_order uuid, p_charge_item uuid, p_quantity numeric, p_unit_rate_cents bigint, p_note text default '')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_order   public.orders%rowtype;
  v_item    public.charge_items%rowtype;
  v_note    text := btrim(coalesce(p_note, ''));
  v_line    uuid;
  v_no      integer;
  v_amount  bigint;
begin
  perform private.require_permission('billing.manage');
  v_company := private.require_company();
  select * into v_order from public.orders where id = p_order and company_id = v_company for update;
  if not found then raise exception 'Order not found.' using errcode = 'P0002'; end if;
  if v_order.status in ('draft', 'canceled') then raise exception 'Extra charges are added to scheduled or completed orders only.' using errcode = '22023'; end if;
  if exists (select 1 from public.billing_order_status s where s.order_id = v_order.id and s.company_id = v_company and s.readiness = 'handed_off') then
    raise exception 'This order was already handed off for billing. Undo the handoff first.' using errcode = '22023';
  end if;
  select * into v_item from public.charge_items where id = p_charge_item and company_id = v_company;
  if not found or not v_item.active then raise exception 'Choose an active charge.' using errcode = '22023'; end if;
  if v_item.calc_method <> 'per_unit' or v_item.ticket_required or v_item.kind = 'discount' then
    raise exception 'Only charges billed per occurrence (not from delivery tickets) can be added here.' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 10000 then raise exception 'Enter a quantity above 0.' using errcode = '22023'; end if;
  if p_unit_rate_cents is null or p_unit_rate_cents <= 0 or p_unit_rate_cents > 100000000 then raise exception 'Enter a rate above 0.' using errcode = '22023'; end if;
  if length(v_note) > 200 then raise exception 'Keep the note under 200 characters.' using errcode = '22023'; end if;
  v_amount := round(round(p_quantity, 3) * p_unit_rate_cents)::bigint;

  perform set_config('tlt.billed_extra', 'on', true);
  select coalesce(max(line_no), 0) + 1 into v_no from public.order_lines where order_id = v_order.id;
  insert into public.order_lines (company_id, order_id, line_no, kind, calc_method, charge_item_id, description, unit_code,
                                  unit_label, quantity, unit_rate_cents, price_source, taxable, amount_cents)
  values (v_company, v_order.id, v_no, v_item.kind, 'per_unit', v_item.id,
          left(v_item.name || case when v_note <> '' then ': ' || v_note else '' end, 300),
          v_item.default_unit_code, '', round(p_quantity, 3), p_unit_rate_cents, 'manual', v_item.taxable_default, v_amount)
  returning id into v_line;
  perform private.recompute_order_totals(v_order.id);
  update public.orders set edit_seq = edit_seq + 1 where id = v_order.id;
  perform set_config('tlt.billed_extra', 'off', true);

  perform private.log_event('billing.charge_added', 'order', v_order.id,
    format('Charge added: %s, %s x %s', v_item.name, round(p_quantity, 3), to_char(p_unit_rate_cents / 100.0, 'FM999999990.00')),
    jsonb_build_object('order_line_id', v_line, 'charge_item_id', v_item.id, 'amount_cents', v_amount));
  return v_line;
end;
$$;

revoke all on function public.order_add_charge(uuid, uuid, numeric, bigint, text) from public, anon;
grant execute on function public.order_add_charge(uuid, uuid, numeric, bigint, text) to authenticated;
