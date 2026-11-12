-- Rollback of 20261120019700_no_reassign_ticketed_load (RL1). Run with psql -v ON_ERROR_STOP=1 -f.
-- public.assign_load and public.cancel_assignment get their earlier bodies back exactly (the lines the migration added
-- are taken out again), so a load with a live delivery ticket can be reassigned and unassigned as before; then
-- private.refuse_ticketed_load is removed. Functions only: no rows change.
begin;

do $$
declare
  v_fn    regprocedure;
  v_def   text;
  v_patch record;
begin
  for v_patch in
    select * from (values
      ('public.assign_load(uuid, uuid, uuid, uuid, text, uuid, text)',
       '  -- Delivery ticket (RL1, owner 2026-11-12): a load with a live ticket keeps its truck and driver.
  perform private.refuse_ticketed_load(v_company, v_load.id, ''change'');

'),
      ('public.cancel_assignment(uuid, text)',
       '
  -- Delivery ticket (RL1, owner 2026-11-12): a load with a live ticket keeps its truck and driver. The load row is
  -- locked first, as ticket entry and assign_load do.
  perform 1 from public.order_loads where id = v_a.load_id and company_id = v_company for update;
  perform private.refuse_ticketed_load(v_company, v_a.load_id, ''remove'');')
    ) as t(sig, added)
  loop
    v_fn := v_patch.sig::regprocedure;
    v_def := pg_get_functiondef(v_fn);
    if position(v_patch.added in v_def) = 0 then
      continue; -- not changed (already rolled back)
    end if;
    execute replace(v_def, v_patch.added, '');
  end loop;
  if position('private.refuse_ticketed_load' in pg_get_functiondef('public.assign_load(uuid, uuid, uuid, uuid, text, uuid, text)'::regprocedure)) > 0
     or position('private.refuse_ticketed_load' in pg_get_functiondef('public.cancel_assignment(uuid, text)'::regprocedure)) > 0 then
    raise exception 'A dispatch function still calls private.refuse_ticketed_load.';
  end if;
end;
$$;

drop function if exists private.refuse_ticketed_load(uuid, uuid, text);

commit;
