-- =============================================================================
-- Shop parts inventory (B105, owner 2026-10-28): parts on hand, a movement ledger, parts used on work orders and
-- low-stock flags.
--
--   parts           the company's parts: number, name, unit, shelf location, quantity on hand and a reorder point
--                   (0 = no flag). On hand changes only through the functions below, never below zero.
--   part_movements  every change: received (with the unit cost when known), used on a work order, adjusted after a
--                   count (with the reason). Unit costs are readable only with maintenance.costs (column grants).
--
-- People with maintenance.view see parts and stock; maintenance.manage (owner, mechanics) adds parts, receives,
-- counts and uses parts on open work orders. Using a part with a known cost also adds a part cost line to the work
-- order (the latest received unit cost); without a known cost no cost is invented.
-- Reversible: supabase/rollbacks/20261120004500_parts_inventory.down.sql
-- =============================================================================

create table public.parts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id),
  part_number     text not null default '' check (length(part_number) <= 60),
  name            text not null check (length(trim(name)) between 1 and 160),
  unit            text not null default 'each' check (length(trim(unit)) between 1 and 20),
  location        text not null default '' check (length(location) <= 80),
  on_hand         numeric(12, 2) not null default 0 check (on_hand >= 0),
  reorder_point   numeric(12, 2) not null default 0 check (reorder_point >= 0),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, id)
);
create unique index parts_number_unique on public.parts (company_id, lower(part_number)) where part_number <> '';
create index parts_company_idx on public.parts (company_id, active, name);

create table public.part_movements (
  id               bigint generated always as identity primary key,
  company_id       uuid not null references public.companies (id),
  part_id          uuid not null,
  kind             text not null check (kind in ('received', 'used', 'adjusted')),
  quantity         numeric(12, 2) not null check (quantity <> 0),
  unit_cost_cents  bigint check (unit_cost_cents between 0 and 100000000),
  work_order_id    uuid,
  note             text not null default '' check (length(note) <= 300),
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  foreign key (company_id, part_id) references public.parts (company_id, id) on delete cascade,
  foreign key (company_id, work_order_id) references public.work_orders (company_id, id) on delete set null (work_order_id)
);
create index part_movements_part_idx on public.part_movements (part_id, created_at desc);
create index part_movements_wo_idx on public.part_movements (work_order_id) where work_order_id is not null;

alter table public.parts enable row level security;
alter table public.part_movements enable row level security;
create policy parts_read on public.parts for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.view')));
create policy part_movements_read on public.part_movements for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.view')));
revoke all on public.parts, public.part_movements from anon, authenticated;
grant select on public.parts to authenticated;
-- The unit cost is not granted: people with maintenance.costs read it through part_costs().
grant select (id, company_id, part_id, kind, quantity, work_order_id, note, created_by, created_at) on public.part_movements to authenticated;

-- A part of the caller's company, locked, for a stock change (internal; maintenance.manage).
create or replace function private.part_for_change(p_part uuid)
returns public.parts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.parts%rowtype;
begin
  perform private.require_permission('maintenance.manage');
  select * into v from public.parts where id = p_part and company_id = private.require_company() for update;
  if not found then
    raise exception 'Part not found.' using errcode = 'P0002';
  end if;
  return v;
end;
$$;
revoke all on function private.part_for_change(uuid) from public, anon, authenticated;

-- Add or edit a part (maintenance.manage). Quantity on hand is not edited here: receive or count instead.
create or replace function public.part_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_id uuid;
  v_reorder numeric := coalesce(nullif(p ->> 'reorder_point', '')::numeric, 0);
