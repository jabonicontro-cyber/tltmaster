-- =============================================================================
-- Maintenance crews, labor time and task checklists (maintenance overhaul, owner directive 2026-10-25).
--
-- 1. public.work_order_mechanics: everyone working a work order. One lead (kept equal to work_orders.assigned_to, so
--    existing screens and filters keep working) and any number of assisting mechanics, each with their own status
--    (assigned, working, paused, done). Only people whose role can manage maintenance can be on a crew.
-- 2. public.work_order_time_entries: labor as time ranges per mechanic. The database refuses overlapping time for the
--    same person (one person cannot be on two jobs at once, nor log the same hour twice) and allows one running timer
--    per person. Entries are never deleted: a mistake is voided with a reason. work_orders.labor_hours becomes the sum
--    of the work order's valid entries whenever it has any, so labor is counted once, from one source.
-- 3. public.work_order_tasks: an ordered checklist per work order.
-- 4. A work order cannot be sent for inspection, completed, closed or canceled while a timer is running on it.
--
-- Writes go through the functions below (maintenance.manage, checked again here); reads use maintenance.view (RLS).
-- Every change is recorded in work_order_events. Reversible:
-- supabase/rollbacks/20261120002900_maintenance_crew.down.sql
-- =============================================================================

alter table public.work_order_events drop constraint work_order_events_kind_check;
alter table public.work_order_events add constraint work_order_events_kind_check check (kind in (
  'created', 'updated', 'status', 'assigned', 'scheduled', 'rescheduled', 'unscheduled', 'canceled',
  'inspection_started', 'inspection_failed', 'cleared', 'restricted', 'returned_to_service',
  'crew', 'time', 'task'));

-- 1. Crew ------------------------------------------------------------------------------------------------------------
create table public.work_order_mechanics (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id),
  work_order_id  uuid not null,
  user_id        uuid not null,
  role           text not null default 'assist' check (role in ('lead', 'assist')),
  status         text not null default 'assigned' check (status in ('assigned', 'working', 'paused', 'done')),
  added_by       uuid references auth.users (id) on delete set null,
  added_at       timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (work_order_id, user_id),
  foreign key (company_id, work_order_id) references public.work_orders (company_id, id) on delete cascade,
  foreign key (company_id, user_id) references public.company_memberships (company_id, user_id) on delete cascade
);
create unique index work_order_mechanics_one_lead on public.work_order_mechanics (work_order_id) where role = 'lead';
create index work_order_mechanics_user on public.work_order_mechanics (company_id, user_id, status);

-- 2. Time ------------------------------------------------------------------------------------------------------------
create table public.work_order_time_entries (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id),
  work_order_id  uuid not null,
  user_id        uuid not null,
  started_at     timestamptz not null,
  ended_at       timestamptz,
  source         text not null default 'timer' check (source in ('timer', 'manual')),
  note           text not null default '' check (length(note) <= 500),
  voided_at      timestamptz,
  voided_by      uuid references auth.users (id) on delete set null,
  void_reason    text not null default '' check (length(void_reason) <= 300),
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  foreign key (company_id, work_order_id) references public.work_orders (company_id, id) on delete cascade,
  foreign key (company_id, user_id) references public.company_memberships (company_id, user_id),
  check (ended_at is null or ended_at > started_at),
  check (ended_at is null or ended_at - started_at <= interval '16 hours'),
  check ((voided_at is null) = (void_reason = '')),
  -- No overlapping time for one person; a running timer counts until it stops.
  constraint work_order_time_no_overlap exclude using gist (
    user_id with =, tstzrange(started_at, coalesce(ended_at, 'infinity'::timestamptz), '[)') with &&)
    where (voided_at is null)
);
create unique index work_order_time_one_running on public.work_order_time_entries (user_id) where ended_at is null and voided_at is null;
create index work_order_time_wo on public.work_order_time_entries (company_id, work_order_id);

-- 3. Tasks -----------------------------------------------------------------------------------------------------------
create table public.work_order_tasks (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id),
  work_order_id  uuid not null,
  position       integer not null check (position between 1 and 200),
  title          text not null check (length(btrim(title)) between 2 and 200),
  status         text not null default 'open' check (status in ('open', 'done', 'skipped')),
  done_by        uuid references auth.users (id) on delete set null,
  done_at        timestamptz,
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  foreign key (company_id, work_order_id) references public.work_orders (company_id, id) on delete cascade,
  check ((status = 'open') = (done_at is null))
);
create index work_order_tasks_wo on public.work_order_tasks (company_id, work_order_id, position);

