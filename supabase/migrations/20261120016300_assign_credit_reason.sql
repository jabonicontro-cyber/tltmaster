-- =============================================================================
-- Credit hold reason, required and recorded by the database (financial review 2026-11-09, L2; master plan §12 SEC4).
--
-- Dispatching a load for a customer on credit hold needs a reason, which is recorded (B128, owner 2026-11-02: warn,
-- and a reason to go ahead). The reason was asked and recorded by the app only: public.assign_load and
-- public.hauler_offer_confirm called directly (REST API), or confirming a hired truck's offer in the app, went ahead
-- without one. Now the database asks for it:
--   * public.assign_load takes p_credit_reason (new, last, default null). When private.credit_holds lists the order's
--     customer, it refuses without a reason of at least 3 characters (hint 'credit_hold'), and with one it writes the
--     credit_hold_overrides row (context 'assignment', the new assignment) and the audit event itself, in the same
--     transaction as the assignment.
--   * public.assign_load_off_shift takes p_credit_reason too and passes it on.
--   * public.hauler_offer_confirm takes p_reason (new, default null) and passes it on.
-- A customer not on hold needs nothing, as before; callers that pass no reason keep working for them.
--
-- How: each function is taken from its installed definition, given the new parameter (the old signature is dropped
-- first so calls with the earlier arguments are not ambiguous) and its few new lines; each anchor must appear exactly
-- once, or the migration stops and changes nothing. Execute rights as before (authenticated and service_role).
-- Functions only: no tables, no rows.
-- Reversible: supabase/rollbacks/20261120016300_assign_credit_reason.down.sql
-- =============================================================================

do $$
declare
  v_fn     regprocedure;
  v_def    text;
  v_args   text;
  v_sig    text;
  v_patch  record;
  v_line   record;
