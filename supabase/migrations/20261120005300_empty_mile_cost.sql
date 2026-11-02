-- =============================================================================
-- Cost per empty mile (B113, owner 2026-11-02: profit-aware dispatch ranks trucks by empty miles).
-- Smart Dispatch estimates straight-line empty miles from each truck's previous drop (or the yard) to a load's job
-- site and prefers the truck with fewer; this rate turns those miles into an estimated cost for people who see billing.
-- Null = not set (miles still rank; no dollar figure). billing.manage sets it, like the other cost rates (B104).
-- Reversible: supabase/rollbacks/20261120005300_empty_mile_cost.down.sql
-- =============================================================================

alter table public.company_cost_rates add column empty_mile_cents integer check (empty_mile_cents is null or empty_mile_cents between 0 and 100000);

create or replace function public.set_empty_mile_cost(p_cents integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('billing.manage');
  if p_cents is not null and p_cents not between 0 and 100000 then
    raise exception 'Enter a cost per mile from $0 to $1,000, or leave it empty.' using errcode = '22023';
  end if;
  insert into public.company_cost_rates (company_id, empty_mile_cents, updated_by) values (v_company, p_cents, auth.uid())
  on conflict (company_id) do update set empty_mile_cents = excluded.empty_mile_cents, updated_by = auth.uid(), updated_at = now();
  perform private.log_event('cost_rates.empty_mile', 'company', v_company,
    case when p_cents is null then 'Cost per empty mile cleared' else format('Cost per empty mile set to $%s', to_char(p_cents / 100.0, 'FM999,990.00')) end,
    jsonb_build_object('empty_mile_cents', p_cents));
end;
$$;

revoke all on function public.set_empty_mile_cost(integer) from public, anon;
grant execute on function public.set_empty_mile_cost(integer) to authenticated;

-- Demo sample: a fictional $1.25 per empty mile, so Smart Dispatch shows an estimated cost next to empty miles in
-- demos. Only fills an empty value; refused for real companies.
create or replace function public.demo_empty_mile_cost()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.company_cost_rates where company_id = v_demo and empty_mile_cents is not null) then
    return 0;
  end if;
  insert into public.company_cost_rates (company_id, empty_mile_cents) values (v_demo, 125)
  on conflict (company_id) do update set empty_mile_cents = 125;
  return 1;
end;
$$;
revoke all on function public.demo_empty_mile_cost() from public, anon;
grant execute on function public.demo_empty_mile_cost() to authenticated;
