-- Rollback of 20261120016400_order_price_correct. Run with psql -v ON_ERROR_STOP=1 -1 -f.
--   * public.order_confirm_price: back to confirm-only (the 20261120016100 definition, two arguments).
--   * The order guards lose the tlt.price_correction exception (confirmed orders' lines and totals fixed, as before).
-- Prices corrected meanwhile stay as they are (they are the orders' prices now; the audit log keeps the old ones).
begin;

drop function if exists public.order_confirm_price(uuid, text, jsonb);

create or replace function public.order_confirm_price(p_order_id uuid, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_order   public.orders%rowtype;
  v_note    text := private.clean_text(coalesce(p_note, ''), 500, 'Note');
  v_lines   jsonb;
begin
  if not (private.has_permission('pricing.edit') or private.has_permission('pricing.override') or private.has_permission('billing.manage')) then
    raise exception 'Only someone who can set prices or manage billing can confirm a typed price.' using errcode = '42501';
  end if;
  if private.support_company() is not null then
    raise exception 'Taviron support cannot confirm prices. Ask someone at the company who sets prices or manages billing.'
      using errcode = '42501';
  end if;
  v_company := private.require_company();
  select * into v_order from public.orders where id = p_order_id and company_id = v_company for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if v_order.price_check_requested_at is null then
    raise exception 'Order % has no typed price to check.', v_order.order_number using errcode = '22023';
  end if;
  if v_order.price_checked_at is not null then
    return jsonb_build_object('confirmed', false, 'checked_at', v_order.price_checked_at);
  end if;
  if v_order.status = 'canceled' then
    raise exception 'Order % is canceled.', v_order.order_number using errcode = '22023';
  end if;
  update public.orders set price_checked_at = now(), price_checked_by = auth.uid(), price_check_note = v_note
   where id = v_order.id;
  select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'description', l.description, 'unit_code', l.unit_code,
                                      'unit_rate_cents', l.unit_rate_cents, 'percent_bp', l.percent_bp,
                                      'entered_by', l.price_entered_by) order by l.line_no)
    into v_lines
    from public.order_lines l where l.order_id = v_order.id and l.company_id = v_company and l.price_entered_by is not null;
  perform private.log_event('order.price_checked', 'order', v_order.id,
    format('%s: typed price checked and confirmed%s', v_order.order_number, case when v_note <> '' then ': ' || v_note else '' end),
    jsonb_build_object('requested_by', v_order.price_check_requested_by, 'requested_at', v_order.price_check_requested_at,
                       'fingerprint', v_order.price_check_fingerprint, 'lines', coalesce(v_lines, '[]'::jsonb)));
  return jsonb_build_object('confirmed', true, 'checked_at', now());
end;
$$;

revoke all on function public.order_confirm_price(uuid, text) from public, anon;
grant execute on function public.order_confirm_price(uuid, text) to authenticated;

do $$
declare
  v_def text;
  v_patch record;
begin
  for v_patch in
    select * from (values
      ('private.guard_order_lines()'::regprocedure,
       '
     or (tg_op = ''UPDATE'' and current_setting(''tlt.price_correction'', true) = ''on'' and new.order_id = old.order_id)'),
      ('private.guard_order_pricing()'::regprocedure,
       '
     and current_setting(''tlt.price_correction'', true) is distinct from ''on''')
    ) as t(fn, added)
  loop
    v_def := pg_get_functiondef(v_patch.fn);
    if position(v_patch.added in v_def) = 0 then
      continue; -- not patched (already rolled back)
    end if;
    execute replace(v_def, v_patch.added, '');
  end loop;
end;
$$;

notify pgrst, 'reload schema';

commit;
