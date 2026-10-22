-- Rollback of 20261120002100_shop_schedule_base_scope.sql. Not destructive (function only), but a SECURITY change:
-- base-limited people see every base's work orders in the dispatch board's shop schedule again.
-- Run with psql -v ON_ERROR_STOP=1 -1 -f.

CREATE OR REPLACE FUNCTION public.dispatch_shop_schedule(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid := private.require_company();
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
    where w.company_id = v_company
      and w.status in ('reported', 'triaged', 'scheduled', 'in_progress', 'awaiting_parts', 'awaiting_inspection')
      and (w.safety_critical or w.status in ('in_progress', 'awaiting_parts') or w.scheduled_for between p_from and p_to)
  ), '[]'::jsonb);
end;
$function$;
