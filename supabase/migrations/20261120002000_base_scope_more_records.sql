-- Per-person dispatch base access, completed (master plan B62; follows 20261120001800).
--
-- 1. Writes to the base records themselves: orders, trucks, trailers and drivers are changed by functions that run
--    with elevated rights (order status, schedule and urgency, truck service status, readings, primary trucks). The
--    write guard now also refuses a base-limited person's change to one of these rows when the row's own base is
--    outside their list (old and new row).
-- 2. New records of a base-limited person default to one of their bases instead of the company's default base, which
--    they may not have: before, a truck or order they created landed at the default base and disappeared from their
--    own lists at once (RLS hid it). Unrestricted people are unchanged (company default base).
-- 3. The other records attached to orders, loads, trucks, trailers or drivers get the same read rule and write guard
--    as 20261120001800: order status and urgency history, billing reviews and handoff lines, ticket attachments,
--    dispatch recommendation rejections, driver qualifications, vehicle documents, truck readings, maintenance
--    schedules, equipment status and truck assignment history. Not included, on purpose: employees (people records,
--    not base records), payroll (owner only) and the customer portal tables (scoped to the customer).
-- 4. The write guard runs once per statement instead of once per row (AFTER ... FOR EACH STATEMENT with transition
--    tables): unrestricted people pay one check per statement, so bulk work such as removing sample data is not
--    slowed down (the row-level guard of 20261120001800 doubled it). It replaces that row-level guard.
-- Tables missing on a database are skipped. No data changes.
-- Rollback: supabase/rollbacks/20261120002000_base_scope_more_records.down.sql.

-- True when one changed row of `p_table` is at, or points to, a base outside `p_bases`.
create or replace function private.row_outside_bases(p_row jsonb, p_table text, p_bases uuid[])
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base  uuid;
  v_check record;
begin
  if p_table in ('orders', 'trucks', 'trailers', 'drivers') and p_row ->> 'base_id' is not null
     and not ((p_row ->> 'base_id')::uuid = any (p_bases)) then
    return true;
  end if;
  for v_check in
    select * from (values ('order_id', 'orders'), ('truck_id', 'trucks'), ('trailer_id', 'trailers'), ('driver_id', 'drivers'), ('load_id', 'order_loads')) c(col, tbl)
  loop
    continue when not (p_row ? v_check.col) or p_row ->> v_check.col is null;
    if v_check.tbl = 'order_loads' then
      select o.base_id into v_base from public.order_loads l join public.orders o on o.id = l.order_id where l.id = (p_row ->> 'load_id')::uuid;
    else
      execute format('select base_id from public.%I where id = $1', v_check.tbl) into v_base using (p_row ->> v_check.col)::uuid;
    end if;
    if v_base is not null and not (v_base = any (p_bases)) then
      return true;
    end if;
  end loop;
  return false;
end;
$$;
revoke all on function private.row_outside_bases(jsonb, text, uuid[]) from public, anon, authenticated;

-- Statement-level guard. Transition tables are named old_rows / new_rows by every trigger that uses it.
create or replace function private.base_write_guard_stmt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bases uuid[] := private.my_bases();
  v_bad   boolean := false;
begin
  if v_bases is null then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select exists (select 1 from old_rows r where private.row_outside_bases(to_jsonb(r), tg_table_name, v_bases)) into v_bad;
  end if;
  if not v_bad and tg_op in ('INSERT', 'UPDATE') then
    select exists (select 1 from new_rows r where private.row_outside_bases(to_jsonb(r), tg_table_name, v_bases)) into v_bad;
  end if;
  if v_bad then
    raise exception 'You can only work with records at your dispatch bases.' using errcode = '42501';
  end if;
  return null;
end;
$$;
revoke all on function private.base_write_guard_stmt() from public, anon, authenticated;

create or replace function private.default_base()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bases uuid[];
begin
  if new.base_id is null then
    -- A base-limited person's records start at one of their bases (the company default if it is one of them).
    if tg_table_name <> 'companies' then
      v_bases := private.my_bases();
    end if;
    if v_bases is not null and cardinality(v_bases) > 0 then
      select b.id into new.base_id from public.dispatch_bases b
      where b.company_id = new.company_id and b.id = any (v_bases) and b.active
      order by b.is_default desc, b.code limit 1;
    end if;
    if new.base_id is null then
      select b.id into new.base_id from public.dispatch_bases b where b.company_id = new.company_id and b.is_default;
    end if;
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
  v_parts text[];
  v_guarded text[] := array['order_lines', 'order_loads', 'dispatch_assignments', 'delivery_tickets', 'field_reports', 'work_orders',
                            'orders', 'trucks', 'trailers', 'drivers'];
  v_more text[] := array['order_status_events', 'order_urgencies', 'order_urgency_events', 'billing_reviews', 'billing_handoff_orders',
                         'ticket_attachments', 'dispatch_recommendation_rejections', 'driver_qualifications', 'vehicle_documents',
                         'truck_readings', 'maintenance_schedules', 'equipment_status_events', 'truck_assignment_events'];
begin
  -- Read rule on the other attached records (the six of 20261120001800 already have theirs).
  foreach t in array v_more loop
    continue when to_regclass('public.' || t) is null;
    v_parts := array[]::text[];
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'order_id') then
      v_parts := array_append(v_parts, '(order_id is null or exists (select 1 from public.orders o where o.id = order_id))');
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'load_id') then
      v_parts := array_append(v_parts, '(load_id is null or exists (select 1 from public.order_loads l where l.id = load_id))');
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'truck_id') then
      v_parts := array_append(v_parts, '(truck_id is null or exists (select 1 from public.trucks x where x.id = truck_id))');
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'trailer_id') then
      v_parts := array_append(v_parts, '(trailer_id is null or exists (select 1 from public.trailers x where x.id = trailer_id))');
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'driver_id') then
      v_parts := array_append(v_parts, '(driver_id is null or exists (select 1 from public.drivers x where x.id = driver_id))');
    end if;
    continue when cardinality(v_parts) = 0;
    execute format('drop policy if exists %I on public.%I', t || '_base_access', t);
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s)', t || '_base_access', t,
                   '(select private.base_unrestricted()) or (' || array_to_string(v_parts, ' and ') || ')');
    v_guarded := array_append(v_guarded, t);
  end loop;

  -- Statement-level write guard on every guarded table (replaces the row-level guard of 20261120001800).
  foreach t in array v_guarded loop
    continue when to_regclass('public.' || t) is null;
    execute format('drop trigger if exists %I on public.%I', t || '_base_write_guard', t);
    execute format('drop trigger if exists %I on public.%I', t || '_base_guard_ins', t);
    execute format('drop trigger if exists %I on public.%I', t || '_base_guard_upd', t);
    execute format('drop trigger if exists %I on public.%I', t || '_base_guard_del', t);
    execute format('create trigger %I after insert on public.%I referencing new table as new_rows for each statement execute function private.base_write_guard_stmt()', t || '_base_guard_ins', t);
    execute format('create trigger %I after update on public.%I referencing old table as old_rows new table as new_rows for each statement execute function private.base_write_guard_stmt()', t || '_base_guard_upd', t);
    execute format('create trigger %I after delete on public.%I referencing old table as old_rows for each statement execute function private.base_write_guard_stmt()', t || '_base_guard_del', t);
  end loop;
end;
$$;

drop function if exists private.base_write_guard();
