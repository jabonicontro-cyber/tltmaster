-- Rollback of 20261120001800_base_scope_child_records.sql. Not destructive (no data), but a SECURITY change:
-- base-limited people can read other bases' order lines, loads, assignments, tickets, field reports and work orders
-- again, and functions stop refusing their writes there. Run with psql -v ON_ERROR_STOP=1 -1 -f.

drop policy if exists order_lines_base_access on public.order_lines;
drop policy if exists order_loads_base_access on public.order_loads;
drop policy if exists dispatch_assignments_base_access on public.dispatch_assignments;
drop policy if exists delivery_tickets_base_access on public.delivery_tickets;
drop policy if exists field_reports_base_access on public.field_reports;
drop policy if exists work_orders_base_access on public.work_orders;

do $$
declare
  t text;
begin
  foreach t in array array['order_lines', 'order_loads', 'dispatch_assignments', 'delivery_tickets', 'field_reports', 'work_orders'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_base_write_guard', t);
  end loop;
end;
$$;

drop function if exists private.base_write_guard();
