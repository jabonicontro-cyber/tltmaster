-- Rollback of 20261120012600_part_return: removes part_return and the return columns. Returns already recorded stay
-- counted in on hand; their ledger rows become 'adjusted' movements (a positive count change with the reason) and
-- their credit lines lose the link (the negative amounts stay, so totals do not change). The quantity check on cost
-- lines then allows a negative amount only on those existing credit lines (NOT VALID keeps them).
drop function if exists public.part_return(bigint, numeric, text);
drop policy work_order_costs_delete on public.work_order_costs;
create policy work_order_costs_delete on public.work_order_costs for delete to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.costs')));
alter table public.work_order_costs drop constraint work_order_costs_quantity_check;
alter table public.work_order_costs drop column returned_movement_id;
alter table public.work_order_costs add constraint work_order_costs_quantity_check
  check (quantity > 0 and quantity <= 100000) not valid;
alter table public.part_movements drop constraint part_movements_returned;
update public.part_movements set kind = 'adjusted' where kind = 'returned';
alter table public.part_movements drop column returned_from;
alter table public.part_movements drop constraint part_movements_kind_check;
alter table public.part_movements add constraint part_movements_kind_check check (kind in ('received', 'used', 'adjusted'));
