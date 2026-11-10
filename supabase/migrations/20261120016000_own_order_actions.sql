-- =============================================================================
-- A person's own direct order, and three security review fixes (owner decisions 2026-11-09, master plan §12 MD1 and
-- SEC3). Builds on orders.create (20261120009900_dispatcher_orders.sql).
--
-- MD1, with orders.create (dispatchers, by default) on a direct order the person started themselves:
--   1. Cancel it while it is still a draft (draft -> canceled), with a reason, recorded in the order's history like
--      every cancel. A confirmed order, and anyone else's draft, still need orders.edit.
--   2. Flag it urgent or change its open urgent flag (public.flag_order_urgent), and add or change its stops
--      (public.save_order_stops), whether it is a draft or already confirmed ("phoned-in urgent work"). Anyone else's
--      order still needs orders.edit. Withdrawing a flag stays orders.edit and moving it along stays dispatch, as before.
-- SEC3:
--   3. Confirming one's own draft with orders.create (no orders.edit) checks the credit hold again: a customer put on
--      hold after the draft was saved is refused with the same message as saving a new order for them.
--   4. public.effective_prices (the price list behind the quote and order editors) also answers people with
--      orders.create, who need it to enter a new order (src/app/(app)/orders/actions.ts loadOrderCustomerContext and
--      the new-order page). It already required quotes.view or orders.edit; nobody else gains anything.
--   5. The portal "Ask a question" picker (public.portal_support_link_options) offers orders only while the company
--      shows orders in its portal, tickets only while it shows documents, and invoices only while the portal shows
--      invoices (private.portal_invoices_on); a general question always works. Opening a case
--      (public.portal_support_open) refuses a link to something the portal does not show, the same way.
--
-- How the existing functions change: private.require_order_transition is replaced (it only ever had this one job);
-- flag_order_urgent, save_order_stops, effective_prices and portal_support_open get only their permission or link-check
-- line replaced, patched from the installed definition so the rest of each stays exactly as reviewed and deployed; the
-- line must appear exactly once, or the migration stops and changes nothing; an already patched function is left as it
-- is. portal_support_link_options is replaced from its latest definition (20261120011500) with the switches added.
-- Functions only: no tables, no rows.
-- Reversible: supabase/rollbacks/20261120016000_own_order_actions.down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 and 3. Who may move an order to another status
-- -----------------------------------------------------------------------------
-- As before (private.order_transition_permission: confirming a draft and canceling need orders.edit, every other move
-- orders.schedule), plus, for a person with orders.create and without orders.edit, on a direct draft they started
-- themselves: confirming it (only while its customer is not on credit hold) and canceling it. Only called from
-- public.set_order_status (not granted to anyone), which has already locked and found the order in this company.
create or replace function private.require_order_transition(p_order_id uuid, p_from public.order_status, p_to public.order_status)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_name  text;
begin
  if p_from = 'draft' and p_to in ('confirmed', 'canceled')
     and not private.has_permission('orders.edit')
     and private.has_permission('orders.create') then
    select * into v_order from public.orders o
     where o.id = p_order_id and o.company_id = private.require_company()
       and o.created_by = auth.uid() and o.source_quote_id is null and o.status = 'draft';
    if found then
      -- The customer may have been put on hold after the draft was saved: someone who can change orders decides.
      if p_to = 'confirmed' and exists (select 1 from private.credit_holds(v_order.company_id, array[v_order.customer_id])) then
        select c.name into v_name from public.customers c where c.id = v_order.customer_id and c.company_id = v_order.company_id;
        raise exception '% is on credit hold. A new order for them needs someone who can change orders: they decide whether to go ahead and record why.',
          coalesce(v_name, 'This customer') using errcode = '42501';
      end if;
      return;
    end if;
  end if;
  perform private.require_permission(private.order_transition_permission(p_from, p_to));
end;
$$;

