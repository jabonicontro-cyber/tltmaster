-- Driver scorecard (master plan B96, owner 2026-10-27): measured only from records, per driver, over a period.
--   loads        loads with a current delivery ticket by the driver, delivered in the period (company time zone)
--   on_time      of those, delivered by the end of the load's planned window
--   own_tickets  tickets the driver entered (driver's phone), and same_day: entered on the delivery day
--   reports      problems the driver reported (delay, breakdown, equipment, inspection, cannot complete)
-- Who sees what (owner decision): a driver sees only their own row; people with dispatch or employee access see all
-- drivers. No ranking is computed. Read-only; nothing is stored.

create or replace function public.driver_scorecard(p_from date, p_to date, p_mine boolean default false)
returns table (
  driver_id uuid,
  driver_name text,
  loads integer,
  on_time integer,
  own_tickets integer,
  same_day integer,
  reports integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  -- p_mine: only the caller's own row, for their My Day (a manager who also drives).
  v_all boolean := not coalesce(p_mine, false) and (private.has_permission('dispatch.view') or private.has_permission('employees.view'));
  v_me uuid := private.my_driver_id();
  v_tz text;
begin
  if v_company is null then
    raise exception 'Not signed in to a company.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'Choose a period of up to one year.' using errcode = '22023';
  end if;
  if not v_all and v_me is null then
    return;
  end if;
  select coalesce(s.timezone, 'America/Chicago') into v_tz from public.company_settings s where s.company_id = v_company;
  v_tz := coalesce(v_tz, 'America/Chicago');

  return query
  with t as (
    select dt.driver_id, dt.load_id, dt.delivered_at, dt.created_at, dt.created_by
      from public.delivery_tickets dt
     where dt.company_id = v_company
       and dt.status in ('submitted', 'needs_review', 'accepted')
       and (dt.delivered_at at time zone v_tz)::date between p_from and p_to
       and (v_all or dt.driver_id = v_me)
  ), per_load as (
    select t.driver_id, t.load_id, min(t.delivered_at) as delivered_at
      from t group by t.driver_id, t.load_id
  ), r as (
    select fr.driver_id, count(*)::int as n
      from public.field_reports fr
     where fr.company_id = v_company
       and (fr.created_at at time zone v_tz)::date between p_from and p_to
       and (v_all or fr.driver_id = v_me)
     group by fr.driver_id
  )
  select d.id, d.name,
         coalesce((select count(*)::int from per_load pl where pl.driver_id = d.id), 0),
         coalesce((select count(*)::int from per_load pl join public.order_loads l on l.id = pl.load_id
                    where pl.driver_id = d.id
                      and pl.delivered_at <= ((l.load_date + coalesce(l.end_time, time '23:59')) at time zone v_tz)), 0),
         coalesce((select count(*)::int from t where t.driver_id = d.id and d.user_id is not null and t.created_by = d.user_id), 0),
         coalesce((select count(*)::int from t where t.driver_id = d.id and d.user_id is not null and t.created_by = d.user_id
                      and (t.created_at at time zone v_tz)::date = (t.delivered_at at time zone v_tz)::date), 0),
         coalesce((select r.n from r where r.driver_id = d.id), 0)
    from public.drivers d
   where d.company_id = v_company
     and (v_all or d.id = v_me)
     and (d.active or exists (select 1 from per_load pl where pl.driver_id = d.id))
   order by d.name;
end;
$$;

revoke all on function public.driver_scorecard(date, date, boolean) from public, anon;
grant execute on function public.driver_scorecard(date, date, boolean) to authenticated;
