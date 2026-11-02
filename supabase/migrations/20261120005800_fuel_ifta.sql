-- B130 fuel and IFTA (owner 2026-11-02: miles per state come from the driver's daily trip sheet). Fuel purchases and
-- trip sheets per truck, entered by the driver (for a truck they drove that day, or their own truck) or by the office
-- (fleet.edit); the quarterly IFTA summary is computed from them in the app. Tax rates are not stored: they change each
-- quarter and the company applies the official ones. Non-destructive: new tables and functions only.

create table public.fuel_purchases (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id),
  truck_id      uuid not null,
  driver_id     uuid,
  purchased_on  date not null,
  jurisdiction  text not null check (jurisdiction ~ '^[A-Z]{2}$'),
  gallons       numeric(10, 3) not null check (gallons > 0 and gallons <= 2000),
  total_cents   integer not null check (total_cents >= 0 and total_cents <= 10000000),
  odometer      integer check (odometer is null or odometer between 0 and 9999999),
  vendor        text not null default '' check (length(vendor) <= 120),
  receipt_ref   text not null default '' check (length(receipt_ref) <= 80),
  voided        boolean not null default false,
  void_reason   text not null default '' check (length(void_reason) <= 300),
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  foreign key (company_id, truck_id) references public.trucks (company_id, id),
  foreign key (company_id, driver_id) references public.drivers (company_id, id)
);
create index fuel_purchases_company_day on public.fuel_purchases (company_id, purchased_on);

create table public.trip_sheets (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id),
  truck_id        uuid not null,
  driver_id       uuid,
  sheet_date      date not null,
  start_odometer  integer not null check (start_odometer between 0 and 9999999),
  end_odometer    integer not null check (end_odometer between 0 and 9999999),
  -- [{"jurisdiction":"IA","miles":120}, …]: miles per state, summing to end − start.
  legs            jsonb not null,
  voided          boolean not null default false,
  void_reason     text not null default '' check (length(void_reason) <= 300),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  check (end_odometer >= start_odometer and end_odometer - start_odometer <= 2000),
  foreign key (company_id, truck_id) references public.trucks (company_id, id),
  foreign key (company_id, driver_id) references public.drivers (company_id, id)
);
create unique index trip_sheets_one_per_truck_day on public.trip_sheets (truck_id, sheet_date) where not voided;
create index trip_sheets_company_day on public.trip_sheets (company_id, sheet_date);

alter table public.fuel_purchases enable row level security;
alter table public.trip_sheets enable row level security;
-- Office and fleet staff read everything; a driver reads their own entries.
create policy fuel_purchases_read on public.fuel_purchases for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('fleet.view')) or driver_id = (select private.my_driver_id())));
create policy trip_sheets_read on public.trip_sheets for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('fleet.view')) or driver_id = (select private.my_driver_id())));
revoke all on public.fuel_purchases, public.trip_sheets from anon;
grant select on public.fuel_purchases, public.trip_sheets to authenticated;

-- Who may record for a truck on a day: fleet editors always; a driver for a truck they were assigned that day or their
-- own (primary) truck. Returns the driver id to record (the driver themself, or null for the office).
create or replace function private.fuel_writer(p_company uuid, p_truck uuid, p_day date)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_driver uuid;
begin
  if not exists (select 1 from public.trucks where id = p_truck and company_id = p_company) then
    raise exception 'Truck not found.' using errcode = 'P0002';
  end if;
  if private.has_permission('fleet.edit') then
    return null;
  end if;
  v_driver := private.my_driver_id();
  if v_driver is null or not (
       exists (select 1 from public.drivers d where d.id = v_driver and d.primary_truck_id = p_truck)
    or exists (select 1 from public.dispatch_assignments a join public.order_loads l on l.id = a.load_id
               where a.company_id = p_company and a.driver_id = v_driver and a.truck_id = p_truck and l.load_date = p_day and a.status <> 'canceled')) then
    raise exception 'You can record fuel and trip sheets only for a truck you drove that day.' using errcode = '42501';
  end if;
  return v_driver;
end;
$$;
revoke all on function private.fuel_writer(uuid, uuid, date) from public, anon, authenticated;

