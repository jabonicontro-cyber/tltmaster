-- Rollback of 20261120000200_base_access (not a migration). Everyone regains every base; the limits are removed.
drop policy if exists trucks_base_access on public.trucks;
drop policy if exists trailers_base_access on public.trailers;
drop policy if exists drivers_base_access on public.drivers;
drop policy if exists orders_base_access on public.orders;
drop function if exists public.dispatch_base_allowance();
drop function if exists public.set_order_base(uuid, uuid);
revoke insert (base_id), update (base_id) on public.trucks, public.trailers, public.drivers from authenticated;
drop function if exists public.set_person_bases(uuid, uuid[]);
drop function if exists private.base_unrestricted();
drop function if exists private.my_bases();
drop table if exists public.base_members;
