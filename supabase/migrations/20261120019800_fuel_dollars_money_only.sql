-- =============================================================================
-- Fuel receipt dollars for money access only (owner decision 2026-11-12, "Money access only"; master plan §12 SEC5;
-- CLAUDE.md "Security first, above all for financial data").
--
-- Until now anyone who could read fuel purchases (fleet.view, so dispatchers and mechanics, and a driver for their own
-- receipts) could read what each receipt cost (fuel_purchases.total_cents) through the REST API. It is the only money
-- column on fuel purchases (trip sheets hold none). Now:
--   * public.fuel_purchases is readable column by column: every column except total_cents (the grant lists the columns
--     that exist when this runs; a column added later needs its own grant, see docs/SCHEMA.md). Row rules (RLS) are
--     unchanged, so gallons, odometer, state, vendor, receipt number and the IFTA summary read exactly as before.
--   * public.fuel_purchase_amounts(from, to, truck) returns the receipt totals to people with billing.view only.
--
-- Why billing.view: the owner's rule names owner, office and the outside accountant. billing.view is the one money
-- permission those three default roles hold and dispatchers, mechanics and drivers do not (accounting.view leaves out
-- the office, maintenance.costs leaves out the accountant). It is also what customer_money_terms (20261120016200) uses
-- for billing data. A Taviron support visit has the owner's permissions while the owner's grant lasts, so it sees what
-- the owner sees, never more; a demo role preview only narrows permissions in the app and the app asks for amounts
-- only when the previewed role holds billing.view.
--
-- Entering a receipt is unchanged: drivers and the office (fleet.edit) record the total through
-- public.fuel_record_purchase (security definer), never by writing the table. No rows change.
-- Reversible: supabase/rollbacks/20261120019800_fuel_dollars_money_only.down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Column-level read access
-- -----------------------------------------------------------------------------
do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
    from pg_attribute a
   where a.attrelid = 'public.fuel_purchases'::regclass and a.attnum > 0 and not a.attisdropped
     and a.attname <> 'total_cents';
  revoke select on public.fuel_purchases from authenticated;
  execute format('grant select (%s) on public.fuel_purchases to authenticated', v_cols);
end;
$$;

-- The receipt totals of the company's fuel purchases bought between p_from and p_to (one truck when p_truck is given),
-- for people who can see billing. Only receipts the person may read anyway (fleet.view or accounting.view: the
-- company's; a driver: their own), only in the person's current company; a purchase of another company is never
-- returned. Voided receipts are included (the list shows them as void).
create or replace function public.fuel_purchase_amounts(p_from date, p_to date, p_truck uuid default null)
returns table (purchase_id uuid, total_cents integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_all boolean;
  v_driver uuid;
begin
  if not private.has_permission('billing.view') then
    raise exception 'Only people who can see billing can see what fuel cost.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Choose the days to show.' using errcode = '22023';
  end if;
  v_all := private.has_permission('fleet.view') or private.has_permission('accounting.view');
  v_driver := private.my_driver_id();
  return query
    select f.id, f.total_cents
      from public.fuel_purchases f
     where f.company_id = v_company
       and f.purchased_on between p_from and p_to
       and (p_truck is null or f.truck_id = p_truck)
       and (v_all or (v_driver is not null and f.driver_id = v_driver))
     order by f.purchased_on desc, f.id;
end;
$$;

revoke all on function public.fuel_purchase_amounts(date, date, uuid) from public, anon;
grant execute on function public.fuel_purchase_amounts(date, date, uuid) to authenticated;

notify pgrst, 'reload schema';

-- Verification
do $$
begin
  if has_column_privilege('authenticated', 'public.fuel_purchases', 'total_cents', 'select')
     or has_table_privilege('authenticated', 'public.fuel_purchases', 'select')
     or not has_column_privilege('authenticated', 'public.fuel_purchases', 'gallons', 'select')
     or not has_column_privilege('authenticated', 'public.fuel_purchases', 'odometer', 'select')
     or not has_column_privilege('authenticated', 'public.fuel_purchases', 'receipt_ref', 'select') then
    raise exception 'Fuel purchase column access is not as intended.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'fuel_purchase_amounts'
      and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']))
  then
    raise exception 'fuel_purchase_amounts is not a pinned security definer function.';
  end if;
end;
$$;
