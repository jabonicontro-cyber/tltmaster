-- Rollback of 20261120016300_assign_credit_reason (financial review L2). Run with psql -v ON_ERROR_STOP=1 -1 -f.
-- public.assign_load, assign_load_off_shift and hauler_offer_confirm get their earlier signatures and bodies back (the
-- credit hold is then checked and recorded by the app only, as before). Overrides recorded meanwhile stay (history).
-- Functions only: no rows change.
begin;

do $$
declare
  v_fn    regprocedure;
  v_def   text;
  v_patch record;
  v_line  record;
begin
  for v_patch in
    select * from (values
      ('public.assign_load(uuid, uuid, uuid, uuid, text, uuid, text)', 'public.assign_load', ', p_credit_reason text DEFAULT NULL::text', 'uuid, uuid, uuid, uuid, text, uuid'),
      ('public.assign_load_off_shift(uuid, uuid, uuid, uuid, text, uuid, text, text)', 'public.assign_load_off_shift', ', p_credit_reason text DEFAULT NULL::text', 'uuid, uuid, uuid, uuid, text, uuid, text'),
      ('public.hauler_offer_confirm(uuid, text)', 'public.hauler_offer_confirm', ', p_reason text DEFAULT NULL::text', 'uuid')
    ) as t(new_sig, name, added_arg, old_types)
  loop
    if to_regprocedure(v_patch.new_sig) is null then
      continue; -- not changed (already rolled back)
    end if;
    v_fn := v_patch.new_sig::regprocedure;
    v_def := pg_get_functiondef(v_fn);
    v_def := replace(v_def, v_patch.added_arg || ')', ')');
    for v_line in
      select * from (values
        ('public.assign_load', '
  v_hold       text[];
  v_reason     text := private.clean_text(coalesce(p_credit_reason, ''''), 500, ''Reason'');', ''),
        ('public.assign_load', '  -- Credit hold (B128, financial review L2): going ahead for a customer on hold needs a reason, recorded below.
  select h.reasons into v_hold from private.credit_holds(v_company, array[v_order.customer_id]) h;
  if v_hold is not null and length(v_reason) < 3 then
    raise exception ''% is on credit hold. To go ahead, give a reason; it is recorded.'',
      coalesce((select c.name from public.customers c where c.id = v_order.customer_id and c.company_id = v_company), ''This customer'')
      using errcode = ''22023'', hint = ''credit_hold'';
  end if;

', ''),
        ('public.assign_load', '  if v_hold is not null then
    insert into public.credit_hold_overrides (company_id, customer_id, context, entity_id, reason, hold_reasons, created_by)
    values (v_company, v_order.customer_id, ''assignment'', v_new.id, v_reason, v_hold, auth.uid());
    perform private.log_event(''customer.credit_override'', ''customer'', v_order.customer_id,
      format(''Went ahead with a dispatch for a customer on credit hold: %s'', v_reason),
      jsonb_build_object(''context'', ''assignment'', ''entity_id'', v_new.id, ''order_id'', v_order.id, ''hold_reasons'', v_hold));
  end if;

', ''),
        ('public.assign_load_off_shift', ', p_replace_assignment_id, p_credit_reason);', ', p_replace_assignment_id);'),
        ('public.hauler_offer_confirm', '''Hired truck: offer accepted'', null, p_reason);', '''Hired truck: offer accepted'', null);')
      ) as l(name, old_text, new_text)
      where l.name = v_patch.name
    loop
      v_def := replace(v_def, v_line.old_text, v_line.new_text);
    end loop;
    execute format('drop function %s', v_fn::text);
    execute v_def;
    execute format('revoke all on function %s(%s) from public, anon', v_patch.name, v_patch.old_types);
    execute format('grant execute on function %s(%s) to authenticated, service_role', v_patch.name, v_patch.old_types);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

commit;
