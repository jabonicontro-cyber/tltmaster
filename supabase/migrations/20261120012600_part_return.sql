-- =============================================================================
-- Return a part to stock from a work order (2026-11-09).
--
-- A part used on a job and not fitted goes back on the shelf. Nothing is erased: the use stays in the ledger and a
-- new movement reverses it.
--   part_movements.kind gains 'returned' (a positive quantity), with returned_from = the use it reverses (no more can
--     come back than was used).
--   When the use added a part cost line (part_use adds one at the latest known cost), a credit line with the same unit
--     cost and a negative quantity is added (work_order_costs.returned_movement_id names the return). Only such a
--     credit line may have a negative quantity, and it cannot be removed by hand (the delete policy leaves it out), so
--     stock and cost stay in step. The work order's cost total therefore drops by what came back.
--   part_return(use, quantity, reason)  maintenance.manage, open or completed work orders (not closed or canceled), a
--     reason is required; recorded in the work order's history.
-- Works with the code before and after it (older screens simply do not offer the return).
-- Reversible: supabase/rollbacks/20261120012600_part_return.down.sql
-- =============================================================================

alter table public.part_movements drop constraint part_movements_kind_check;
alter table public.part_movements add constraint part_movements_kind_check check (kind in ('received', 'used', 'adjusted', 'returned'));
alter table public.part_movements add column returned_from bigint references public.part_movements (id);
alter table public.part_movements add constraint part_movements_returned check (
  (kind = 'returned') = (returned_from is not null) and (kind <> 'returned' or quantity > 0));
create index part_movements_returned_idx on public.part_movements (returned_from) where returned_from is not null;
grant select (returned_from) on public.part_movements to authenticated;

alter table public.work_order_costs add column returned_movement_id bigint references public.part_movements (id);
alter table public.work_order_costs drop constraint work_order_costs_quantity_check;
alter table public.work_order_costs add constraint work_order_costs_quantity_check check (
  quantity <> 0 and quantity <= 100000 and quantity >= -100000 and (quantity > 0 or returned_movement_id is not null));
-- A credit line for a returned part cannot be removed by hand: it keeps stock and cost in step.
drop policy work_order_costs_delete on public.work_order_costs;
create policy work_order_costs_delete on public.work_order_costs for delete to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.costs'))
         and returned_movement_id is null);

create or replace function public.part_return(p_use bigint, p_quantity numeric, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_use   public.part_movements%rowtype;
  v       public.parts%rowtype;
  w       public.work_orders%rowtype;
  v_back  numeric;
  v_id    bigint;
  v_reason text := left(trim(coalesce(p_reason, '')), 300);
begin
  perform private.require_permission('maintenance.manage');
  select * into v_use from public.part_movements where id = p_use and company_id = private.require_company();
  if not found or v_use.kind <> 'used' or v_use.work_order_id is null then
    raise exception 'Part use not found.' using errcode = 'P0002';
  end if;
  v := private.part_for_change(v_use.part_id);
  select * into w from public.work_orders where id = v_use.work_order_id for update;
  if w.status in ('closed', 'canceled') then
    raise exception 'This work order is %. Parts can no longer be returned from it.', w.status using errcode = 'P0001';
  end if;
  if length(v_reason) < 2 then
    raise exception 'Say why the part goes back to stock.' using errcode = '22023';
  end if;
  select coalesce(sum(m.quantity), 0) into v_back from public.part_movements m where m.returned_from = v_use.id;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Enter how many go back to stock.' using errcode = '22023';
  end if;
  if p_quantity > -v_use.quantity - v_back then
    raise exception 'Only % % of this use can go back to stock.', trim(to_char(-v_use.quantity - v_back, 'FM999999990.##')), v.unit using errcode = '22023';
  end if;
  insert into public.part_movements (company_id, part_id, kind, quantity, unit_cost_cents, work_order_id, note, created_by, returned_from)
  values (v.company_id, v.id, 'returned', p_quantity, v_use.unit_cost_cents, w.id, v_reason, auth.uid(), v_use.id)
  returning id into v_id;
  update public.parts set on_hand = on_hand + p_quantity, updated_at = now() where id = v.id;
  if v_use.unit_cost_cents is not null then
    insert into public.work_order_costs (company_id, work_order_id, kind, description, part_number, quantity, unit_cost_cents, created_by, returned_movement_id)
    values (v.company_id, w.id, 'part', left('Returned to stock: ' || v.name, 200), v.part_number, -p_quantity, v_use.unit_cost_cents, auth.uid(), v_id);
  end if;
  perform private.wo_event(v.company_id, w.id, 'updated', null, null,
    format('Returned to stock: %s %s %s (%s)', trim(to_char(p_quantity, 'FM999999990.##')), v.unit, v.name, v_reason));
  return jsonb_build_object('on_hand', v.on_hand + p_quantity, 'cost_credited', v_use.unit_cost_cents is not null);
end;
$$;
revoke all on function public.part_return(bigint, numeric, text) from public, anon;
grant execute on function public.part_return(bigint, numeric, text) to authenticated;
