-- Rollback of 20261120016200_customer_money_fields (financial review L1 and L4). Run with psql -v ON_ERROR_STOP=1 -1 -f.
--   * public.customers readable as a whole table again (every column, the credit limit and detention rate included).
--   * public.customer_money_terms goes (the app falls back to showing no limit or detention panel).
--   * private.customer_credit_guard: the 20261120009000 definition (credit hold and limit only), on update only.
-- No rows change.
begin;

do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
    from pg_attribute a
   where a.attrelid = 'public.customers'::regclass and a.attnum > 0 and not a.attisdropped;
  execute format('revoke select (%s) on public.customers from authenticated', v_cols);
  grant select on public.customers to authenticated;
end;
$$;

drop function if exists public.customer_money_terms(uuid[]);

create or replace function private.customer_credit_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null
     and (new.credit_hold is distinct from old.credit_hold
          or new.credit_hold_reason is distinct from old.credit_hold_reason
          or new.credit_hold_at is distinct from old.credit_hold_at
          or new.credit_hold_by is distinct from old.credit_hold_by
          or new.credit_limit_cents is distinct from old.credit_limit_cents)
     and not private.has_permission('billing.manage') then
    raise exception 'Only billing can change a customer''s credit hold or credit limit.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.customer_credit_guard() from public, anon, authenticated;
drop trigger if exists customer_credit_guard on public.customers;
create trigger customer_credit_guard before update on public.customers
  for each row execute function private.customer_credit_guard();

notify pgrst, 'reload schema';

commit;
