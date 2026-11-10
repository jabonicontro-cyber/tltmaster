-- =============================================================================
-- Parts on order follow the per-person dispatch-base limits (owner decision 2026-11-09, master plan SEC3).
--
-- Work orders already do (20261120001800 / 20261120002000): a person limited to some dispatch bases reads only work
-- orders whose truck and trailer are each at one of their bases or have no base, and the write guard refuses changes
-- to other bases' work orders. Parts on order (20261120012300) did not: their functions run with elevated rights and
-- did not look at bases, and their table had no base rule. Now, with the same rule as work orders:
--   * work_order_part_waits: a restrictive read rule, a row is visible only when its work order is visible to the
--     person (the work orders' own base rule applies inside it).
--   * private.wo_base_check(work order): refuses (42501, the base guard's words) a base-limited person's work order
--     outside their bases. private.wo_for_crew calls it, so part_wait_add, part_wait_update, part_wait_receive and
--     part_wait_cancel refuse another base's job, and so do the other functions that go through it (crew, time,
--     tasks, photos), which wrote records attached to a work order without the check.
--   * public.part_waits: lists only parts whose work order's truck and trailer are at the caller's bases (or have no
--     base), like public.dispatch_shop_schedule (20261120002100).
-- Unrestricted people (owners, everyone at a company with one base) see and do exactly what they did before.
-- Bodies otherwise identical to 20261120002900 (wo_for_crew) and 20261120012300 (part_waits).
-- Reversible: supabase/rollbacks/20261120015400_part_waits_base_scope.down.sql
-- =============================================================================

create or replace function private.wo_base_check(p_wo public.work_orders)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_bases uuid[] := private.my_bases();
begin
  if v_bases is null then
    return;
  end if;
  if exists (select 1 from public.trucks t where t.id = p_wo.truck_id and t.base_id is not null and not (t.base_id = any (v_bases)))
     or exists (select 1 from public.trailers l where l.id = p_wo.trailer_id and l.base_id is not null and not (l.base_id = any (v_bases))) then
    raise exception 'You can only work with records at your dispatch bases.' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.wo_base_check(public.work_orders) from public, anon, authenticated;

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
  perform private.wo_base_check(v_wo);
  if v_wo.status in ('closed', 'canceled') then
    raise exception 'This work order is % and can no longer be changed.', v_wo.status using errcode = 'P0001';
  end if;
  return v_wo;
end;
$$;

create policy work_order_part_waits_base_access on public.work_order_part_waits as restrictive for all to authenticated
  using ((select private.base_unrestricted()) or exists (select 1 from public.work_orders w where w.id = work_order_id));

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
  v_bases uuid[] := private.my_bases();
begin
  perform private.require_permission('maintenance.view');
  return query
    select w.id, w.work_order_id, o.number, w.part_id, w.description, w.part_number, w.quantity, w.vendor_name, w.po_number,
      w.expected_on, case when v_costs then w.unit_cost_cents end, w.status, w.received_at, w.received_by, w.cancel_reason,
      w.created_by, w.created_at
    from public.work_order_part_waits w
    join public.work_orders o on o.id = w.work_order_id
    left join public.trucks t on t.id = o.truck_id and t.company_id = o.company_id
    left join public.trailers l on l.id = o.trailer_id and l.company_id = o.company_id
    where w.company_id = v_company
      and (case when p_work_order is null
                then w.status = 'waiting' and o.status not in ('completed', 'closed', 'canceled')
                else w.work_order_id = p_work_order end)
      and (v_bases is null
           or ((t.base_id is null or t.base_id = any (v_bases)) and (l.base_id is null or l.base_id = any (v_bases))))
    order by w.status = 'waiting' desc, w.expected_on nulls last, w.created_at;
end;
$$;