begin
  perform private.require_permission('maintenance.manage');
  if length(trim(coalesce(p ->> 'name', ''))) = 0 then
    raise exception 'Enter the part name.' using errcode = '22023';
  end if;
  if v_reorder < 0 or v_reorder > 1000000 then
    raise exception 'Enter a reorder point of 0 or more.' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.parts (company_id, part_number, name, unit, location, reorder_point)
    values (v_company, left(trim(coalesce(p ->> 'part_number', '')), 60), left(trim(p ->> 'name'), 160),
            coalesce(nullif(left(trim(coalesce(p ->> 'unit', '')), 20), ''), 'each'), left(trim(coalesce(p ->> 'location', '')), 80), v_reorder)
    returning id into v_id;
  else
    update public.parts
       set part_number = left(trim(coalesce(p ->> 'part_number', '')), 60), name = left(trim(p ->> 'name'), 160),
           unit = coalesce(nullif(left(trim(coalesce(p ->> 'unit', '')), 20), ''), 'each'), location = left(trim(coalesce(p ->> 'location', '')), 80),
           reorder_point = v_reorder, active = coalesce((p ->> 'active')::boolean, active), updated_at = now()
     where id = p_id and company_id = v_company
    returning id into v_id;
    if v_id is null then
      raise exception 'Part not found.' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
exception
  when unique_violation then
    raise exception 'Another part already has this part number.' using errcode = '23505';
end;
$$;

-- Receive stock. The unit cost is kept only from someone who may see costs (maintenance.costs); otherwise it is empty.
create or replace function public.part_receive(p_part uuid, p_quantity numeric, p_unit_cost_cents bigint, p_note text)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.parts%rowtype := private.part_for_change(p_part);
  v_cost bigint := case when private.has_permission('maintenance.costs') then p_unit_cost_cents end;
begin
  if p_quantity is null or p_quantity <= 0 or p_quantity > 1000000 then
    raise exception 'Enter how many were received.' using errcode = '22023';
  end if;
  if v_cost is not null and (v_cost < 0 or v_cost > 100000000) then
    raise exception 'Enter a unit cost of $0 or more.' using errcode = '22023';
  end if;
  insert into public.part_movements (company_id, part_id, kind, quantity, unit_cost_cents, note, created_by)
  values (v.company_id, v.id, 'received', p_quantity, v_cost, left(trim(coalesce(p_note, '')), 300), auth.uid());
  update public.parts set on_hand = on_hand + p_quantity, updated_at = now() where id = v.id;
  return v.on_hand + p_quantity;
end;
$$;

-- Record a count: on hand becomes the counted quantity, with the reason (maintenance.manage).
create or replace function public.part_count(p_part uuid, p_counted numeric, p_reason text)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.parts%rowtype := private.part_for_change(p_part);
begin
  if p_counted is null or p_counted < 0 or p_counted > 1000000 then
    raise exception 'Enter the counted quantity (0 or more).' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Enter the reason for the change.' using errcode = '22023';
  end if;
  if p_counted = v.on_hand then
    return v.on_hand;
  end if;
  insert into public.part_movements (company_id, part_id, kind, quantity, note, created_by)
  values (v.company_id, v.id, 'adjusted', p_counted - v.on_hand, left(trim(p_reason), 300), auth.uid());
  update public.parts set on_hand = p_counted, updated_at = now() where id = v.id;
  return p_counted;
end;
$$;

