-- =============================================================================
-- Truck-day jobs (UX11, open item): different start times per truck in one step ("2 trucks at 6:00, 3 at 7:30").
--
-- public.truck_day_slots(p_order, p_date, p_starts time[], p_end, p_note): one slot per entry in p_starts, all in one
-- transaction (all slots are added or none). Same rules as public.truck_day_plan (20261120008600): dispatch.edit, the
-- caller's own company, a truck-day order, 1 to 50 trucks; each slot goes through public.save_order_load, so the
-- order's schedule, the times (start before the planned end) and every other check apply unchanged.
-- truck_day_plan stays as it is (one start time for every truck).
--
-- Additive. Rollback: supabase/rollbacks/20261120022100_truck_day_start_times.down.sql.
-- Without it the board still adds trucks with one shared start time and says the different times need an update.
-- =============================================================================

create or replace function public.truck_day_slots(p_order uuid, p_date date, p_starts time[], p_end time, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_order public.orders%rowtype;
  v_ids jsonb := '[]'::jsonb;
  v_r jsonb;
  v_start time;
  v_count integer := coalesce(cardinality(p_starts), 0);
begin
  perform private.require_permission('dispatch.edit');
  select * into v_order from public.orders where id = p_order and company_id = v_company;
  if not found then raise exception 'Order not found.' using errcode = 'P0002'; end if;
  if v_order.job_type <> 'truck_day' then raise exception 'Order % runs as a set number of loads. Set it to trucks for the day first.', v_order.order_number using errcode = '22023'; end if;
  if v_count < 1 or v_count > 50 then raise exception 'Choose 1 to 50 trucks.' using errcode = '22023'; end if;
  if array_position(p_starts, null) is not null then raise exception 'Enter a start time for every truck.' using errcode = '22023'; end if;
  foreach v_start in array p_starts loop
    v_r := public.save_order_load(jsonb_build_object('order_id', p_order, 'load_date', p_date, 'start_time', v_start, 'end_time', p_end,
                                                     'notes', coalesce(p_note, '')));
    v_ids := v_ids || jsonb_build_array(v_r ->> 'load_id');
  end loop;
  return jsonb_build_object('load_ids', v_ids, 'count', v_count);
end;
$$;
revoke all on function public.truck_day_slots(uuid, date, time[], time, text) from public, anon;
grant execute on function public.truck_day_slots(uuid, date, time[], time, text) to authenticated;

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'truck_day_slots'
                   and p.prosecdef and 'search_path=""' = any (p.proconfig)) then
    raise exception 'truck_day_slots is not installed as expected';
  end if;
end;
$$;
