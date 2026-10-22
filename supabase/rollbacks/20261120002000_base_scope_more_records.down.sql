-- Rollback of 20261120002000_base_scope_more_records.sql. Not destructive (no data), but a SECURITY change: base-limited
-- people can again read the attached records listed there for other bases, and functions stop refusing their changes
-- to orders, trucks, trailers and drivers at other bases; their new records start at the company default base again.
-- Restores the row-level write guard of 20261120001800 (six tables) and the default-base rule of 20261120000100.
-- Run with psql -v ON_ERROR_STOP=1 -1 -f.

do $$
declare
  t text;
begin
  foreach t in array array['order_lines', 'order_loads', 'dispatch_assignments', 'delivery_tickets', 'field_reports', 'work_orders',
                           'orders', 'trucks', 'trailers', 'drivers',
                           'order_status_events', 'order_urgencies', 'order_urgency_events', 'billing_reviews', 'billing_handoff_orders',
                           'ticket_attachments', 'dispatch_recommendation_rejections', 'driver_qualifications', 'vehicle_documents',
                           'truck_readings', 'maintenance_schedules', 'equipment_status_events', 'truck_assignment_events'] loop
    continue when to_regclass('public.' || t) is null;
    execute format('drop trigger if exists %I on public.%I', t || '_base_guard_ins', t);
    execute format('drop trigger if exists %I on public.%I', t || '_base_guard_upd', t);
    execute format('drop trigger if exists %I on public.%I', t || '_base_guard_del', t);
  end loop;
  foreach t in array array['order_status_events', 'order_urgencies', 'order_urgency_events', 'billing_reviews', 'billing_handoff_orders',
                           'ticket_attachments', 'dispatch_recommendation_rejections', 'driver_qualifications', 'vehicle_documents',
                           'truck_readings', 'maintenance_schedules', 'equipment_status_events', 'truck_assignment_events'] loop
    continue when to_regclass('public.' || t) is null;
    execute format('drop policy if exists %I on public.%I', t || '_base_access', t);
  end loop;
end;
$$;

drop function if exists private.base_write_guard_stmt();
drop function if exists private.row_outside_bases(jsonb, text, uuid[]);

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

create or replace function private.default_base()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.base_id is null then
    select b.id into new.base_id from public.dispatch_bases b where b.company_id = new.company_id and b.is_default;
  end if;
  return new;
end;
$$;
