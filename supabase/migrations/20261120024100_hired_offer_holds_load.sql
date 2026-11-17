-- =============================================================================
-- An open hired-truck offer holds its load (first-day dispatcher walkthrough 2026-11-14, finding D1: blocker).
--
-- After a hauler accepted an offer (by phone or on My Day), nothing stopped the company's own truck and driver from
-- being assigned to the same load: Smart Dispatch proposed the own crew and the database accepted it, so the hauler and
-- the own truck could both go. private.guard_hired_assignment (20261120003700) only checked assignments that use a
-- hired truck or driver.
--
-- Now the same trigger also refuses an assignment with the company's own truck and driver while the load has an open
-- offer (offered, or accepted and waiting for dispatch to confirm it), with the next step:
--   "ORD-1010 load 1 is offered to a hired truck (Ridgeline Hauling). Withdraw the offer in Hired trucks before giving
--    the load to your own crew."  (hint 'hauler_offer')
-- Confirming the offer (public.hauler_offer_confirm) is unchanged: it assigns the hired truck through assign_load, and
-- the offer it confirms is the open one. A load whose offer was declined, withdrawn or confirmed is not held.
--
-- Every path that puts a truck on a load inserts into public.dispatch_assignments (assign_load, assign_load_off_shift,
-- Plan the day, Smart Dispatch, truck-for-the-day slots), so the trigger covers them all. The rest of the function is
-- the installed definition, unchanged. Function only: no tables, no rows.
-- Reversible: supabase/rollbacks/20261120024100_hired_offer_holds_load.down.sql
-- =============================================================================

create or replace function private.guard_hired_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offer public.hauler_offers%rowtype;
  v_open  record;
begin
  if not exists (select 1 from public.trucks t where t.id = new.truck_id and t.hauler_id is not null)
     and not exists (select 1 from public.drivers d where d.id = new.driver_id and d.hauler_id is not null) then
    -- The company's own crew: refused while a hired truck holds the load through an open offer (D1).
    select o.order_number, l.load_number, h.name as hauler
      into v_open
      from public.hauler_offers x
      join public.order_loads l on l.id = x.load_id
      join public.orders o on o.id = l.order_id
      join public.haulers h on h.id = x.hauler_id
     where x.load_id = new.load_id and x.company_id = new.company_id and x.status in ('offered', 'accepted')
     limit 1;
    if found then
      raise exception '% load % is offered to a hired truck (%). Withdraw the offer in Hired trucks before giving the load to your own crew.',
        v_open.order_number, v_open.load_number, v_open.hauler
        using hint = 'hauler_offer';
    end if;
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
