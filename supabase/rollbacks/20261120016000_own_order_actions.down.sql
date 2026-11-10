-- Rollback of 20261120016000_own_order_actions: back to 20261120009900 / 20261120011500 behaviour.
--   * private.require_order_transition: confirming one's own draft with orders.create again, without the credit hold
--     recheck; canceling one's own draft needs orders.edit again (the 20261120009900 definition).
--   * flag_order_urgent and save_order_stops: orders.edit again; effective_prices: quotes.view or orders.edit again;
--     portal_support_open: the shared link check only. Only the patched line is put back.
--   * portal_support_link_options: the 20261120011500 definition (every kind offered whatever the portal switches).
--   * The two new helpers go.
-- No rows change: orders canceled, flags raised and stops saved meanwhile stay as they are (they are recorded history).
begin;

create or replace function private.require_order_transition(p_order_id uuid, p_from public.order_status, p_to public.order_status)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_from = 'draft' and p_to = 'confirmed'
     and not private.has_permission('orders.edit')
     and private.has_permission('orders.create')
     and exists (
       select 1 from public.orders o
       where o.id = p_order_id and o.company_id = private.require_company()
         and o.created_by = auth.uid() and o.source_quote_id is null and o.status = 'draft') then
    return;
  end if;
  perform private.require_permission(private.order_transition_permission(p_from, p_to));
end;
$$;
revoke all on function private.require_order_transition(uuid, public.order_status, public.order_status) from public, anon, authenticated;

do $$
declare
  v_def text;
  v_patch record;
begin
  for v_patch in
    select * from (values
      ('public.flag_order_urgent(uuid, text, timestamptz)'::regprocedure,
       'perform private.require_permission(''orders.edit'');',
       'perform private.require_own_order_change(p_order_id);'),
      ('public.save_order_stops(uuid, jsonb)'::regprocedure,
       'perform private.require_permission(''orders.edit'');',
       'perform private.require_own_order_change(p_order);'),
      ('public.effective_prices(uuid, date)'::regprocedure,
       'if not (private.has_permission(''quotes.view'') or private.has_permission(''orders.edit'')) then',
       'if not (private.has_permission(''quotes.view'') or private.has_permission(''orders.edit'') or private.has_permission(''orders.create'')) then'),
      ('public.portal_support_open(text, text, text, text, uuid, uuid, uuid)'::regprocedure,
       'perform private.support_check_links(v.company_id, v.customer_id, p_order, p_ticket, p_invoice);',
       'perform private.portal_support_check_links(v.company_id, v.customer_id, p_order, p_ticket, p_invoice);')
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

create or replace function public.portal_support_link_options(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.portal_accounts%rowtype := private.portal_me(p_slug);
begin
  perform private.portal_require_feature(v.company_id, 'support');
  return jsonb_build_object(
    'orders', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'label', o.order_number) order by o.created_at desc), '[]'::jsonb)
               from (select * from public.orders where company_id = v.company_id and customer_id = v.customer_id and status <> 'draft' order by created_at desc limit 50) o),
    'tickets', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'label', t.ticket_number, 'delivered_at', t.delivered_at,
                                                             'quantity', t.quantity, 'unit', private.portal_unit(t.company_id, t.unit_code))
                                          order by t.created_at desc), '[]'::jsonb)
                from (select t.* from public.delivery_tickets t join public.orders o on o.id = t.order_id and o.company_id = t.company_id
                      where t.company_id = v.company_id and o.customer_id = v.customer_id and t.status <> 'superseded' order by t.created_at desc limit 50) t),
    'invoices', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'label', i.number) order by i.created_at desc), '[]'::jsonb)
                 from (select * from public.invoices where company_id = v.company_id and customer_id = v.customer_id and status <> 'draft' order by created_at desc limit 50) i));
end;
$$;

drop function if exists private.require_own_order_change(uuid);
drop function if exists private.portal_support_check_links(uuid, uuid, uuid, uuid, uuid);

commit;
