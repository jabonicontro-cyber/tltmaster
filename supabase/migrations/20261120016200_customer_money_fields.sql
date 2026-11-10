-- =============================================================================
-- Customer money fields (financial review 2026-11-09, L1 and L4; master plan §12 SEC4; CLAUDE.md "Security first,
-- above all for financial data").
--
-- L1: a customer's credit limit and detention rate are billing data. Until now anyone who could read customers
-- (customers.view or quotes.view, so dispatchers) could read both through the REST API. Now:
--   * public.customers is readable column by column: every column except credit_limit_cents and detention_rate_cents
--     (the grant lists the columns that exist when this runs; a column added later needs its own grant, see
--     docs/SCHEMA.md). Row rules (RLS) are unchanged.
--   * public.customer_money_terms(customers) returns the credit limit, free time and detention rate to people with
--     billing.view only.
-- L4: changing a customer's price list or tax exemption needs pricing.edit; payment terms and detention (rate and free
-- time) need billing.manage (they needed only customers.edit). The same on a new customer: a price list or tax
-- exemption needs pricing.edit, payment terms or detention billing.manage, and a credit hold or limit billing.manage.
-- private.customer_credit_guard (20261120009000) is extended and now also runs on insert. Changes made by the database
-- itself (no signed-in person) are not affected, as before.
--
-- No rows change. Reversible: supabase/rollbacks/20261120016200_customer_money_fields.down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- L1. Column-level read access
-- -----------------------------------------------------------------------------
do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
    from pg_attribute a
   where a.attrelid = 'public.customers'::regclass and a.attnum > 0 and not a.attisdropped
     and a.attname not in ('credit_limit_cents', 'detention_rate_cents');
  revoke select on public.customers from authenticated;
  execute format('grant select (%s) on public.customers to authenticated', v_cols);
end;
$$;

-- The credit limit, free time and detention rate of the company's customers (all of them when p_customers is null), for
-- people who can see billing. A customer of another company is never returned.
create or replace function public.customer_money_terms(p_customers uuid[] default null)
returns table (customer_id uuid, credit_limit_cents bigint, detention_free_minutes integer, detention_rate_cents integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if not private.has_permission('billing.view') then
    raise exception 'Only people who can see billing can see credit limits and detention rates.' using errcode = '42501';
  end if;
  return query
    select c.id, c.credit_limit_cents, c.detention_free_minutes, c.detention_rate_cents
      from public.customers c
     where c.company_id = v_company and (p_customers is null or c.id = any (p_customers))
     order by c.name;
end;
$$;

revoke all on function public.customer_money_terms(uuid[]) from public, anon;
grant execute on function public.customer_money_terms(uuid[]) to authenticated;

-- -----------------------------------------------------------------------------
-- L4. Who may change a customer's money fields
-- -----------------------------------------------------------------------------
create or replace function private.customer_credit_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if (new.credit_hold is distinct from old.credit_hold
        or new.credit_hold_reason is distinct from old.credit_hold_reason
        or new.credit_hold_at is distinct from old.credit_hold_at
        or new.credit_hold_by is distinct from old.credit_hold_by
        or new.credit_limit_cents is distinct from old.credit_limit_cents)
       and not private.has_permission('billing.manage') then
      raise exception 'Only billing can change a customer''s credit hold or credit limit.' using errcode = '42501';
    end if;
    if (new.price_list_id is distinct from old.price_list_id or new.tax_exempt is distinct from old.tax_exempt)
       and not private.has_permission('pricing.edit') then
      raise exception 'Only someone who can edit prices can change a customer''s price list or sales tax exemption.' using errcode = '42501';
    end if;
    if (new.payment_terms is distinct from old.payment_terms
        or new.detention_rate_cents is distinct from old.detention_rate_cents
        or new.detention_free_minutes is distinct from old.detention_free_minutes)
       and not private.has_permission('billing.manage') then
      raise exception 'Only billing can change a customer''s payment terms or detention charge.' using errcode = '42501';
    end if;
  else
    if (new.credit_hold or new.credit_limit_cents is not null) and not private.has_permission('billing.manage') then
      raise exception 'Only billing can put a customer on credit hold or set a credit limit.' using errcode = '42501';
    end if;
    if (new.price_list_id is not null or new.tax_exempt) and not private.has_permission('pricing.edit') then
      raise exception 'Only someone who can edit prices can give a customer a price list or a sales tax exemption.' using errcode = '42501';
    end if;
    if (coalesce(new.payment_terms, '') <> '' or new.detention_rate_cents is not null or new.detention_free_minutes is not null)
       and not private.has_permission('billing.manage') then
      raise exception 'Only billing can set a customer''s payment terms or detention charge.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.customer_credit_guard() from public, anon, authenticated;

drop trigger if exists customer_credit_guard on public.customers;
create trigger customer_credit_guard before insert or update on public.customers
  for each row execute function private.customer_credit_guard();

notify pgrst, 'reload schema';

-- Verification
do $$
begin
  if has_column_privilege('authenticated', 'public.customers', 'credit_limit_cents', 'select')
     or has_column_privilege('authenticated', 'public.customers', 'detention_rate_cents', 'select')
     or not has_column_privilege('authenticated', 'public.customers', 'name', 'select')
     or not has_column_privilege('authenticated', 'public.customers', 'credit_hold', 'select') then
    raise exception 'Customer column access is not as intended.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname, p.proname) in (('public', 'customer_money_terms'), ('private', 'customer_credit_guard'))
      and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']))
  then
    raise exception 'A new or changed function is not a pinned security definer function.';
  end if;
end;
$$;
