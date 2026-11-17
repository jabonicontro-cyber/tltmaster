-- =============================================================================
-- The "already assigned" refusal names the day (first-day dispatcher walkthrough 2026-11-14, finding D2).
--
-- When a truck, trailer or driver is already booked at an overlapping time, assign_load (and through it Smart Dispatch,
-- Plan the day, hired-truck offers and their confirmation) refuses with private.resource_conflict's sentence. It gave
-- the times but not the day, so "Truck H-21 is already assigned to ORD-1008 load 3 from 7:30 AM to 9:00 AM." could not
-- be found on the board when the clash was on another day. The sentence now says the day, in the company's time zone:
--   "Truck H-21 is already assigned to ORD-1008 load 3 on Sun, Nov 15 from 7:30 AM to 9:00 AM."
-- Everything else is the installed definition (20261014000100), unchanged: the same overlap rule, the same first
-- conflict, the same names. Function only: no tables, no rows.
-- Reversible: supabase/rollbacks/20261120024120_conflict_message_date.down.sql
-- =============================================================================

create or replace function private.resource_conflict(
  p_company uuid,
  p_kind text,
  p_resource_id uuid,
  p_starts timestamptz,
  p_ends timestamptz,
  p_except uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select format('%s is already assigned to %s load %s on %s from %s to %s.',
                case p_kind when 'truck' then 'Truck ' || t.unit_number
                            when 'trailer' then 'Trailer ' || r.unit_number
                            else coalesce(nullif(trim(p.full_name), ''), nullif(d.name, ''), 'The driver') end,
                o.order_number, l.load_number,
                to_char(a.starts_at at time zone private.business_timezone(p_company), 'Dy, Mon FMDD'),
                private.local_time_label(p_company, a.starts_at), private.local_time_label(p_company, a.ends_at))
  from public.dispatch_assignments a
  join public.order_loads l on l.id = a.load_id
  join public.orders o on o.id = a.order_id
  join public.trucks t on t.id = a.truck_id
  left join public.trailers r on r.id = a.trailer_id
  join public.drivers d on d.id = a.driver_id
  left join public.profiles p on p.id = d.user_id
  where a.company_id = p_company
    and a.status = 'active'
    and a.id is distinct from p_except
    and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(p_starts, p_ends, '[)')
    and case p_kind when 'truck' then a.truck_id when 'trailer' then a.trailer_id else a.driver_id end = p_resource_id
  order by a.starts_at
  limit 1
$$;
