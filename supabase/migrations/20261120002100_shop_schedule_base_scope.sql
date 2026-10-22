-- The dispatch board's shop schedule follows per-person dispatch base access (master plan B62).
--
-- public.dispatch_shop_schedule runs with elevated rights and returned every open work order of the company, so a
-- person limited to one base saw other bases' work orders (number, title, unit) on the board. It now keeps only work
-- orders whose truck and trailer are each at one of the caller's bases or have no base, the rule the RLS applies to
-- work_orders since 20261120001800. Unrestricted people see the same list as before. Function change only.
-- Rollback: supabase/rollbacks/20261120002100_shop_schedule_base_scope.down.sql.

create or replace function public.dispatch_shop_schedule(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_bases   uuid[] := private.my_bases();
begin
  perform private.require_permission('dispatch.view');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'Choose a date range of at most 62 days.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'truck_id', w.truck_id, 'trailer_id', w.trailer_id, 'work_order_id', w.id, 'number', w.number, 'title', w.title, 'status', w.status,
      'scheduled_for', w.scheduled_for, 'safety_critical', w.safety_critical) order by w.scheduled_for nulls first, w.number)
    from public.work_orders w
    left join public.trucks t on t.id = w.truck_id and t.company_id = w.company_id
    left join public.trailers l on l.id = w.trailer_id and l.company_id = w.company_id
    where w.company_id = v_company
      and w.status in ('reported', 'triaged', 'scheduled', 'in_progress', 'awaiting_parts', 'awaiting_inspection')
      and (w.safety_critical or w.status in ('in_progress', 'awaiting_parts') or w.scheduled_for between p_from and p_to)
      and (v_bases is null
           or ((t.base_id is null or t.base_id = any (v_bases)) and (l.base_id is null or l.base_id = any (v_bases))))
  ), '[]'::jsonb);
end;
$$;