create or replace function public.fuel_record_purchase(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_truck uuid := nullif(p ->> 'truck_id', '')::uuid;
  v_day date := nullif(p ->> 'purchased_on', '')::date;
  v_driver uuid;
  v_id uuid;
begin
  if v_day is null or v_day > private.company_today(v_company) or v_day < private.company_today(v_company) - 120 then
    raise exception 'Enter the day of the purchase (up to 120 days back, not in the future).' using errcode = '22023';
  end if;
  v_driver := private.fuel_writer(v_company, v_truck, v_day);
  if coalesce(p ->> 'jurisdiction', '') !~ '^[A-Z]{2}$' then
    raise exception 'Choose the state or province where you bought the fuel.' using errcode = '22023';
  end if;
  insert into public.fuel_purchases (company_id, truck_id, driver_id, purchased_on, jurisdiction, gallons, total_cents, odometer, vendor, receipt_ref, created_by)
  values (v_company, v_truck, v_driver, v_day, p ->> 'jurisdiction', (p ->> 'gallons')::numeric, (p ->> 'total_cents')::integer,
          nullif(p ->> 'odometer', '')::integer, private.clean_text(p ->> 'vendor', 120, 'Vendor'), private.clean_text(p ->> 'receipt_ref', 80, 'Receipt'), auth.uid())
  returning id into v_id;
  perform private.log_event('fuel.purchase', 'fuel_purchase', v_id, format('Fuel: %s gal in %s', p ->> 'gallons', p ->> 'jurisdiction'), '{}'::jsonb);
  return v_id;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Check the gallons and the amount.' using errcode = '22023';
  when check_violation then
    raise exception 'Gallons must be more than 0 and the amount $0 or more.' using errcode = '22023';
end;
$$;

-- A day's trip sheet for one truck: start and end odometer and the miles in each state, which must add up.
create or replace function public.fuel_record_trip_sheet(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_truck uuid := nullif(p ->> 'truck_id', '')::uuid;
  v_day date := nullif(p ->> 'sheet_date', '')::date;
  v_start integer := nullif(p ->> 'start_odometer', '')::integer;
  v_end integer := nullif(p ->> 'end_odometer', '')::integer;
  v_legs jsonb := coalesce(p -> 'legs', '[]'::jsonb);
  v_sum integer;
  v_driver uuid;
  v_id uuid;
begin
  if v_day is null or v_day > private.company_today(v_company) or v_day < private.company_today(v_company) - 120 then
    raise exception 'Enter the day of the trip sheet (up to 120 days back, not in the future).' using errcode = '22023';
  end if;
  v_driver := private.fuel_writer(v_company, v_truck, v_day);
  if v_start is null or v_end is null or v_end < v_start or v_end - v_start > 2000 then
    raise exception 'Enter the odometer at the start and end of the day (end not lower than start).' using errcode = '22023';
  end if;
  if jsonb_typeof(v_legs) <> 'array' or jsonb_array_length(v_legs) = 0 or jsonb_array_length(v_legs) > 12
     or exists (select 1 from jsonb_array_elements(v_legs) e where coalesce(e ->> 'jurisdiction', '') !~ '^[A-Z]{2}$' or coalesce(e ->> 'miles', '') !~ '^\d{1,4}$') then
    raise exception 'List each state you drove in with its miles.' using errcode = '22023';
  end if;
  if (select count(distinct e ->> 'jurisdiction') from jsonb_array_elements(v_legs) e) <> jsonb_array_length(v_legs) then
    raise exception 'List each state once.' using errcode = '22023';
  end if;
  select sum((e ->> 'miles')::integer) into v_sum from jsonb_array_elements(v_legs) e;
  if v_sum <> v_end - v_start then
    raise exception 'The miles per state (%) must add up to the odometer difference (%).', v_sum, v_end - v_start using errcode = '22023';
  end if;
  if exists (select 1 from public.trip_sheets where truck_id = v_truck and sheet_date = v_day and not voided) then
    raise exception 'This truck already has a trip sheet for that day. Void it first to replace it.' using errcode = '23505';
  end if;
  insert into public.trip_sheets (company_id, truck_id, driver_id, sheet_date, start_odometer, end_odometer, legs, created_by)
  values (v_company, v_truck, v_driver, v_day, v_start, v_end, v_legs, auth.uid())
  returning id into v_id;
  perform private.log_event('fuel.trip_sheet', 'trip_sheet', v_id, format('Trip sheet: %s miles', v_end - v_start), '{}'::jsonb);
  return v_id;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Check the odometer readings.' using errcode = '22023';
end;
$$;

-- The office voids a wrong entry with a reason (never deleted).
create or replace function public.fuel_void(p_kind text, p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_reason text := private.clean_text(p_reason, 300, 'Reason');
begin
  perform private.require_permission('fleet.edit');
  if length(v_reason) = 0 then raise exception 'Say why it is voided.' using errcode = '22023'; end if;
  if p_kind = 'purchase' then
    update public.fuel_purchases set voided = true, void_reason = v_reason where id = p_id and company_id = v_company and not voided;
  elsif p_kind = 'trip_sheet' then
    update public.trip_sheets set voided = true, void_reason = v_reason where id = p_id and company_id = v_company and not voided;
  else
    raise exception 'Unknown entry.' using errcode = '22023';
  end if;
  if not found then raise exception 'Entry not found.' using errcode = 'P0002'; end if;
  perform private.log_event('fuel.void', p_kind, p_id, format('Fuel record voided: %s', v_reason), '{}'::jsonb);
end;
$$;

-- The trucks the signed-in driver may record for on a day (their own truck and the ones they drove), with whether
-- that day's trip sheet is already in. For My Day.
create or replace function public.fuel_my_trucks(p_day date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'unit', t.unit_number,
           'sheet_done', exists (select 1 from public.trip_sheets s where s.truck_id = t.id and s.sheet_date = p_day and not s.voided)) order by t.unit_number), '[]'::jsonb)
  from public.trucks t
  where t.company_id = private.current_company_id() and private.my_driver_id() is not null
    and (t.id = (select d.primary_truck_id from public.drivers d where d.id = private.my_driver_id())
         or exists (select 1 from public.dispatch_assignments a join public.order_loads l on l.id = a.load_id
                    where a.driver_id = private.my_driver_id() and a.truck_id = t.id and l.load_date = p_day and a.status <> 'canceled'));
$$;

-- Demo sample: a quarter's worth of fictional fuel purchases and trip sheets for two of the demo's trucks, mostly in the
-- company's home state with a few out-of-state days, so the IFTA summary has data. Added once.
create or replace function public.demo_fuel_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_today date;
  v_truck record;
  v_day date;
  v_odo integer;
  v_n integer := 0;
  v_i integer;
  v_home text;
  v_other text;
  v_miles integer;
  v_out integer;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.trip_sheets where company_id = v_demo) then
    return 0;
  end if;
  v_today := private.company_today(v_demo);
  v_home := coalesce(nullif(upper((select state from public.company_settings where company_id = v_demo)), ''), 'IA');
  if v_home !~ '^[A-Z]{2}$' then v_home := 'IA'; end if;
  v_other := case v_home when 'IA' then 'NE' when 'NE' then 'IA' when 'IL' then 'IN' else 'IA' end;
  for v_truck in select id, row_number() over (order by unit_number) as rn from public.trucks
                 where company_id = v_demo and active and hauler_id is null order by unit_number limit 2 loop
    v_odo := 184000 + (v_truck.rn::integer * 23417);
    for v_i in 1..40 loop
      v_day := v_today - (v_i * 2);
      continue when extract(isodow from v_day) > 5;
      v_miles := 90 + ((v_i * 37 + v_truck.rn::integer * 11) % 110);
      v_out := case when v_i % 5 = 2 then 35 + (v_i % 40) else 0 end;
      insert into public.trip_sheets (company_id, truck_id, sheet_date, start_odometer, end_odometer, legs, created_by)
      values (v_demo, v_truck.id, v_day, v_odo, v_odo + v_miles + v_out,
              case when v_out > 0 then jsonb_build_array(jsonb_build_object('jurisdiction', v_home, 'miles', v_miles), jsonb_build_object('jurisdiction', v_other, 'miles', v_out))
                   else jsonb_build_array(jsonb_build_object('jurisdiction', v_home, 'miles', v_miles)) end, auth.uid());
      v_odo := v_odo + v_miles + v_out;
      v_n := v_n + 1;
      if v_i % 3 = 0 then
        insert into public.fuel_purchases (company_id, truck_id, purchased_on, jurisdiction, gallons, total_cents, odometer, vendor, receipt_ref, created_by)
        values (v_demo, v_truck.id, v_day, case when v_i % 21 = 0 then v_other else v_home end, 78 + (v_i % 25), (78 + (v_i % 25)) * 389, v_odo,
                'Demo Fuel Stop (fictional)', format('DEMO-%s', v_i), auth.uid());
        v_n := v_n + 1;
      end if;
    end loop;
  end loop;
  return v_n;
end;
$$;

revoke all on function public.fuel_record_purchase(jsonb) from public, anon;
revoke all on function public.fuel_record_trip_sheet(jsonb) from public, anon;
revoke all on function public.fuel_void(text, uuid, text) from public, anon;
revoke all on function public.demo_fuel_samples() from public, anon;
revoke all on function public.fuel_my_trucks(date) from public, anon;
grant execute on function public.fuel_my_trucks(date) to authenticated;
grant execute on function public.fuel_record_purchase(jsonb) to authenticated;
grant execute on function public.fuel_record_trip_sheet(jsonb) to authenticated;
grant execute on function public.fuel_void(text, uuid, text) to authenticated;
grant execute on function public.demo_fuel_samples() to authenticated;