alter table public.work_order_mechanics enable row level security;
alter table public.work_order_time_entries enable row level security;
alter table public.work_order_tasks enable row level security;
create policy work_order_mechanics_read on public.work_order_mechanics for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.view')));
create policy work_order_time_entries_read on public.work_order_time_entries for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.view')));
create policy work_order_tasks_read on public.work_order_tasks for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('maintenance.view')));
revoke all on public.work_order_mechanics, public.work_order_time_entries, public.work_order_tasks from anon;
grant select on public.work_order_mechanics, public.work_order_time_entries, public.work_order_tasks to authenticated;

-- Helpers ------------------------------------------------------------------------------------------------------------
-- The work order, locked, in the caller's company; refuses closed ones for crew, time and task changes.
create or replace function private.wo_for_crew(p_wo uuid)
returns public.work_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wo public.work_orders%rowtype;
begin
  perform private.require_permission('maintenance.manage');
  select * into v_wo from public.work_orders where id = p_wo and company_id = private.require_company() for update;
  if not found then
    raise exception 'Work order not found.' using errcode = 'P0002';
  end if;
  if v_wo.status in ('closed', 'canceled') then
    raise exception 'This work order is % and can no longer be changed.', v_wo.status using errcode = 'P0001';
  end if;
  return v_wo;
end;
$$;

-- Whether a member's role can work on maintenance (the same rule as maintenance_assignee_options).
create or replace function private.can_be_mechanic(p_company uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.company_memberships m
                 join public.role_permissions rp on rp.company_id = m.company_id and rp.role = m.role and rp.permission = 'maintenance.manage'
                 where m.company_id = p_company and m.user_id = p_user and m.active);
$$;

create or replace function private.wo_person_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(trim(full_name), ''), 'Unnamed user') from public.profiles where id = p_user;
$$;

