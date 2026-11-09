-- =============================================================================
-- Dispatchers create orders (owner decision 2026-11-09, after a first-day dispatcher walkthrough could not enter an
-- urgent phoned-in order): "Dispatchers can create new orders themselves (owners can still turn this off per person
-- in roles); fastest for phoned-in urgent work."
--
-- A narrow new permission, orders.create, instead of orders.edit (which also covers canceling, confirming anyone's
-- draft, tracking links, order documents and going ahead for a customer on credit hold). With orders.create a person:
--   * starts a new direct order (public.save_order_draft) and keeps changing their OWN draft until it is confirmed;
--   * confirms their own draft (draft -> confirmed), so the order can then be scheduled and dispatched with
--     orders.schedule as before.
-- It never: changes someone else's order, confirms someone else's draft, cancels, creates or revokes tracking links,
-- adds or removes order documents, records a credit-hold override, or prices differently (rates and discounts that
-- differ from the price list still need pricing.override, checked by save_order_draft as before). A new order for a
-- customer on credit hold is refused for them; someone with orders.edit decides (and records why) as before.
--
-- Granted by default to every role that has orders.edit (owner, office) and to the dispatcher, in the defaults for new
-- companies and in every existing company. Owners can take it away per role in Settings -> Roles and permissions.
--
-- How the two functions change: only their permission line is replaced (patched from the installed definition, so the
-- rest of each function stays exactly as reviewed and deployed):
--   save_order_draft:  orders.edit                 -> private.require_order_draft_save(p_payload)
--   set_order_status:  order_transition_permission -> private.require_order_transition(order, from, to)
-- Both helpers still accept orders.edit exactly as before, so code from before and after this migration works.
-- Reversible: supabase/rollbacks/20261120009900_dispatcher_orders.down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The permission and its defaults
-- -----------------------------------------------------------------------------
insert into public.permissions (code, category, description) values
  ('orders.create', 'Orders', 'Create new direct orders (for example one a customer phones in) and confirm your own new orders. Not changing other orders, canceling, credit-hold overrides, tracking links or prices')
on conflict (code) do nothing;

insert into public.role_permission_defaults (role, permission)
select d.role, 'orders.create' from public.role_permission_defaults d where d.permission = 'orders.edit'
union
select 'dispatcher'::public.app_role, 'orders.create'
on conflict do nothing;

-- Every existing company: the roles that hold orders.edit there today, and the dispatcher.
insert into public.role_permissions (company_id, role, permission)
select rp.company_id, rp.role, 'orders.create' from public.role_permissions rp where rp.permission = 'orders.edit'
union
select c.id, 'dispatcher'::public.app_role, 'orders.create' from public.companies c
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. Who may save a direct order draft
-- -----------------------------------------------------------------------------
-- orders.edit: anything save_order_draft allowed before. orders.create only: a new order, or the person's own direct
-- order while it is still a draft; never for a customer on credit hold (new order, or a changed customer). Only called
-- from public.save_order_draft (not granted to anyone).
create or replace function private.require_order_draft_save(p_payload jsonb)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company  uuid;
  v_order_id uuid := nullif(p_payload ->> 'order_id', '')::uuid;
  v_customer uuid := nullif(p_payload ->> 'customer_id', '')::uuid;
  v_order    public.orders%rowtype;
  v_name     text;
begin
  if private.has_permission('orders.edit') then
    return;
  end if;
  perform private.require_permission('orders.create');
  v_company := private.require_company();

  if v_order_id is not null then
    select * into v_order from public.orders where id = v_order_id and company_id = v_company;
    -- Not found: save_order_draft answers "Order not found."
    if found and (v_order.created_by is distinct from auth.uid() or v_order.status <> 'draft' or v_order.source_quote_id is not null) then
      raise exception 'Only the person who started this new order, or someone who can change orders, can change it.'
        using errcode = '42501';
    end if;
  end if;

  if v_customer is not null
     and (v_order_id is null or v_order.customer_id is distinct from v_customer)
     and exists (select 1 from private.credit_holds(v_company, array[v_customer])) then
    select c.name into v_name from public.customers c where c.id = v_customer and c.company_id = v_company;
    raise exception '% is on credit hold. A new order for them needs someone who can change orders: they decide whether to go ahead and record why.',
      coalesce(v_name, 'This customer') using errcode = '42501';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Who may move an order to another status
-- -----------------------------------------------------------------------------
-- As before (private.order_transition_permission: confirming a draft and canceling need orders.edit, every other move
-- orders.schedule), plus: a person with orders.create confirms a direct draft they started themselves. Only called from
-- public.set_order_status (not granted to anyone).
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

revoke all on function private.require_order_draft_save(jsonb) from public, anon, authenticated;
revoke all on function private.require_order_transition(uuid, public.order_status, public.order_status) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Point the two functions at the helpers (their permission line only)
-- -----------------------------------------------------------------------------
-- Each line must appear exactly once in the installed function, or the migration stops and changes nothing. Already
-- patched (re-run): left as it is.
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
    if position(v_patch.new_line in v_def) > 0 and position(v_patch.old_line in v_def) = 0 then
      continue;
    end if;
    if (length(v_def) - length(replace(v_def, v_patch.old_line, ''))) / length(v_patch.old_line) <> 1 then
      raise exception '% is not the version this migration expects (its permission line was not found exactly once).', v_patch.fn;
    end if;
    execute replace(v_def, v_patch.old_line, v_patch.new_line);
  end loop;
end;
$$;
