-- Rollback of 20261120019800_fuel_dollars_money_only (SEC5). Run with psql -v ON_ERROR_STOP=1 -1 -f.
--   * public.fuel_purchases readable as a whole table again (every column, the receipt total included).
--   * public.fuel_purchase_amounts goes (the app then shows no fuel amounts; gallons and IFTA are unaffected).
-- No rows change.
begin;

do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
    from pg_attribute a
   where a.attrelid = 'public.fuel_purchases'::regclass and a.attnum > 0 and not a.attisdropped;
  execute format('revoke select (%s) on public.fuel_purchases from authenticated', v_cols);
  grant select on public.fuel_purchases to authenticated;
end;
$$;

drop function if exists public.fuel_purchase_amounts(date, date, uuid);

notify pgrst, 'reload schema';

commit;
