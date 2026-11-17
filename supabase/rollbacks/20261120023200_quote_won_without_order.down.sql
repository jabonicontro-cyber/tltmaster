-- Rollback of 20261120023200_quote_won_without_order.sql (not a migration; run by hand with a backup first).
-- Quotes are converted as before whatever the modules say; who accepted each quote stays in the status history.
create or replace function public.set_quote_status(p_quote_id uuid, p_status quote_status, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_quote public.quotes%rowtype;
  v_note  text := private.clean_text(p_note, 500, 'Note');
begin
  perform private.require_permission('quotes.status');

  select * into v_quote from public.quotes where id = p_quote_id and company_id = private.require_company() for update;
  if not found then raise exception 'Quote not found.'; end if;

  if v_quote.status = p_status then
    return jsonb_build_object('status', p_status, 'changed', false);
  end if;

  if not private.quote_transition_allowed(v_quote.status, p_status) then
    raise exception 'A % quote cannot be marked %.', v_quote.status, p_status;
  end if;

  if p_status in ('declined', 'canceled') and length(v_note) = 0 then
    raise exception 'Enter a reason.';
  end if;

  update public.quotes set
    status = p_status,
    status_note = v_note,
    accepted_version_id = case when p_status = 'accepted' then current_version_id else accepted_version_id end,
    accepted_at = case when p_status = 'accepted' then now() else accepted_at end,
    closed_at = case when p_status in ('declined', 'expired', 'canceled') then now() else null end
  where id = p_quote_id;

  perform private.record_status_change(p_quote_id, v_quote.current_version_id, v_quote.status, p_status, v_note);
  perform private.log_event('quote.status_changed', 'quote', p_quote_id,
    format('%s marked %s%s', v_quote.quote_number, p_status,
           case when length(v_note) > 0 then ': ' || v_note else '' end),
    jsonb_build_object('from', v_quote.status, 'to', p_status));

  return jsonb_build_object('status', p_status, 'changed', true);
end;
$function$

;

create or replace function public.convert_quote_to_order(p_quote_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_quote    public.quotes%rowtype;
  v_version  public.quote_versions%rowtype;
  v_existing public.orders%rowtype;
  v_order    public.orders%rowtype;
  v_lines    integer;
  v_company  uuid;
begin
  perform private.require_permission('orders.edit');
  v_company := private.require_company();

  -- Serializes concurrent conversions of the same quote.
  select * into v_quote from public.quotes where id = p_quote_id and company_id = v_company for update;
  if not found then
    raise exception 'Quote not found.';
  end if;

  select * into v_existing from public.orders where source_quote_id = p_quote_id and company_id = v_company;
  if found then
    return jsonb_build_object('order_id', v_existing.id, 'order_number', v_existing.order_number, 'created', false);
  end if;

  if v_quote.status <> 'accepted' then
    raise exception 'Quote % is %. Only accepted quotes can be converted to an order.',
      v_quote.quote_number, v_quote.status;
  end if;

  select * into v_version from public.quote_versions where id = v_quote.accepted_version_id;
  if not found or v_version.locked_at is null then
    raise exception 'Quote % has no issued accepted revision to convert.', v_quote.quote_number;
  end if;

  select count(*) into v_lines from public.quote_lines where quote_version_id = v_version.id;
  if v_lines = 0 then
    raise exception 'Quote % has no lines to convert.', v_quote.quote_number;
  end if;

  insert into public.orders (
    company_id, order_number, customer_id, status, source_quote_id, source_quote_version_id,
    order_date, confirmed_at, contact_id,
    bill_to_snapshot, contact_name, contact_email, contact_phone,
    site_id, site_label, site_line1, site_line2, site_city, site_state, site_postal_code,
    project_name, customer_po, job_instructions, terms, internal_notes,
    tax_rate_bp, subtotal_cents, discount_cents, taxable_cents, tax_cents, total_cents,
    is_sample, created_by, updated_by)
  values (
    v_company, private.next_document_number(v_company, 'order'), v_quote.customer_id, 'confirmed', v_quote.id, v_version.id,
    private.business_today(v_company), now(), v_version.contact_id,
    v_version.bill_to_snapshot, v_version.contact_name, v_version.contact_email, v_version.contact_phone,
    v_version.site_id, v_version.site_label, v_version.site_line1, v_version.site_line2,
    v_version.site_city, v_version.site_state, v_version.site_postal_code,
    v_version.project_name, v_version.customer_po, v_version.job_instructions, v_version.terms,
    v_version.internal_notes,
    v_version.tax_rate_bp, v_version.subtotal_cents, v_version.discount_cents, v_version.taxable_cents,
    v_version.tax_cents, v_version.total_cents,
    v_quote.is_sample, auth.uid(), auth.uid())
  returning * into v_order;

  perform set_config('tlt.order_conversion', 'on', true);

  insert into public.order_lines (
    company_id, order_id, line_no, source_quote_line_id, kind, calc_method, material_id, charge_item_id,
    description, unit_code, unit_label, quantity, unit_rate_cents, percent_bp,
    catalog_rate_cents, catalog_percent_bp, price_source, taxable, amount_cents)
  select
    v_company, v_order.id, l.line_no, l.id, l.kind, l.calc_method, l.material_id, l.charge_item_id,
    l.description, l.unit_code, l.unit_label, l.quantity, l.unit_rate_cents, l.percent_bp,
    l.catalog_rate_cents, l.catalog_percent_bp, l.price_source, l.taxable, l.amount_cents
  from public.quote_lines l
  where l.quote_version_id = v_version.id
  order by l.line_no;
  perform set_config('tlt.order_conversion', 'off', true);

  insert into public.order_status_events (company_id, order_id, from_status, to_status, note, actor_id)
  values (v_company, v_order.id, null, 'confirmed',
          format('Created from quote %s revision %s', v_quote.quote_number, v_version.version_no), auth.uid());

  perform private.log_event('order.created_from_quote', 'order', v_order.id,
    format('%s created from %s (revision %s), total %s', v_order.order_number, v_quote.quote_number,
           v_version.version_no, to_char(v_order.total_cents / 100.0, 'FM999,999,990.00')),
    jsonb_build_object('quote_id', v_quote.id, 'quote_version_id', v_version.id, 'line_count', v_lines));
  perform private.log_event('quote.converted_to_order', 'quote', v_quote.id,
    format('%s converted to order %s', v_quote.quote_number, v_order.order_number),
    jsonb_build_object('order_id', v_order.id));

  return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number, 'created', true);
end;
$function$

;

create or replace function private.quote_accepted_create_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.create_order_from_quote(new.id);
  return new;
end;
$function$;

alter table public.quotes drop column if exists accepted_by;
