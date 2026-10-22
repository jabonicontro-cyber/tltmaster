-- Per-person dispatch base access covers the records that hang off orders and equipment (master plan B62).
--
-- 20261120000200 limits a person to some dispatch bases with restrictive RLS on trucks, trailers, drivers and orders.
-- The records attached to them had no base rule, so a person limited to one base could still read another base's
-- order lines, loads, assignments, delivery tickets, field reports and work orders by querying them directly, and the
-- functions that write them (they run with elevated rights) did not check bases either.
--
-- 1. Reads: a restrictive policy on each of those tables. A row is visible when its order, truck and trailer are each
--    visible to the person (the check queries those tables as the person, so their base policies decide); rows
--    without an order or equipment stay visible, as records without a base do. Unrestricted people (owners, anyone
--    with no base list) skip the check entirely.
-- 2. Writes: a trigger on the same tables refuses, for a base-limited person only, any insert, update or delete of a
--    row whose order, truck, trailer or driver is at a base outside their list (old and new row on update). It does
--    not change cross-base dispatch for unrestricted dispatchers (company setting; the dispatcher decides).
-- No data changes. Rollback: supabase/rollbacks/20261120001800_base_scope_child_records.down.sql.

create or replace function private.base_write_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bases uuid[] := private.my_bases();
  v_row   jsonb;
  v_base  uuid;
  v_check record;
begin
  if v_bases is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  for v_row in
    select to_jsonb(r) from (select old as r where tg_op in ('UPDATE', 'DELETE') union all select new where tg_op in ('INSERT', 'UPDATE')) x(r)
  loop
    for v_check in
      select * from (values ('order_id', 'orders'), ('truck_id', 'trucks'), ('trailer_id', 'trailers'), ('driver_id', 'drivers')) c(col, tbl)
    loop
      continue when not (v_row ? v_check.col) or v_row ->> v_check.col is null;
      execute format('select base_id from public.%I where id = $1', v_check.tbl) into v_base using (v_row ->> v_check.col)::uuid;
      if v_base is not null and not (v_base = any (v_bases)) then
        raise exception 'You can only work with records at your dispatch bases.' using errcode = '42501';
      end if;
    end loop;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function private.base_write_guard() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['order_lines', 'order_loads', 'dispatch_assignments', 'delivery_tickets', 'field_reports', 'work_orders'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_base_write_guard', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function private.base_write_guard()',
                   t || '_base_write_guard', t);
  end loop;
end;
$$;

-- Read policies. Each subquery reads the parent as the person, so the parent's own base policy applies.
create policy order_lines_base_access on public.order_lines as restrictive for all to authenticated
  using ((select private.base_unrestricted()) or exists (select 1 from public.orders o where o.id = order_id));

create policy order_loads_base_access on public.order_loads as restrictive for all to authenticated
  using ((select private.base_unrestricted()) or exists (select 1 from public.orders o where o.id = order_id));

create policy dispatch_assignments_base_access on public.dispatch_assignments as restrictive for all to authenticated
  using ((select private.base_unrestricted()) or exists (select 1 from public.orders o where o.id = order_id));

create policy delivery_tickets_base_access on public.delivery_tickets as restrictive for all to authenticated
  using ((select private.base_unrestricted()) or exists (select 1 from public.orders o where o.id = order_id));

create policy field_reports_base_access on public.field_reports as restrictive for all to authenticated
  using ((select private.base_unrestricted())
         or ((order_id is null or exists (select 1 from public.orders o where o.id = order_id))
             and (truck_id is null or exists (select 1 from public.trucks t where t.id = truck_id))
             and (trailer_id is null or exists (select 1 from public.trailers l where l.id = trailer_id))));

create policy work_orders_base_access on public.work_orders as restrictive for all to authenticated
  using ((select private.base_unrestricted())
         or ((truck_id is null or exists (select 1 from public.trucks t where t.id = truck_id))
             and (trailer_id is null or exists (select 1 from public.trailers l where l.id = trailer_id))));