-- Use parts on an open work order (maintenance.manage). Never below zero. With a known cost (the latest received unit
-- cost) a part cost line is added to the work order; without one, no cost is invented.
create or replace function public.part_use(p_part uuid, p_work_order uuid, p_quantity numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.parts%rowtype := private.part_for_change(p_part);
  w public.work_orders%rowtype;
  v_cost bigint;
begin
  if p_quantity is null or p_quantity <= 0 or p_quantity > 1000000 then
    raise exception 'Enter how many were used.' using errcode = '22023';
  end if;
  select * into w from public.work_orders where id = p_work_order and company_id = v.company_id;
  if not found then
    raise exception 'Work order not found.' using errcode = 'P0002';
  end if;
  if w.status in ('completed', 'closed', 'canceled') then
    raise exception 'This work order is closed.' using errcode = '22023';
  end if;
  if p_quantity > v.on_hand then
    raise exception 'Only % % on hand.', trim(to_char(v.on_hand, 'FM999999990.##')), v.unit using errcode = '22023';
  end if;
  select m.unit_cost_cents into v_cost from public.part_movements m
   where m.part_id = v.id and m.kind = 'received' and m.unit_cost_cents is not null order by m.created_at desc, m.id desc limit 1;
  insert into public.part_movements (company_id, part_id, kind, quantity, unit_cost_cents, work_order_id, created_by)
  values (v.company_id, v.id, 'used', -p_quantity, v_cost, w.id, auth.uid());
  update public.parts set on_hand = on_hand - p_quantity, updated_at = now() where id = v.id;
  if v_cost is not null then
    insert into public.work_order_costs (company_id, work_order_id, kind, description, part_number, quantity, unit_cost_cents, created_by)
    values (v.company_id, w.id, 'part', left(v.name, 200), v.part_number, p_quantity, v_cost, auth.uid());
  end if;
  return jsonb_build_object('on_hand', v.on_hand - p_quantity, 'cost_added', v_cost is not null);
end;
$$;

-- Unit costs for people who see maintenance costs: the latest received cost per part and the stock value.
create or replace function public.part_costs()
returns table (part_id uuid, unit_cost_cents bigint, stock_value_cents bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, c.unit_cost_cents, case when c.unit_cost_cents is not null then round(p.on_hand * c.unit_cost_cents)::bigint end
    from public.parts p
    left join lateral (select m.unit_cost_cents from public.part_movements m
                        where m.part_id = p.id and m.kind = 'received' and m.unit_cost_cents is not null
                        order by m.created_at desc, m.id desc limit 1) c on true
   where p.company_id = private.current_company_id() and private.has_permission('maintenance.costs');
$$;

-- Demo samples: a small shop's shelf with one part below its reorder point and one used on an open work order
-- (demo owner only; once).
create or replace function public.demo_parts_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_part uuid;
  v_wo uuid;
  r record;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.parts where company_id = v_demo) then
    return 0;
  end if;
  for r in select * from (values
      ('LF-3000', 'Oil filter (demo)', 'each', 'Shelf A1', 6, 4, 1895),
      ('FF-5488', 'Fuel filter (demo)', 'each', 'Shelf A1', 2, 4, 4250),
      ('BS-4707', 'Brake shoe kit (demo)', 'kit', 'Shelf B2', 3, 2, 12800),
      ('15W40', 'Engine oil 15W-40 (demo)', 'gal', 'Drum rack', 55, 20, 1450),
      ('DEF-25', 'Diesel exhaust fluid (demo)', 'gal', 'Drum rack', 30, 10, 325),
      ('LT-1157', 'Tail light bulb (demo)', 'each', 'Shelf C1', 12, 5, 450)) x(num, name, unit, loc, qty, reorder, cost)
  loop
    insert into public.parts (company_id, part_number, name, unit, location, on_hand, reorder_point)
    values (v_demo, r.num, r.name, r.unit, r.loc, r.qty, r.reorder) returning id into v_part;
    insert into public.part_movements (company_id, part_id, kind, quantity, unit_cost_cents, note, created_by, created_at)
    values (v_demo, v_part, 'received', r.qty, r.cost, 'Opening stock (sample)', auth.uid(), now() - interval '20 days');
  end loop;
  -- One brake shoe kit used on an open work order, if there is one.
  select id into v_wo from public.work_orders where company_id = v_demo and status not in ('completed', 'closed', 'canceled') order by created_at limit 1;
  if v_wo is not null then
    select id into v_part from public.parts where company_id = v_demo and part_number = 'BS-4707';
    insert into public.part_movements (company_id, part_id, kind, quantity, unit_cost_cents, work_order_id, created_by)
    values (v_demo, v_part, 'used', -1, 12800, v_wo, auth.uid());
    update public.parts set on_hand = on_hand - 1 where id = v_part;
  end if;
  return 6;
end;
$$;

revoke all on function public.part_save(uuid, jsonb), public.part_receive(uuid, numeric, bigint, text), public.part_count(uuid, numeric, text),
  public.part_use(uuid, uuid, numeric), public.part_costs(), public.demo_parts_samples() from public, anon;
grant execute on function public.part_save(uuid, jsonb), public.part_receive(uuid, numeric, bigint, text), public.part_count(uuid, numeric, text),
  public.part_use(uuid, uuid, numeric), public.part_costs(), public.demo_parts_samples() to authenticated;
