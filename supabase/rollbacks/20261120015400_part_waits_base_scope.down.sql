-- Rollback of 20261120015400_part_waits_base_scope: parts on order no longer look at dispatch bases. Restores
-- private.wo_for_crew (20261120002900) and public.part_waits (20261120012300) exactly, removes the read rule and
-- private.wo_base_check.

create or replace function private.wo_for_crew(p_wo uuid)
returns public.work_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wo public.work_orders%rowtype;
begin
  perform private.require_permission('maintenance.manage');
  select * into v_wo from public.work_orders where id = p_wo and company_id = private.require_company() for update;
  if not found then
    raise exception 'Work order not found.' using errcode = 'P0002';
  end if;
  if v_wo.status in ('closed', 'canceled') then
    raise exception 'This work order is % and can no longer be changed.', v_wo.status using errcode = 'P0001';
  end if;
  return v_wo;
end;
$$;

create or replace function public.part_waits(p_work_order uuid default null)
returns table (id uuid, work_order_id uuid, work_order_number text, part_id uuid, description text, part_number text,
  quantity numeric, vendor_name text, po_number text, expected_on date, unit_cost_cents bigint, status text,
  received_at timestamptz, received_by uuid, cancel_reason text, created_by uuid, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_costs boolean := private.has_permission('maintenance.costs');
begin
  perform private.require_permission('maintenance.view');
  return query
    select w.id, w.work_order_id, o.number, w.part_id, w.description, w.part_number, w.quantity, w.vendor_name, w.po_number,
      w.expected_on, case when v_costs then w.unit_cost_cents end, w.status, w.received_at, w.received_by, w.cancel_reason,
      w.created_by, w.created_at
    from public.work_order_part_waits w
    join public.work_orders o on o.id = w.work_order_id
    where w.company_id = v_company
      and (case when p_work_order is null
                then w.status = 'waiting' and o.status not in ('completed', 'closed', 'canceled')
                else w.work_order_id = p_work_order end)
    order by w.status = 'waiting' desc, w.expected_on nulls last, w.created_at;
end;
$$;

drop policy if exists work_order_part_waits_base_access on public.work_order_part_waits;
drop function if exists private.wo_base_check(public.work_orders);
