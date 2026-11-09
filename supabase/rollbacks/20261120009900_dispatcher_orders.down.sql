-- Rollback of 20261120009900_dispatcher_orders: the orders.create permission is removed. save_order_draft and
-- set_order_status get their original permission line back (orders.edit; the transition permission), the two helpers
-- go, and the permission leaves the catalog. Its grants (role_permissions, role_permission_defaults) go with it through
-- the foreign keys: orders.create did not exist before this migration, so no company can have granted it by hand
-- earlier; a company that turned it on or off for a role afterwards loses that choice with the permission itself.
-- orders.edit is not touched (this migration never granted it), so dispatchers who were given orders.edit by hand
-- keep it.
begin;

do $$
declare
  v_def text;
  v_patch record;
begin
  for v_patch in
    select * from (values
      ('public.save_order_draft(jsonb)'::regprocedure,
       'perform private.require_permission(''orders.edit'');',
       'perform private.require_order_draft_save(p_payload);'),
      ('public.set_order_status(uuid, public.order_status, text, integer)'::regprocedure,
       'perform private.require_permission(private.order_transition_permission(v_order.status, p_status));',
       'perform private.require_order_transition(v_order.id, v_order.status, p_status);')
    ) as t(fn, old_line, new_line)
  loop
    v_def := pg_get_functiondef(v_patch.fn);
    if position(v_patch.new_line in v_def) = 0 then
      continue; -- not patched (already rolled back)
    end if;
    execute replace(v_def, v_patch.new_line, v_patch.old_line);
  end loop;
end;
$$;

drop function if exists private.require_order_draft_save(jsonb);
drop function if exists private.require_order_transition(uuid, public.order_status, public.order_status);

delete from public.permissions where code = 'orders.create';

commit;
