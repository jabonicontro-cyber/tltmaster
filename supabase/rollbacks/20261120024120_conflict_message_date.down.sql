-- Rollback of 20261120024120_conflict_message_date (not a migration; run by hand with psql -v ON_ERROR_STOP=1 -f, after
-- a backup). private.resource_conflict gets its earlier body back exactly (20261014000100): the "already assigned"
-- refusal gives the times again without the day. Function only: no rows change.
begin;

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
  select format('%s is already assigned to %s load %s from %s to %s.',
                case p_kind when 'truck' then 'Truck ' || t.unit_number
                            when 'trailer' then 'Trailer ' || r.unit_number
                            else coalesce(nullif(trim(p.full_name), ''), nullif(d.name, ''), 'The driver') end,
                o.order_number, l.load_number,
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

commit;
