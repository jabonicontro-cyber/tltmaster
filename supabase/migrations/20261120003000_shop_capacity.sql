-- =============================================================================
-- Shop capacity (maintenance overhaul, owner directive 2026-10-25).
--
-- 1. public.maintenance_shop_settings: one row per company with the number of service bays, the shift start and end and
--    the shop's working days. Without it, Taviron says capacity is not configured instead of guessing.
-- 2. public.mechanic_skills: which work categories each mechanic handles (the work order categories). Optional: when a
--    company records no skills, no skill warnings are shown.
-- 3. work_orders.estimated_hours: the shop's own estimate for a job. Never invented; missing estimates are counted.
-- 4. public.maintenance_capacity(from, days): per day, the mechanic-hours available (mechanics on shift minus approved
--    time off), the estimated hours of work scheduled, jobs without an estimate, jobs versus bays, and scheduled jobs
--    no available mechanic has the skill for. A read-only view for planning; it assigns and moves nothing.
--
-- Writes go through functions (maintenance.manage); reads with maintenance.view. Reversible:
-- supabase/rollbacks/20261120003000_shop_capacity.down.sql
-- =============================================================================

create table public.maintenance_shop_settings (
  company_id   uuid primary key references public.companies (id),
  bays         integer not null check (bays between 1 and 100),
  shift_start  time not null,
  shift_end    time not null,
  work_days    integer[] not null default '{1,2,3,4,5}' check (work_days <@ '{1,2,3,4,5,6,7}' and cardinality(work_days) between 1 and 7),
  updated_by   uuid references auth.users (id) on delete set null,
  updated_at   timestamptz not null default now(),
  check (shift_end > shift_start)
);

create table public.mechanic_skills (
  company_id  uuid not null references public.companies (id),
  user_id     uuid not null,
  category    text not null check (category in (
    'preventive', 'repair', 'inspection', 'brakes', 'tires', 'engine', 'electrical', 'hydraulics', 'body', 'other')),
  primary key (company_id, user_id, category),
  foreign key (company_id, user_id) references public.company_memberships (company_id, user_id) on delete cascade
);

alter table public.work_orders add column estimated_hours numeric(6, 2) check (estimated_hours > 0 and estimated_hours <= 1000);

alter table public.maintenance_shop_settings enable row level security;
alter table public.mechanic_skills enable row level security;
create policy maintenance_shop_settings_read on public.maintenance_shop_settings for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.view')));
create policy mechanic_skills_read on public.mechanic_skills for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.view')));
revoke all on public.maintenance_shop_settings, public.mechanic_skills from anon;
grant select on public.maintenance_shop_settings, public.mechanic_skills to authenticated;

