-- Shift offers on the right page (UX14, owner walkthrough 2026-11-04): My jobs (the shop) showed driver shift offers to
-- a person who is both a driver and in the shop. my_shift_offer_audiences returns who each of the caller's own visible
-- offers is for, so My jobs lists shop and everyone offers and My Day lists driver and everyone offers. Read-only;
-- only offers my_shift_offers already returns to the caller. Reversible: supabase/rollbacks/20261120007100_shift_offer_audience.down.sql.

create or replace function public.my_shift_offer_audiences()
returns table (id uuid, audience text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.audience
    from public.my_shift_offers() m
    join public.shift_offers o on o.id = m.id;
$$;

revoke all on function public.my_shift_offer_audiences() from public, anon;
grant execute on function public.my_shift_offer_audiences() to authenticated;
