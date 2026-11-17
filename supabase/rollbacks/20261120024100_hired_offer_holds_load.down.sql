-- Rollback of 20261120024100_hired_offer_holds_load (not a migration; run by hand with psql -v ON_ERROR_STOP=1 -f, after
-- a backup). private.guard_hired_assignment gets its earlier body back exactly (20261120003700): the company's own
-- truck and driver can again be assigned to a load that has an open hired-truck offer. Function only: no rows change.
begin;

create or replace function private.guard_hired_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offer public.hauler_offers%rowtype;
begin
  if not exists (select 1 from public.trucks t where t.id = new.truck_id and t.hauler_id is not null)
     and not exists (select 1 from public.drivers d where d.id = new.driver_id and d.hauler_id is not null) then
    return new;
  end if;
  select * into v_offer from public.hauler_offers o where o.id::text = current_setting('tlt.hauler_offer', true);
  if not found or v_offer.load_id <> new.load_id or v_offer.truck_id <> new.truck_id or v_offer.driver_id <> new.driver_id
     or v_offer.trailer_id is distinct from new.trailer_id or v_offer.status <> 'accepted' then
    raise exception 'Not eligible: a hired truck is assigned only through an accepted offer (Hired trucks).' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_hired_assignment() from public, anon, authenticated;

commit;
