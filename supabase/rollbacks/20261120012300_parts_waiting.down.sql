-- Rollback of 20261120012300_parts_waiting: removes parts on order (the table and its functions) and restores the
-- lifecycle of 20261101000100 (no waiting for parts before work starts; no way back to the queue). Parts already
-- received stay in the parts ledger and cost lines. A work order waiting for parts that never started can still move
-- on (in progress, scheduled or canceled).
CREATE OR REPLACE FUNCTION private.wo_transition_ok(p_from text, p_to text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_from
    when 'reported'       then p_to in ('triaged', 'scheduled', 'in_progress', 'canceled')
    when 'triaged'        then p_to in ('scheduled', 'in_progress', 'canceled')
    when 'scheduled'      then p_to in ('triaged', 'in_progress', 'canceled')
    when 'in_progress'    then p_to in ('awaiting_parts', 'awaiting_inspection', 'completed', 'scheduled', 'canceled')
    when 'awaiting_parts' then p_to in ('in_progress', 'scheduled', 'canceled')
    when 'completed'      then p_to in ('closed', 'in_progress')
    else false
  end;
$function$;

drop function if exists public.demo_part_wait_samples();
drop function if exists public.part_waits(uuid);
drop function if exists public.part_wait_cancel(uuid, text);
drop function if exists public.part_wait_receive(uuid, boolean);
drop function if exists public.part_wait_update(uuid, jsonb);
drop function if exists public.part_wait_add(uuid, jsonb);
drop function if exists private.part_wait_for_change(uuid);
drop table if exists public.work_order_part_waits;
