-- Rollback of 20261120000100_dispatch_bases (not a migration; run by hand with the owner's approval).
-- Refuses while any company uses more than its one default base (records would lose their base).
do $$
begin
  if exists (select 1 from public.dispatch_bases where not is_default) then
    raise exception 'A company has more than one dispatch base; move its records to the default base before rolling back 20261120000100.';
  end if;
end $$;

drop function if exists public.dispatch_base_summary(date, date);
drop trigger if exists companies_default_base on public.companies;
drop function if exists private.company_default_base();
drop trigger if exists trucks_default_base on public.trucks;
drop trigger if exists trailers_default_base on public.trailers;
drop trigger if exists drivers_default_base on public.drivers;
drop trigger if exists orders_default_base on public.orders;
drop function if exists private.default_base();
alter table public.trucks drop column if exists base_id;
alter table public.trailers drop column if exists base_id;
alter table public.drivers drop column if exists base_id;
alter table public.orders drop column if exists base_id;
drop function if exists public.set_default_dispatch_base(uuid);
drop table if exists public.dispatch_bases;
drop function if exists private.dispatch_base_rules();
drop function if exists private.base_limit(uuid);
alter table public.companies drop constraint if exists companies_demo_plan;
alter table public.companies drop column if exists demo_plan;
