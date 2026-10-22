-- Command Center items follow per-person dispatch base access (master plan B62).
--
-- 20261120000200 limits a person to some dispatch bases through restrictive RLS on trucks, trailers, drivers and
-- orders. The Command Center reads private.operational_exceptions, which runs with elevated rights and so bypassed
-- that RLS: a person limited to one base saw the other bases' items in the queue (order numbers, customer names,
-- truck units), not only in the counts as that migration's note said. Its five callers (command_center_exceptions,
-- command_center_summary, command_center_urgent_by_kind, assign_exception, hide_exception) all read it, so the scope
-- is applied here once: the existing body is renamed operational_exceptions_all and operational_exceptions keeps only
-- the items the caller may see, with the same rule as the RLS:
--   * unrestricted callers (owners, people with no base list, and calls without a signed-in person) see every item;
--   * otherwise an item is shown when its order and its truck or trailer are each at one of the caller's bases or
--     have no base (records without a base stay visible).
-- No table, data or policy changes. Rollback: supabase/rollbacks/20261120001700_command_center_base_scope.down.sql.

alter function private.operational_exceptions(uuid) rename to operational_exceptions_all;

create function private.operational_exceptions(p_company uuid)
returns table (
  exception_key text, kind text, priority integer, since timestamptz,
  order_id uuid, order_number text, customer_name text,
  load_id uuid, load_number integer, load_date date,
  ticket_id uuid, ticket_number text,
  equipment_kind text, equipment_id uuid, unit_number text,
  assignment_id uuid, reasons text[], details jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_bases uuid[] := private.my_bases();
begin
  if v_bases is null then
    return query select * from private.operational_exceptions_all(p_company);
    return;
  end if;
  return query
  select e.*
  from private.operational_exceptions_all(p_company) e
  left join public.orders o on o.id = e.order_id and o.company_id = p_company
  left join public.trucks tr on e.equipment_kind = 'truck' and tr.id = e.equipment_id and tr.company_id = p_company
  left join public.trailers tl on e.equipment_kind = 'trailer' and tl.id = e.equipment_id and tl.company_id = p_company
  where (o.base_id is null or o.base_id = any (v_bases))
    and (tr.base_id is null or tr.base_id = any (v_bases))
    and (tl.base_id is null or tl.base_id = any (v_bases));
end;
$$;

revoke all on function private.operational_exceptions(uuid) from public, anon, authenticated;
revoke all on function private.operational_exceptions_all(uuid) from public, anon, authenticated;