revoke all on function private.require_order_transition(uuid, public.order_status, public.order_status) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Urgent flag and stops: orders.edit, or orders.create on one's own direct order
-- -----------------------------------------------------------------------------
-- An order not found in the person's company is left to the calling function, which answers "Order not found." (no
-- other company's order is ever read: the lookup is limited to private.require_company()). Only called from
-- public.flag_order_urgent and public.save_order_stops (not granted to anyone).
create or replace function private.require_own_order_change(p_order_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  if private.has_permission('orders.edit') then
    return;
  end if;
  perform private.require_permission('orders.create');
  select * into v_order from public.orders where id = p_order_id and company_id = private.require_company();
  if found and (v_order.created_by is distinct from auth.uid() or v_order.source_quote_id is not null) then
    raise exception 'Only the person who entered this order, or someone who can change orders, can do that.'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.require_own_order_change(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Portal links: only what the portal shows
-- -----------------------------------------------------------------------------
-- The portal's own checks first (an order only while Orders is shown, a ticket only while Documents is shown, an
-- invoice only while invoices are shown), then the shared ownership check. Only called from public.portal_support_open.
create or replace function private.portal_support_check_links(p_company uuid, p_customer uuid, p_order uuid, p_ticket uuid, p_invoice uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_order is not null and not private.portal_feature(p_company, 'orders') then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if p_ticket is not null and not private.portal_feature(p_company, 'documents') then
    raise exception 'Ticket not found.' using errcode = 'P0002';
  end if;
  if p_invoice is not null and not private.portal_invoices_on(p_company) then
    raise exception 'Invoice not found.' using errcode = 'P0002';
  end if;
  perform private.support_check_links(p_company, p_customer, p_order, p_ticket, p_invoice);
end;
$$;

revoke all on function private.portal_support_check_links(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- The customer's own orders, tickets and invoices to link a case to (most recent first), each kind only while the
-- company shows it in the portal. As 20261120011500 otherwise.
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
    'orders', case when private.portal_feature(v.company_id, 'orders') then
               (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'label', o.order_number) order by o.created_at desc), '[]'::jsonb)
                from (select * from public.orders where company_id = v.company_id and customer_id = v.customer_id and status <> 'draft' order by created_at desc limit 50) o)
              else '[]'::jsonb end,
    'tickets', case when private.portal_feature(v.company_id, 'documents') then
                (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'label', t.ticket_number, 'delivered_at', t.delivered_at,
                                                              'quantity', t.quantity, 'unit', private.portal_unit(t.company_id, t.unit_code))
                                           order by t.created_at desc), '[]'::jsonb)
                 from (select t.* from public.delivery_tickets t join public.orders o on o.id = t.order_id and o.company_id = t.company_id
                       where t.company_id = v.company_id and o.customer_id = v.customer_id and t.status <> 'superseded' order by t.created_at desc limit 50) t)
               else '[]'::jsonb end,
    'invoices', case when private.portal_invoices_on(v.company_id) then
                 (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'label', i.number) order by i.created_at desc), '[]'::jsonb)
                  from (select * from public.invoices where company_id = v.company_id and customer_id = v.customer_id and status <> 'draft' order by created_at desc limit 50) i)
                else '[]'::jsonb end);
end;
$$;

-- -----------------------------------------------------------------------------
-- 2, 4 and 5. Point the existing functions at the new checks (one line each)
-- -----------------------------------------------------------------------------
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
    if position(v_patch.new_line in v_def) > 0 and position(v_patch.old_line in v_def) = 0 then
      continue;
    end if;
    if (length(v_def) - length(replace(v_def, v_patch.old_line, ''))) / length(v_patch.old_line) <> 1 then
      raise exception '% is not the version this migration expects (its line was not found exactly once).', v_patch.fn;
    end if;
    execute replace(v_def, v_patch.old_line, v_patch.new_line);
  end loop;
end;
$$;

-- Verification: every changed function is a pinned definer function and points at its new check.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname, p.proname) in (('private', 'require_order_transition'), ('private', 'require_own_order_change'),
                                     ('private', 'portal_support_check_links'), ('public', 'portal_support_link_options'))
      and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']))
  then
    raise exception 'A changed function is not a pinned security definer function.';
  end if;
  if position('private.require_own_order_change(' in pg_get_functiondef('public.flag_order_urgent(uuid, text, timestamptz)'::regprocedure)) = 0
     or position('private.require_own_order_change(' in pg_get_functiondef('public.save_order_stops(uuid, jsonb)'::regprocedure)) = 0
     or position('has_permission(''orders.create'')' in pg_get_functiondef('public.effective_prices(uuid, date)'::regprocedure)) = 0
     or position('private.portal_support_check_links(' in pg_get_functiondef('public.portal_support_open(text, text, text, text, uuid, uuid, uuid)'::regprocedure)) = 0 then
    raise exception 'A function was not pointed at its new check.';
  end if;
end;
$$;