create or replace function public.maintenance_save_shop(p_bays integer, p_shift_start time, p_shift_end time, p_work_days integer[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('maintenance.manage');
  if p_bays is null or p_bays not between 1 and 100 then
    raise exception 'Enter between 1 and 100 bays.' using errcode = '22023';
  end if;
  if p_shift_start is null or p_shift_end is null or p_shift_end <= p_shift_start then
    raise exception 'The shift must end after it starts.' using errcode = '22023';
  end if;
  if p_work_days is null or cardinality(p_work_days) = 0 or not (p_work_days <@ '{1,2,3,4,5,6,7}') then
    raise exception 'Choose at least one working day.' using errcode = '22023';
  end if;
  insert into public.maintenance_shop_settings (company_id, bays, shift_start, shift_end, work_days, updated_by)
  values (v_company, p_bays, p_shift_start, p_shift_end, (select array_agg(distinct d order by d) from unnest(p_work_days) d), auth.uid())
  on conflict (company_id) do update set bays = excluded.bays, shift_start = excluded.shift_start, shift_end = excluded.shift_end,
    work_days = excluded.work_days, updated_by = auth.uid(), updated_at = now();
end;
$$;

create or replace function public.maintenance_set_skills(p_user uuid, p_categories text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('maintenance.manage');
  if not private.can_be_mechanic(v_company, p_user) then
    raise exception 'That person''s role cannot work on maintenance.' using errcode = 'P0001';
  end if;
  delete from public.mechanic_skills where company_id = v_company and user_id = p_user;
  insert into public.mechanic_skills (company_id, user_id, category)
  select distinct v_company, p_user, c from unnest(coalesce(p_categories, '{}')) c;
end;
$$;

create or replace function public.maintenance_set_estimate(p_wo uuid, p_hours numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wo public.work_orders%rowtype := private.wo_for_crew(p_wo);
begin
  if p_hours is not null and (p_hours <= 0 or p_hours > 1000) then
    raise exception 'Enter an estimate between 0 and 1,000 hours, or clear it.' using errcode = '22023';
  end if;
  update public.work_orders set estimated_hours = round(p_hours, 2), updated_by = auth.uid(), updated_at = now() where id = p_wo;
  perform private.wo_event(v_wo.company_id, p_wo, 'updated', null, null,
    case when p_hours is null then 'Estimate cleared' else format('Estimate: %s h', round(p_hours, 2)) end, jsonb_build_object('estimated_hours', p_hours));
end;
$$;

-- Planning view: per day from p_from for p_days (1–31). Read-only.
create or replace function public.maintenance_capacity(p_from date, p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_shop public.maintenance_shop_settings%rowtype;
  v_shift numeric;
  v_any_skills boolean;
  v_out jsonb := '[]'::jsonb;
  v_day date;
  v_mechanics uuid[];
  v_available numeric;
  v_row jsonb;
begin
  perform private.require_permission('maintenance.view');
  if p_from is null or p_days is null or p_days not between 1 and 31 then
    raise exception 'Choose a start date and 1 to 31 days.' using errcode = '22023';
  end if;
  select * into v_shop from public.maintenance_shop_settings where company_id = v_company;
  if not found then
    return jsonb_build_object('configured', false);
  end if;
  v_shift := extract(epoch from (v_shop.shift_end - v_shop.shift_start)) / 3600.0;
  v_any_skills := exists (select 1 from public.mechanic_skills where company_id = v_company);
  select array_agg(m.user_id) into v_mechanics from public.company_memberships m
    where m.company_id = v_company and m.active and private.can_be_mechanic(v_company, m.user_id);

  for i in 0 .. p_days - 1 loop
    v_day := p_from + i;
    with crew as (
      select u as user_id,
        -- Approved time off that day: a full day removes the shift, a partial day removes its hours (within the shift).
        coalesce((select case when bool_or(t.full_day) then v_shift
                              else least(v_shift, coalesce(sum(extract(epoch from (t.end_time - t.start_time)) / 3600.0), 0)) end
                  from public.time_off_requests t join public.employees e on e.id = t.employee_id and e.company_id = t.company_id
                  where t.company_id = v_company and e.user_id = u and t.status = 'approved' and v_day between t.start_date and t.end_date), 0) as off_hours
      from unnest(coalesce(v_mechanics, '{}')) u
    ), jobs as (
      select w.id, w.number, w.category, w.estimated_hours from public.work_orders w
      where w.company_id = v_company and w.scheduled_for = v_day and w.status not in ('completed', 'closed', 'canceled')
    )
    select jsonb_build_object(
      'date', v_day,
      'working_day', extract(isodow from v_day)::int = any(v_shop.work_days),
      'mechanics', (select count(*) from crew where off_hours < v_shift),
      'available_hours', case when extract(isodow from v_day)::int = any(v_shop.work_days)
                              then round((select coalesce(sum(v_shift - off_hours), 0) from crew)::numeric, 1) else 0 end,
      'planned_hours', round((select coalesce(sum(estimated_hours), 0) from jobs)::numeric, 1),
      'jobs', (select count(*) from jobs),
      'unestimated', (select count(*) from jobs where estimated_hours is null),
      'bays', v_shop.bays,
      'skill_gaps', case when v_any_skills then coalesce((
          select jsonb_agg(jsonb_build_object('id', j.id, 'number', j.number, 'category', j.category)) from jobs j
          where not exists (select 1 from public.mechanic_skills s join crew c on c.user_id = s.user_id and c.off_hours < v_shift
                            where s.company_id = v_company and s.category = j.category)), '[]'::jsonb) else '[]'::jsonb end
    ) into v_row;
    v_out := v_out || v_row;
  end loop;
  return jsonb_build_object('configured', true, 'bays', v_shop.bays, 'shift_start', v_shop.shift_start, 'shift_end', v_shop.shift_end,
                            'work_days', v_shop.work_days, 'skills_recorded', v_any_skills, 'days', v_out);
end;
$$;

revoke all on function public.maintenance_save_shop(integer, time, time, integer[]), public.maintenance_set_skills(uuid, text[]),
  public.maintenance_set_estimate(uuid, numeric), public.maintenance_capacity(date, integer) from public, anon;
grant execute on function public.maintenance_save_shop(integer, time, time, integer[]), public.maintenance_set_skills(uuid, text[]),
  public.maintenance_set_estimate(uuid, numeric), public.maintenance_capacity(date, integer) to authenticated;
