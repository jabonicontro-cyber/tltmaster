-- =============================================================================
-- Parts on order for a work order (2026-11-09).
--
-- A job "waiting for parts" said only which part, in the status note. Now each part on order is a row:
--
--   work_order_part_waits  the part (a stock part from public.parts, or a one-off description), quantity, vendor,
--                          PO number, expected date, the expected unit cost (maintenance.costs only), and whether it
--                          is still waiting, received or canceled (with who and when).
--
-- Nothing is kept twice: on receipt a stock part goes through the parts ledger (public.part_movements: received, then
-- used on this work order, with the same cost line part_use adds), and a one-off part with a known cost becomes a part
-- cost line on the work order (public.work_order_costs). Without a known cost no cost is invented.
--
-- Lifecycle (private.wo_transition_ok): a job may wait for parts before work starts (reported, triaged or scheduled
-- -> awaiting_parts), and a job whose parts are in may go back to the queue (awaiting_parts -> triaged). Marking a part
-- received offers that: back to Scheduled when the job has a date from today on, otherwise to Triaged, once no other
-- part is still waiting. The app's NEXT_STATUSES mirrors the transitions (tests/db/maintenance.test.ts parity test).
--
-- Functions (maintenance.manage, open work orders, through private.wo_for_crew):
--   part_wait_add(work_order, p)        add a part on order; `set_waiting` also moves the job to awaiting_parts
--   part_wait_update(wait, p)           vendor, PO number, expected date (a delivery moved)
--   part_wait_receive(wait, to_queue)   received: ledger or cost line as above; optionally back to the queue
--   part_wait_cancel(wait, reason)
--   part_waits(work_order)              read (maintenance.view): a work order's parts, or every part still waiting;
--                                       the cost only for maintenance.costs
--   demo_part_wait_samples()            demo owner only, once: a part on order for the demo's waiting job
-- Additive; works with the code before and after it.
-- Reversible: supabase/rollbacks/20261120012300_parts_waiting.down.sql
-- =============================================================================

create table public.work_order_part_waits (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id),
  work_order_id    uuid not null,
  part_id          uuid,
  description      text not null check (length(trim(description)) between 1 and 160),
  part_number      text not null default '' check (length(part_number) <= 60),
  quantity         numeric(12, 2) not null default 1 check (quantity > 0 and quantity <= 1000000),
  vendor_name      text not null default '' check (length(vendor_name) <= 120),
  po_number        text not null default '' check (length(po_number) <= 60),
  expected_on      date,
  unit_cost_cents  bigint check (unit_cost_cents between 0 and 100000000),
  status           text not null default 'waiting' check (status in ('waiting', 'received', 'canceled')),
  received_at      timestamptz,
  received_by      uuid references auth.users (id) on delete set null,
  cancel_reason    text not null default '' check (length(cancel_reason) <= 300),
  submission_key   uuid,
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, work_order_id) references public.work_orders (company_id, id) on delete cascade,
  foreign key (company_id, part_id) references public.parts (company_id, id) on delete set null (part_id),
  constraint work_order_part_waits_received check ((status = 'received') = (received_at is not null))
);
create index work_order_part_waits_wo_idx on public.work_order_part_waits (company_id, work_order_id);
create index work_order_part_waits_open_idx on public.work_order_part_waits (company_id, expected_on) where status = 'waiting';
create unique index work_order_part_waits_key on public.work_order_part_waits (company_id, submission_key) where submission_key is not null;

create trigger a_company_guard before update of company_id on public.work_order_part_waits
  for each row execute function private.forbid_company_change();
create trigger work_order_part_waits_audit after insert or update or delete on public.work_order_part_waits
  for each row execute function private.audit_row_change('work_order_part_wait');

alter table public.work_order_part_waits enable row level security;
create policy work_order_part_waits_read on public.work_order_part_waits for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.view')));
revoke all on public.work_order_part_waits from anon, authenticated;
-- The expected cost is not granted: people with maintenance.costs read it through part_waits().
grant select (id, company_id, work_order_id, part_id, description, part_number, quantity, vendor_name, po_number,
  expected_on, status, received_at, received_by, cancel_reason, created_by, created_at, updated_at)
  on public.work_order_part_waits to authenticated;
grant all on public.work_order_part_waits to service_role;