-- Labor hours follow the valid time entries whenever the work order has any.
create or replace function private.wo_sync_labor(p_wo uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.work_orders w set labor_hours = round((coalesce(t.minutes, 0) / 60.0)::numeric, 2), updated_at = now()
  from (select sum(extract(epoch from (ended_at - started_at)) / 60.0) filter (where voided_at is null and ended_at is not null) minutes
        from public.work_order_time_entries where work_order_id = p_wo) t
  where w.id = p_wo and exists (select 1 from public.work_order_time_entries where work_order_id = p_wo);
$$;

-- The lead stays equal to work_orders.assigned_to, whichever screen changes it.
create or replace function private.wo_sync_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.assigned_to is distinct from old.assigned_to or tg_op = 'INSERT' then
    update public.work_order_mechanics set role = 'assist', updated_at = now()
      where work_order_id = new.id and role = 'lead' and user_id is distinct from new.assigned_to;
    if new.assigned_to is not null then
      insert into public.work_order_mechanics (company_id, work_order_id, user_id, role, added_by)
      values (new.company_id, new.id, new.assigned_to, 'lead', auth.uid())
      on conflict (work_order_id, user_id) do update set role = 'lead', updated_at = now();
    end if;
  end if;
  return null;
end;
$$;
create trigger work_orders_sync_lead after insert or update of assigned_to on public.work_orders
  for each row execute function private.wo_sync_lead();

-- No finishing a work order while someone's timer is running on it.
create or replace function private.wo_no_running_timer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_who text;
begin
  if new.status is distinct from old.status and new.status in ('awaiting_inspection', 'completed', 'closed', 'canceled') then
    select private.wo_person_name(t.user_id) into v_who from public.work_order_time_entries t
      where t.work_order_id = new.id and t.ended_at is null and t.voided_at is null limit 1;
    if v_who is not null then
      raise exception '% still has a timer running on this work order. Stop it first.', v_who using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger work_orders_no_running_timer before update of status on public.work_orders
  for each row execute function private.wo_no_running_timer();

-- Existing leads become crew rows.
insert into public.work_order_mechanics (company_id, work_order_id, user_id, role)
select w.company_id, w.id, w.assigned_to, 'lead' from public.work_orders w
where w.assigned_to is not null
  and exists (select 1 from public.company_memberships m where m.company_id = w.company_id and m.user_id = w.assigned_to)
on conflict do nothing;

-- Crew functions -----------------------------------------------------------------------------------------------------
create or replace function public.maintenance_add_mechanic(p_wo uuid, p_user uuid, p_lead boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wo public.work_orders%rowtype := private.wo_for_crew(p_wo);
begin
  if not private.can_be_mechanic(v_wo.company_id, p_user) then
    raise exception 'That person''s role cannot work on maintenance.' using errcode = 'P0001';
  end if;
  if p_lead then
    update public.work_orders set assigned_to = p_user, edit_seq = edit_seq + 1, updated_by = auth.uid(), updated_at = now() where id = p_wo;
  else
    insert into public.work_order_mechanics (company_id, work_order_id, user_id, role, added_by)
    values (v_wo.company_id, p_wo, p_user, 'assist', auth.uid())
    on conflict (work_order_id, user_id) do nothing;
  end if;
  perform private.wo_event(v_wo.company_id, p_wo, 'crew', null, null,
    private.wo_person_name(p_user) || case when p_lead then ' is now the lead mechanic' else ' joined the crew' end,
    jsonb_build_object('user_id', p_user, 'lead', p_lead));
end;
$$;

create or replace function public.maintenance_remove_mechanic(p_wo uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wo public.work_orders%rowtype := private.wo_for_crew(p_wo);
begin
  if exists (select 1 from public.work_order_time_entries where work_order_id = p_wo and user_id = p_user and ended_at is null and voided_at is null) then
    raise exception 'Stop % timer on this work order first.', private.wo_person_name(p_user) || '''s' using errcode = 'P0001';
  end if;
  if v_wo.assigned_to = p_user then
    update public.work_orders set assigned_to = null, edit_seq = edit_seq + 1, updated_by = auth.uid(), updated_at = now() where id = p_wo;
  end if;
  -- Logged time stays on the work order; only the crew membership ends.
  delete from public.work_order_mechanics where work_order_id = p_wo and user_id = p_user;
  perform private.wo_event(v_wo.company_id, p_wo, 'crew', null, null, private.wo_person_name(p_user) || ' left the crew',
    jsonb_build_object('user_id', p_user));
end;
$$;

-- A mechanic's own status on a work order (assigned, paused or done; "working" comes from a running timer).
create or replace function public.maintenance_set_my_status(p_wo uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wo public.work_orders%rowtype := private.wo_for_crew(p_wo);
begin
  if coalesce(p_status, '') not in ('assigned', 'paused', 'done') then
    raise exception 'Choose assigned, paused or done.' using errcode = '22023';
  end if;
  if exists (select 1 from public.work_order_time_entries where work_order_id = p_wo and user_id = auth.uid() and ended_at is null and voided_at is null) then
    raise exception 'Stop your timer first.' using errcode = 'P0001';
  end if;
  update public.work_order_mechanics set status = p_status, updated_at = now() where work_order_id = p_wo and user_id = auth.uid();
  if not found then
    raise exception 'You are not on this work order''s crew.' using errcode = 'P0001';
  end if;
  perform private.wo_event(v_wo.company_id, p_wo, 'crew', null, null, private.wo_person_name(auth.uid()) || ': ' || p_status,
    jsonb_build_object('user_id', auth.uid(), 'status', p_status));
end;
$$;

-- Time functions -----------------------------------------------------------------------------------------------------
create or replace function public.maintenance_start_timer(p_wo uuid, p_note text default '')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wo public.work_orders%rowtype := private.wo_for_crew(p_wo);
  v_running record;
  v_id uuid;
begin
  if v_wo.status <> 'in_progress' then
    raise exception 'Start the work order (In progress) before starting a timer.' using errcode = 'P0001';
  end if;
  if not private.can_be_mechanic(v_wo.company_id, auth.uid()) then
    raise exception 'Your role cannot work on maintenance.' using errcode = '42501';
  end if;
  select t.id, w.number into v_running from public.work_order_time_entries t join public.work_orders w on w.id = t.work_order_id
    where t.user_id = auth.uid() and t.ended_at is null and t.voided_at is null;
  if found then
    raise exception 'Your timer is already running on %. Stop it first.', v_running.number using errcode = 'P0001';
  end if;
  insert into public.work_order_mechanics (company_id, work_order_id, user_id, role, added_by)
  values (v_wo.company_id, p_wo, auth.uid(), 'assist', auth.uid())
  on conflict (work_order_id, user_id) do nothing;
  update public.work_order_mechanics set status = 'working', updated_at = now() where work_order_id = p_wo and user_id = auth.uid();
  insert into public.work_order_time_entries (company_id, work_order_id, user_id, started_at, source, note)
  values (v_wo.company_id, p_wo, auth.uid(), now(), 'timer', private.clean_text(p_note, 500, 'Note'))
  returning id into v_id;
  perform private.wo_event(v_wo.company_id, p_wo, 'time', null, null, private.wo_person_name(auth.uid()) || ' started work',
    jsonb_build_object('entry_id', v_id));
  return v_id;
end;
$$;

create or replace function public.maintenance_stop_timer(p_note text default '')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.work_order_time_entries%rowtype;
  v_note text := private.clean_text(p_note, 500, 'Note');
begin
  perform private.require_permission('maintenance.manage');
  select * into v_entry from public.work_order_time_entries
    where user_id = auth.uid() and company_id = private.require_company() and ended_at is null and voided_at is null for update;
  if not found then
    raise exception 'You have no timer running.' using errcode = 'P0002';
  end if;
  -- A timer stopped in the same instant it started holds no time: it is voided, not kept as a zero-length entry.
  if now() <= v_entry.started_at then
    update public.work_order_time_entries set ended_at = null, voided_at = now(), voided_by = auth.uid(),
      void_reason = 'Stopped at once (no time)' where id = v_entry.id;
  else
  -- A timer left running past the 16-hour limit stops at the limit; the entry says so.
  update public.work_order_time_entries set
    ended_at = least(now(), started_at + interval '16 hours'),
    note = left(trim(both ' ' from concat_ws(' · ', nullif(note, ''), nullif(v_note, ''),
           case when now() > started_at + interval '16 hours' then 'stopped at the 16-hour limit' end)), 500)
  where id = v_entry.id;
  end if;
  update public.work_order_mechanics set status = 'paused', updated_at = now()
    where work_order_id = v_entry.work_order_id and user_id = auth.uid() and status = 'working';
  perform private.wo_sync_labor(v_entry.work_order_id);
  perform private.wo_event(v_entry.company_id, v_entry.work_order_id, 'time', null, null,
    private.wo_person_name(auth.uid()) || ' stopped work', jsonb_build_object('entry_id', v_entry.id));
  return v_entry.work_order_id;
end;
$$;

-- Time entered after the fact, for oneself or a crew member. The overlap rule applies.
create or replace function public.maintenance_add_time(p_wo uuid, p_user uuid, p_started timestamptz, p_ended timestamptz, p_note text default '')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wo public.work_orders%rowtype := private.wo_for_crew(p_wo);
  v_id uuid;
begin
  if p_started is null or p_ended is null or p_ended <= p_started then
    raise exception 'Enter a start and an end after it.' using errcode = '22023';
  end if;
  if p_ended > now() + interval '5 minutes' then
    raise exception 'Time cannot be logged in the future.' using errcode = '22023';
  end if;
  if p_ended - p_started > interval '16 hours' then
    raise exception 'One entry can be at most 16 hours.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.work_order_mechanics where work_order_id = p_wo and user_id = p_user) then
    raise exception 'Add that person to the crew first.' using errcode = 'P0001';
  end if;
  begin
    insert into public.work_order_time_entries (company_id, work_order_id, user_id, started_at, ended_at, source, note)
    values (v_wo.company_id, p_wo, p_user, p_started, p_ended, 'manual', private.clean_text(p_note, 500, 'Note'))
    returning id into v_id;
  exception when exclusion_violation then
    raise exception '% already has time logged in that period.', private.wo_person_name(p_user) using errcode = 'P0001';
  end;
  perform private.wo_sync_labor(p_wo);
  perform private.wo_event(v_wo.company_id, p_wo, 'time', null, null,
    format('%s: %s h logged', private.wo_person_name(p_user), round((extract(epoch from (p_ended - p_started)) / 3600.0)::numeric, 2)),
    jsonb_build_object('entry_id', v_id, 'user_id', p_user));
  return v_id;
end;
$$;

create or replace function public.maintenance_void_time(p_entry uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.work_order_time_entries%rowtype;
  v_reason text := private.clean_text(p_reason, 300, 'Reason');
begin
  select * into v_entry from public.work_order_time_entries where id = p_entry and company_id = private.require_company();
  if not found then
    raise exception 'Time entry not found.' using errcode = 'P0002';
  end if;
  perform private.wo_for_crew(v_entry.work_order_id);
  if length(v_reason) < 3 then
    raise exception 'Say why this time is being removed.' using errcode = '22023';
  end if;
  if v_entry.voided_at is not null then
    return;
  end if;
  update public.work_order_time_entries set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason,
    ended_at = coalesce(ended_at, now())
  where id = p_entry;
  update public.work_order_mechanics set status = 'paused', updated_at = now()
    where work_order_id = v_entry.work_order_id and user_id = v_entry.user_id and status = 'working' and v_entry.ended_at is null;
  perform private.wo_sync_labor(v_entry.work_order_id);
  perform private.wo_event(v_entry.company_id, v_entry.work_order_id, 'time', null, null,
    private.wo_person_name(v_entry.user_id) || ': time entry removed (' || v_reason || ')', jsonb_build_object('entry_id', p_entry));
end;
$$;

-- Task functions -----------------------------------------------------------------------------------------------------
create or replace function public.maintenance_add_task(p_wo uuid, p_title text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wo public.work_orders%rowtype := private.wo_for_crew(p_wo);
  v_title text := private.clean_text(p_title, 200, 'Task');
  v_id uuid;
begin
  if length(v_title) < 2 then
    raise exception 'Describe the task.' using errcode = '22023';
  end if;
  insert into public.work_order_tasks (company_id, work_order_id, position, title)
  values (v_wo.company_id, p_wo, coalesce((select max(position) from public.work_order_tasks where work_order_id = p_wo), 0) + 1, v_title)
  returning id into v_id;
  perform private.wo_event(v_wo.company_id, p_wo, 'task', null, null, 'Task added: ' || v_title, jsonb_build_object('task_id', v_id));
  return v_id;
end;
$$;

create or replace function public.maintenance_set_task(p_task uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.work_order_tasks%rowtype;
begin
  if coalesce(p_status, '') not in ('open', 'done', 'skipped') then
    raise exception 'Choose open, done or skipped.' using errcode = '22023';
  end if;
  select * into v_task from public.work_order_tasks where id = p_task and company_id = private.require_company();
  if not found then
    raise exception 'Task not found.' using errcode = 'P0002';
  end if;
  perform private.wo_for_crew(v_task.work_order_id);
  update public.work_order_tasks set status = p_status,
    done_at = case when p_status = 'open' then null else now() end,
    done_by = case when p_status = 'open' then null else auth.uid() end
  where id = p_task;
  perform private.wo_event(v_task.company_id, v_task.work_order_id, 'task', null, null,
    format('Task %s: %s', case p_status when 'open' then 'reopened' else p_status end, v_task.title), jsonb_build_object('task_id', p_task));
end;
$$;

revoke all on function private.wo_for_crew(uuid), private.can_be_mechanic(uuid, uuid), private.wo_person_name(uuid),
  private.wo_sync_labor(uuid), private.wo_sync_lead(), private.wo_no_running_timer() from public, anon, authenticated;
revoke all on function public.maintenance_add_mechanic(uuid, uuid, boolean), public.maintenance_remove_mechanic(uuid, uuid),
  public.maintenance_set_my_status(uuid, text), public.maintenance_start_timer(uuid, text), public.maintenance_stop_timer(text),
  public.maintenance_add_time(uuid, uuid, timestamptz, timestamptz, text), public.maintenance_void_time(uuid, text),
  public.maintenance_add_task(uuid, text), public.maintenance_set_task(uuid, text) from public, anon;
grant execute on function public.maintenance_add_mechanic(uuid, uuid, boolean), public.maintenance_remove_mechanic(uuid, uuid),
  public.maintenance_set_my_status(uuid, text), public.maintenance_start_timer(uuid, text), public.maintenance_stop_timer(text),
  public.maintenance_add_time(uuid, uuid, timestamptz, timestamptz, text), public.maintenance_void_time(uuid, text),
  public.maintenance_add_task(uuid, text), public.maintenance_set_task(uuid, text) to authenticated;