begin
  for v_patch in
    select * from (values
      ('public.assign_load(uuid, uuid, uuid, uuid, text, uuid)', 'public.assign_load', ', p_credit_reason text DEFAULT NULL::text',
       'uuid, uuid, uuid, uuid, text, uuid, text'),
      ('public.assign_load_off_shift(uuid, uuid, uuid, uuid, text, uuid, text)', 'public.assign_load_off_shift', ', p_credit_reason text DEFAULT NULL::text',
       'uuid, uuid, uuid, uuid, text, uuid, text, text'),
      ('public.hauler_offer_confirm(uuid)', 'public.hauler_offer_confirm', ', p_reason text DEFAULT NULL::text',
       'uuid, text')
    ) as t(old_sig, name, new_arg, new_types)
  loop
    if to_regprocedure(v_patch.name || '(' || v_patch.new_types || ')') is not null then
      continue; -- already changed (re-run)
    end if;
    v_fn := v_patch.old_sig::regprocedure;
    v_def := pg_get_functiondef(v_fn);
    v_args := pg_get_function_arguments(v_fn);
    v_sig := v_patch.name || '(' || v_args || ')';
    if (length(v_def) - length(replace(v_def, v_sig, ''))) / length(v_sig) <> 1 then
      raise exception '% is not the version this migration expects (its signature was not found exactly once).', v_patch.old_sig;
    end if;
    v_def := replace(v_def, v_sig, v_patch.name || '(' || v_args || v_patch.new_arg || ')');

    for v_line in
      select * from (values
        -- assign_load: the hold, checked before anything is changed, and recorded with the new assignment.
        ('public.assign_load', '  v_capacity   text;',
         '  v_capacity   text;
  v_hold       text[];
  v_reason     text := private.clean_text(coalesce(p_credit_reason, ''''), 500, ''Reason'');'),
        ('public.assign_load', '  -- Capacity (N15): never assign more than the equipment''s recorded capacity.',
         '  -- Credit hold (B128, financial review L2): going ahead for a customer on hold needs a reason, recorded below.
  select h.reasons into v_hold from private.credit_holds(v_company, array[v_order.customer_id]) h;
  if v_hold is not null and length(v_reason) < 3 then
    raise exception ''% is on credit hold. To go ahead, give a reason; it is recorded.'',
      coalesce((select c.name from public.customers c where c.id = v_order.customer_id and c.company_id = v_company), ''This customer'')
      using errcode = ''22023'', hint = ''credit_hold'';
  end if;

  -- Capacity (N15): never assign more than the equipment''s recorded capacity.'),
        ('public.assign_load', '  return jsonb_build_object(''assignment_id'', v_new.id, ''warnings'', to_jsonb(v_warnings));',
         '  if v_hold is not null then
    insert into public.credit_hold_overrides (company_id, customer_id, context, entity_id, reason, hold_reasons, created_by)
    values (v_company, v_order.customer_id, ''assignment'', v_new.id, v_reason, v_hold, auth.uid());
    perform private.log_event(''customer.credit_override'', ''customer'', v_order.customer_id,
      format(''Went ahead with a dispatch for a customer on credit hold: %s'', v_reason),
      jsonb_build_object(''context'', ''assignment'', ''entity_id'', v_new.id, ''order_id'', v_order.id, ''hold_reasons'', v_hold));
  end if;

  return jsonb_build_object(''assignment_id'', v_new.id, ''warnings'', to_jsonb(v_warnings));'),
        ('public.assign_load_off_shift',
         '  v_result := public.assign_load(p_load_id, p_truck_id, p_trailer_id, p_driver_id, coalesce(p_note, ''''), p_replace_assignment_id);',
         '  v_result := public.assign_load(p_load_id, p_truck_id, p_trailer_id, p_driver_id, coalesce(p_note, ''''), p_replace_assignment_id, p_credit_reason);'),
        ('public.hauler_offer_confirm',
         '  v_result := public.assign_load(v_offer.load_id, v_offer.truck_id, v_offer.trailer_id, v_offer.driver_id, ''Hired truck: offer accepted'', null);',
         '  v_result := public.assign_load(v_offer.load_id, v_offer.truck_id, v_offer.trailer_id, v_offer.driver_id, ''Hired truck: offer accepted'', null, p_reason);')
      ) as l(name, old_line, new_line)
      where l.name = v_patch.name
    loop
      if (length(v_def) - length(replace(v_def, v_line.old_line, ''))) / length(v_line.old_line) <> 1 then
        raise exception '% is not the version this migration expects (a line was not found exactly once).', v_patch.old_sig;
      end if;
      v_def := replace(v_def, v_line.old_line, v_line.new_line);
    end loop;

    execute format('drop function %s', v_fn::text);
    execute v_def;
    execute format('revoke all on function %s(%s) from public, anon', v_patch.name, v_patch.new_types);
    execute format('grant execute on function %s(%s) to authenticated, service_role', v_patch.name, v_patch.new_types);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

-- Verification: the new signatures exist, the old ones are gone, each is a pinned definer function, and assign_load
-- records the override itself.
do $$
begin
  if to_regprocedure('public.assign_load(uuid, uuid, uuid, uuid, text, uuid, text)') is null
     or to_regprocedure('public.assign_load_off_shift(uuid, uuid, uuid, uuid, text, uuid, text, text)') is null
     or to_regprocedure('public.hauler_offer_confirm(uuid, text)') is null
     or to_regprocedure('public.assign_load(uuid, uuid, uuid, uuid, text, uuid)') is not null
     or to_regprocedure('public.assign_load_off_shift(uuid, uuid, uuid, uuid, text, uuid, text)') is not null
     or to_regprocedure('public.hauler_offer_confirm(uuid)') is not null then
    raise exception 'The credit hold reason was not added to every function.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('assign_load', 'assign_load_off_shift', 'hauler_offer_confirm')
      and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']))
  then
    raise exception 'A changed function is not a pinned security definer function.';
  end if;
  if position('insert into public.credit_hold_overrides' in pg_get_functiondef('public.assign_load(uuid, uuid, uuid, uuid, text, uuid, text)'::regprocedure)) = 0 then
    raise exception 'assign_load does not record the credit hold reason.';
  end if;
end;
$$;
