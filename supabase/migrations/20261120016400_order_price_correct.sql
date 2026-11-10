-- =============================================================================
-- Correcting a typed price while confirming it (financial review M1, owner answer 2026-11-10 to the question asked
-- after 20261120016100).
--
-- "Price to be checked" (20261120016100) let someone with pricing.edit, pricing.override or billing.manage confirm a
-- price typed by a person with orders.create only. A confirmed order's lines could not change, so a wrong typed price
-- had no way out. The owner decided: in the same "Confirm price" step, someone with billing.manage may enter a corrected
-- unit price for each typed line, with a short reason, also after the order is confirmed. pricing.edit and
-- pricing.override confirm, but do not correct (an order's price is a billing decision; they set price lists).
--   * public.order_confirm_price gets p_corrections (new, last, default null): a list of {line_id, unit_rate_cents}.
--     Only lines whose price was typed (order_lines.price_entered_by) and priced per unit; the reason (p_note, at least
--     3 characters) is required when anything is corrected.
--   * The line amount, percentage lines and the order totals are recomputed the way a draft save computes them
--     (private.line_amount_cents, private.recompute_order_totals); the typed-price fingerprint follows the new price.
--   * Recorded in the audit log (order.price_corrected: each line's old and new price, the old and new total, who and
--     why), which the order's History shows, before order.price_checked.
--   * Refused: without billing.manage; during a Taviron support visit (as every confirmation); for an order on an issued
--     invoice ("correct the invoice instead"); for an order handed off for billing (undo the handoff first, so the
--     handoff never differs from the order); for a canceled order.
--   * The order guards (20261012000100: confirmed orders' lines and totals are fixed) get one narrow exception, set only
--     inside this function for its own transaction (tlt.price_correction), as detention_apply's tlt.billed_extra: an
--     existing line's price and amount may be UPDATED and the order's totals may follow. Nothing is inserted or deleted.
--     Signed-in people cannot write orders or lines directly (SELECT only), so the setting matters only here.
--
-- How: order_confirm_price is dropped and created again with the new argument (calls with two arguments keep working);
-- the two guards get one condition each, patched from the installed definition (each anchor exactly once, or the
-- migration stops). No tables, no rows.
-- Reversible: supabase/rollbacks/20261120016400_order_price_correct.down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The guards allow a price correction (only while tlt.price_correction is on)
-- -----------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_patch record;
begin
  for v_patch in
    select * from (values
      ('private.guard_order_lines()'::regprocedure,
       '     or (tg_op = ''INSERT'' and current_setting(''tlt.billed_extra'', true) = ''on'') then',
       '     or (tg_op = ''INSERT'' and current_setting(''tlt.billed_extra'', true) = ''on'')
     or (tg_op = ''UPDATE'' and current_setting(''tlt.price_correction'', true) = ''on'' and new.order_id = old.order_id) then'),
      ('private.guard_order_pricing()'::regprocedure,
       '     and current_setting(''tlt.billed_extra'', true) is distinct from ''on''',
       '     and current_setting(''tlt.billed_extra'', true) is distinct from ''on''
     and current_setting(''tlt.price_correction'', true) is distinct from ''on''')
    ) as t(fn, old_line, new_line)
  loop
    v_def := pg_get_functiondef(v_patch.fn);
    if position('tlt.price_correction' in v_def) > 0 then
      continue; -- already patched (re-run)
    end if;
    if (length(v_def) - length(replace(v_def, v_patch.old_line, ''))) / length(v_patch.old_line) <> 1 then
      raise exception '% is not the version this migration expects (its line was not found exactly once).', v_patch.fn;
    end if;
    execute replace(v_def, v_patch.old_line, v_patch.new_line);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Confirm, and with billing.manage correct, a typed price
-- -----------------------------------------------------------------------------
drop function if exists public.order_confirm_price(uuid, text);

create or replace function public.order_confirm_price(p_order_id uuid, p_note text default '', p_corrections jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company  uuid;
  v_order    public.orders%rowtype;
  v_note     text := private.clean_text(coalesce(p_note, ''), 500, 'Note');
  v_corr     jsonb := coalesce(p_corrections, '[]'::jsonb);
  v_item     jsonb;
  v_line     public.order_lines%rowtype;
  v_line_id  uuid;
  v_new      bigint;
  v_changes  jsonb := '[]'::jsonb;
  v_base     bigint;
  v_total    bigint;
  v_lines    jsonb;
  v_fp       text;
begin
  if not (private.has_permission('pricing.edit') or private.has_permission('pricing.override') or private.has_permission('billing.manage')) then
    raise exception 'Only someone who can set prices or manage billing can confirm a typed price.' using errcode = '42501';
  end if;
  if private.support_company() is not null then
    raise exception 'Taviron support cannot confirm prices. Ask someone at the company who sets prices or manages billing.'
      using errcode = '42501';
  end if;
  if jsonb_typeof(v_corr) <> 'array' then
    raise exception 'Corrections must be a list.' using errcode = '22023';
  end if;
  if jsonb_array_length(v_corr) > 200 then
    raise exception 'An order can have at most 200 lines.' using errcode = '22023';
  end if;
  if jsonb_array_length(v_corr) > 0 then
    if not private.has_permission('billing.manage') then
      raise exception 'Only billing can correct a typed price. You can confirm it as typed.' using errcode = '42501';
    end if;
    if length(v_note) < 3 then
      raise exception 'Say why the price is corrected.' using errcode = '22023';
    end if;
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
    if jsonb_array_length(v_corr) > 0 then
      raise exception 'The price on order % was already confirmed.', v_order.order_number using errcode = '22023';
    end if;
    return jsonb_build_object('confirmed', false, 'checked_at', v_order.price_checked_at);
  end if;
  if v_order.status = 'canceled' then
    raise exception 'Order % is canceled.', v_order.order_number using errcode = '22023';
  end if;

  if jsonb_array_length(v_corr) > 0 then
    if exists (
      select 1 from public.invoices i
       where i.company_id = v_company and i.status = 'issued'
         and (i.order_id = v_order.id
              or exists (select 1 from public.invoice_orders io where io.invoice_id = i.id and io.order_id = v_order.id and io.active)))
    then
      raise exception 'Order % is on an issued invoice, so its prices cannot be changed here. Correct the invoice instead.', v_order.order_number
        using errcode = '22023';
    end if;
    if exists (select 1 from public.billing_handoff_orders h where h.company_id = v_company and h.order_id = v_order.id and h.reverted_at is null) then
      raise exception 'Order % was handed off for billing. Undo the handoff first, then correct the price.', v_order.order_number
        using errcode = '22023';
    end if;

    perform set_config('tlt.price_correction', 'on', true);
    for v_item in select value from jsonb_array_elements(v_corr) loop
      begin
        v_line_id := (v_item ->> 'line_id')::uuid;
        v_new := (v_item ->> 'unit_rate_cents')::bigint;
      exception when others then
        raise exception 'Each correction needs a line and a price.' using errcode = '22023';
      end;
      select * into v_line from public.order_lines where id = v_line_id and order_id = v_order.id and company_id = v_company for update;
      if not found then
        raise exception 'Line not found on order %.', v_order.order_number using errcode = 'P0002';
      end if;
      if v_line.price_entered_by is null then
        raise exception 'Line %: only a typed price can be corrected here.', v_line.line_no using errcode = '22023';
      end if;
      if v_line.calc_method <> 'per_unit' then
        raise exception 'Line %: only a price per unit can be corrected here.', v_line.line_no using errcode = '22023';
      end if;
      if v_new is null or v_new < 0 or v_new > 100000000 then
        raise exception 'Line %: enter a price between $0.00 and $1,000,000.00.', v_line.line_no using errcode = '22023';
      end if;
      continue when v_new = v_line.unit_rate_cents;
      update public.order_lines
         set unit_rate_cents = v_new,
             amount_cents = private.line_amount_cents(v_line.kind, v_line.calc_method, v_line.quantity, v_new, v_line.percent_bp, 0)
       where id = v_line.id;
      v_changes := v_changes || jsonb_build_object('line_id', v_line.id, 'line_no', v_line.line_no, 'description', v_line.description,
                                                   'unit_code', v_line.unit_code, 'from_cents', v_line.unit_rate_cents, 'to_cents', v_new,
                                                   'entered_by', v_line.price_entered_by);
    end loop;

    if jsonb_array_length(v_changes) > 0 then
      -- Percentage lines follow the new subtotal, as when a draft is saved (save_order_draft).
      select coalesce(sum(round(l.quantity * l.unit_rate_cents)), 0)::bigint into v_base
        from public.order_lines l
       where l.order_id = v_order.id and l.company_id = v_company and l.calc_method = 'per_unit' and l.kind <> 'discount';
      update public.order_lines l
         set amount_cents = private.line_amount_cents(l.kind, l.calc_method, l.quantity, l.unit_rate_cents, l.percent_bp, v_base)
       where l.order_id = v_order.id and l.company_id = v_company and l.calc_method <> 'per_unit';
      perform private.recompute_order_totals(v_order.id);
      select total_cents into v_total from public.orders where id = v_order.id;
      v_fp := private.order_price_fingerprint(v_order.id, v_company);
      update public.orders set price_check_fingerprint = v_fp where id = v_order.id;
      perform private.log_event('order.price_corrected', 'order', v_order.id,
        format('%s: typed price corrected (%s): %s', v_order.order_number,
               (select string_agg(format('line %s from %s to %s', c ->> 'line_no',
                                         '$' || to_char((c ->> 'from_cents')::bigint / 100.0, 'FM999,999,990.00'),
                                         '$' || to_char((c ->> 'to_cents')::bigint / 100.0, 'FM999,999,990.00')), ', ')
                  from jsonb_array_elements(v_changes) c),
               v_note),
        jsonb_build_object('changes', v_changes, 'reason', v_note, 'total_from', v_order.total_cents, 'total_to', v_total,
                           'requested_by', v_order.price_check_requested_by));
    end if;
    perform set_config('tlt.price_correction', '', true);
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
                       'fingerprint', v_order.price_check_fingerprint, 'lines', coalesce(v_lines, '[]'::jsonb),
                       'corrected', jsonb_array_length(v_changes)));
  select total_cents into v_total from public.orders where id = v_order.id;
  return jsonb_build_object('confirmed', true, 'checked_at', now(), 'corrected', jsonb_array_length(v_changes), 'total_cents', v_total);
end;
$$;

revoke all on function public.order_confirm_price(uuid, text, jsonb) from public, anon;
grant execute on function public.order_confirm_price(uuid, text, jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';

-- Verification
do $$
begin
  if to_regprocedure('public.order_confirm_price(uuid, text, jsonb)') is null
     or to_regprocedure('public.order_confirm_price(uuid, text)') is not null then
    raise exception 'order_confirm_price does not have the corrections argument.';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.order_confirm_price(uuid, text, jsonb)'::regprocedure
                 and p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']) then
    raise exception 'order_confirm_price is not a pinned security definer function.';
  end if;
  if position('tlt.price_correction' in pg_get_functiondef('private.guard_order_lines()'::regprocedure)) = 0
     or position('tlt.price_correction' in pg_get_functiondef('private.guard_order_pricing()'::regprocedure)) = 0 then
    raise exception 'The order guards do not allow a price correction.';
  end if;
end;
$$;