-- Waiting for parts before work starts, and back to the queue when the parts are in.
CREATE OR REPLACE FUNCTION private.wo_transition_ok(p_from text, p_to text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_from
    when 'reported'       then p_to in ('triaged', 'scheduled', 'in_progress', 'awaiting_parts', 'canceled')
    when 'triaged'        then p_to in ('scheduled', 'in_progress', 'awaiting_parts', 'canceled')
    when 'scheduled'      then p_to in ('triaged', 'in_progress', 'awaiting_parts', 'canceled')
    when 'in_progress'    then p_to in ('awaiting_parts', 'awaiting_inspection', 'completed', 'scheduled', 'canceled')
    when 'awaiting_parts' then p_to in ('in_progress', 'scheduled', 'triaged', 'canceled')
    when 'completed'      then p_to in ('closed', 'in_progress')
    else false
  end;
$function$;

-- A part on order of the caller's company, locked, with its work order checked open (maintenance.manage).
create or replace function private.part_wait_for_change(p_wait uuid)
returns public.work_order_part_waits
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.work_order_part_waits%rowtype;
begin
  perform private.require_permission('maintenance.manage');
  select * into v from public.work_order_part_waits where id = p_wait and company_id = private.require_company() for update;
  if not found then
    raise exception 'Part on order not found.' using errcode = 'P0002';
  end if;
  perform private.wo_for_crew(v.work_order_id);
  if v.status <> 'waiting' then
    raise exception 'This part was already %.', v.status using errcode = 'P0001';
  end if;
  return v;
end;
$$;
revoke all on function private.part_wait_for_change(uuid) from public, anon, authenticated;

create or replace function public.part_wait_add(p_work_order uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wo    public.work_orders%rowtype := private.wo_for_crew(p_work_order);
  v_part  public.parts%rowtype;
  v_id    uuid;
  v_key   uuid := nullif(p ->> 'submission_key', '')::uuid;
  v_desc  text := left(trim(coalesce(p ->> 'description', '')), 160);
  v_qty   numeric := coalesce(nullif(p ->> 'quantity', '')::numeric, 1);
  v_date  date := nullif(p ->> 'expected_on', '')::date;
  v_cost  bigint := case when private.has_permission('maintenance.costs') then nullif(p ->> 'unit_cost_cents', '')::bigint end;
  v_today date := private.business_today(v_wo.company_id);
begin
  if v_key is not null then
    select id into v_id from public.work_order_part_waits where company_id = v_wo.company_id and submission_key = v_key;
    if found then return v_id; end if;
  end if;
  if v_wo.status in ('completed', 'awaiting_inspection') then
    raise exception 'This job is finished. Reopen it before ordering parts for it.' using errcode = 'P0001';
  end if;
  if nullif(p ->> 'part_id', '') is not null then
    select * into v_part from public.parts where id = (p ->> 'part_id')::uuid and company_id = v_wo.company_id;
    if not found then
      raise exception 'Part not found.' using errcode = 'P0002';
    end if;
    if length(v_desc) = 0 then v_desc := left(v_part.name, 160); end if;
  end if;
  if length(v_desc) = 0 then
    raise exception 'Say which part is on order.' using errcode = '22023';
  end if;
  if v_qty <= 0 or v_qty > 1000000 then
    raise exception 'Enter how many are on order.' using errcode = '22023';
  end if;
  if v_date is not null and (v_date < v_today - 365 or v_date > v_today + 365) then
    raise exception 'Enter an expected date within a year.' using errcode = '22023';
  end if;
  if v_cost is not null and (v_cost < 0 or v_cost > 100000000) then
    raise exception 'Enter a unit cost of $0 or more.' using errcode = '22023';
  end if;
  insert into public.work_order_part_waits (company_id, work_order_id, part_id, description, part_number, quantity,
    vendor_name, po_number, expected_on, unit_cost_cents, submission_key, created_by)
  values (v_wo.company_id, v_wo.id, v_part.id, v_desc,
    coalesce(nullif(left(trim(coalesce(p ->> 'part_number', '')), 60), ''), v_part.part_number, ''), v_qty,
    left(trim(coalesce(p ->> 'vendor_name', '')), 120), left(trim(coalesce(p ->> 'po_number', '')), 60), v_date, v_cost, v_key, auth.uid())
  returning id into v_id;
  perform private.wo_event(v_wo.company_id, v_wo.id, 'updated', null, null,
    'Part on order: ' || v_desc || case when length(trim(coalesce(p ->> 'vendor_name', ''))) > 0 then ' from ' || trim(p ->> 'vendor_name') else '' end
      || case when v_date is not null then ', expected ' || to_char(v_date, 'Mon FMDD') else '' end);
  if coalesce((p ->> 'set_waiting')::boolean, false) and v_wo.status in ('reported', 'triaged', 'scheduled', 'in_progress') then
    perform public.maintenance_set_status(v_wo.id, 'awaiting_parts', v_desc, null);
  end if;
  return v_id;
end;
$$;

create or replace function public.part_wait_update(p_wait uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.work_order_part_waits%rowtype := private.part_wait_for_change(p_wait);
  v_date date := case when p ? 'expected_on' then nullif(p ->> 'expected_on', '')::date else v.expected_on end;
  v_today date := private.business_today(v.company_id);
begin
  if v_date is not null and v_date is distinct from v.expected_on and (v_date < v_today - 365 or v_date > v_today + 365) then
    raise exception 'Enter an expected date within a year.' using errcode = '22023';
  end if;
  update public.work_order_part_waits set
    vendor_name = case when p ? 'vendor_name' then left(trim(coalesce(p ->> 'vendor_name', '')), 120) else vendor_name end,
    po_number = case when p ? 'po_number' then left(trim(coalesce(p ->> 'po_number', '')), 60) else po_number end,
    expected_on = v_date, updated_at = now()
  where id = v.id;
  if v_date is distinct from v.expected_on then
    perform private.wo_event(v.company_id, v.work_order_id, 'updated', null, null,
      v.description || case when v_date is null then ': expected date removed' else ': now expected ' || to_char(v_date, 'Mon FMDD') end);
  end if;
end;
$$;

-- Received. A stock part is received into the parts ledger and used on this job (the cost line part_use adds); a one-off
-- part with a known cost becomes a part cost line. With p_to_queue, once no other part is waiting, a job that waits
-- for parts goes back to the queue (Scheduled with a date from today on, otherwise Triaged).
create or replace function public.part_wait_receive(p_wait uuid, p_to_queue boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v      public.work_order_part_waits%rowtype := private.part_wait_for_change(p_wait);
  v_wo   public.work_orders%rowtype;
  v_cost bigint := v.unit_cost_cents;
  v_part public.parts%rowtype;
  v_left integer;
  v_to   text;
begin
  select * into v_wo from public.work_orders where id = v.work_order_id;
  update public.work_order_part_waits set status = 'received', received_at = now(), received_by = auth.uid(), updated_at = now()
  where id = v.id;
  if v.part_id is not null then
    select * into v_part from public.parts where id = v.part_id for update;
    insert into public.part_movements (company_id, part_id, kind, quantity, unit_cost_cents, note, created_by)
    values (v.company_id, v.part_id, 'received', v.quantity, v_cost,
      left('On order for work order ' || v_wo.number || case when v.po_number <> '' then ', PO ' || v.po_number else '' end, 300), auth.uid());
    if v_cost is null then
      select m.unit_cost_cents into v_cost from public.part_movements m
      where m.part_id = v.part_id and m.kind = 'received' and m.unit_cost_cents is not null order by m.created_at desc, m.id desc limit 1;
    end if;
    insert into public.part_movements (company_id, part_id, kind, quantity, unit_cost_cents, work_order_id, created_by)
    values (v.company_id, v.part_id, 'used', -v.quantity, v_cost, v.work_order_id, auth.uid());
    -- Received and used at once: on hand is unchanged.
    update public.parts set updated_at = now() where id = v.part_id;
    if v_cost is not null and v_wo.status not in ('closed', 'canceled') then
      insert into public.work_order_costs (company_id, work_order_id, kind, description, part_number, vendor_name, quantity, unit_cost_cents, created_by)
      values (v.company_id, v.work_order_id, 'part', left(v_part.name, 200), v_part.part_number, v.vendor_name, v.quantity, v_cost, auth.uid());
    end if;
  elsif v_cost is not null then
    insert into public.work_order_costs (company_id, work_order_id, kind, description, part_number, vendor_name, quantity, unit_cost_cents, created_by)
    values (v.company_id, v.work_order_id, 'part', left(v.description, 200), v.part_number, v.vendor_name, v.quantity, v_cost, auth.uid());
  end if;
  perform private.wo_event(v.company_id, v.work_order_id, 'updated', null, null, 'Part received: ' || v.description);

  select count(*) into v_left from public.work_order_part_waits where work_order_id = v.work_order_id and status = 'waiting';
  if p_to_queue and v_left = 0 and v_wo.status = 'awaiting_parts' then
    v_to := case when v_wo.scheduled_for is not null and v_wo.scheduled_for >= private.business_today(v.company_id) then 'scheduled' else 'triaged' end;
    perform public.maintenance_set_status(v.work_order_id, v_to, 'Parts are in.', null);
  end if;
  return jsonb_build_object('waiting', v_left, 'status', coalesce(v_to, v_wo.status), 'cost_added', v_cost is not null);
end;
$$;

create or replace function public.part_wait_cancel(p_wait uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.work_order_part_waits%rowtype := private.part_wait_for_change(p_wait);
begin
  if length(trim(coalesce(p_reason, ''))) < 2 then
    raise exception 'Say why the part is no longer on order.' using errcode = '22023';
  end if;
  update public.work_order_part_waits set status = 'canceled', cancel_reason = left(trim(p_reason), 300), updated_at = now()
  where id = v.id;
  perform private.wo_event(v.company_id, v.work_order_id, 'updated', null, null, 'Part no longer on order: ' || v.description || ' (' || left(trim(p_reason), 300) || ')');
end;
$$;

-- A work order's parts on order (every status), or with no work order every part still waiting on an open job.
create or replace function public.part_waits(p_work_order uuid default null)
returns table (id uuid, work_order_id uuid, work_order_number text, part_id uuid, description text, part_number text,
  quantity numeric, vendor_name text, po_number text, expected_on date, unit_cost_cents bigint, status text,
  received_at timestamptz, received_by uuid, cancel_reason text, created_by uuid, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_costs boolean := private.has_permission('maintenance.costs');
begin
  perform private.require_permission('maintenance.view');
  return query
    select w.id, w.work_order_id, o.number, w.part_id, w.description, w.part_number, w.quantity, w.vendor_name, w.po_number,
      w.expected_on, case when v_costs then w.unit_cost_cents end, w.status, w.received_at, w.received_by, w.cancel_reason,
      w.created_by, w.created_at
    from public.work_order_part_waits w
    join public.work_orders o on o.id = w.work_order_id
    where w.company_id = v_company
      and (case when p_work_order is null
                then w.status = 'waiting' and o.status not in ('completed', 'closed', 'canceled')
                else w.work_order_id = p_work_order end)
    order by w.status = 'waiting' desc, w.expected_on nulls last, w.created_at;
end;
$$;

-- Demo: the demo's job waiting for parts gets its part on order (a fictional vendor and PO, expected in three days),
-- and one earlier part received. Demo owner only; once.
create or replace function public.demo_part_wait_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_demo uuid := private.demo_owner_company();
  v_wo   public.work_orders%rowtype;
  v_today date;
begin
  if v_demo is null then
    raise exception 'Demo samples are only added to a demo company, by its owner.' using errcode = '42501';
  end if;
  if exists (select 1 from public.work_order_part_waits where company_id = v_demo) then
    return 0;
  end if;
  v_today := private.business_today(v_demo);
  select * into v_wo from public.work_orders where company_id = v_demo and status = 'awaiting_parts' order by created_at limit 1;
  if not found then
    return 0;
  end if;
  insert into public.work_order_part_waits (company_id, work_order_id, description, part_number, quantity, vendor_name, po_number,
    expected_on, unit_cost_cents, created_by, created_at)
  values (v_demo, v_wo.id, 'DEF level sensor (demo)', 'DEF-LS-220', 1, 'Fictional Truck Parts (demo)', 'PO-DEMO-1042',
    v_today + 3, 18650, auth.uid(), now() - interval '2 days'),
    (v_demo, v_wo.id, 'Sensor harness clip (demo)', 'HC-17', 2, 'Fictional Truck Parts (demo)', 'PO-DEMO-1042',
    v_today + 3, 425, auth.uid(), now() - interval '2 days');
  return 2;
end;
$$;

revoke all on function public.part_wait_add(uuid, jsonb), public.part_wait_update(uuid, jsonb), public.part_wait_receive(uuid, boolean),
  public.part_wait_cancel(uuid, text), public.part_waits(uuid), public.demo_part_wait_samples() from public, anon;
grant execute on function public.part_wait_add(uuid, jsonb), public.part_wait_update(uuid, jsonb), public.part_wait_receive(uuid, boolean),
  public.part_wait_cancel(uuid, text), public.part_waits(uuid), public.demo_part_wait_samples() to authenticated;
