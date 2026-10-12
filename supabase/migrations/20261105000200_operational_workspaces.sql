-- =============================================================================
-- Operational workspaces: conversations whose driver membership follows
-- dispatch.
--
-- * public.operation_workspaces — the scope of a conversation of kind
--   'operation': a project (orders), a destination on a date, or chosen loads.
-- * Drivers are members while they hold an active, undelivered assignment on a
--   load in scope (source 'dispatch'); staff are added by hand. Membership is
--   recalculated inside the same transaction as every committed change to
--   dispatch_assignments, order_loads or the order's delivery site (triggers),
--   so a dispatch change and the communication permissions it implies commit
--   together.
-- * Handoff: when a driver is replaced, the old driver's period ends (read-only
--   history up to then, nothing new) and the new driver joins with history
--   from now plus the messages pinned as current context — never the rest of
--   the history. A system message records who replaced whom on which load.
-- * Failure: if recalculating membership fails, the dispatch change still
--   commits, the workspace is marked sync_status = 'failed' with the error,
--   and nobody can post in it until an authorized user runs a resync that
--   succeeds (no new information can reach a stale member list).
-- * Lifecycle: active → (all loads delivered or canceled, then the company's
--   archive delay) → archived; closed/reopened by hand. Reopening recalculates
--   driver membership from current assignments: former drivers do not regain
--   access. Follow-up workspaces link to the previous one.
-- * Housekeeping (auto-archive, retention) runs from public.comm_housekeeping(),
--   called by the app while people use Communications (at most once a minute
--   per company). No external scheduler exists.
--
-- Depends on 20261105000100. Rollback: supabase/rollbacks/20261105000200_operational_workspaces.down.sql
-- =============================================================================

create table public.operation_workspaces (
  conversation_id          uuid primary key,
  company_id               uuid not null references public.companies (id),
  scope_type               text not null check (scope_type in ('project', 'destination', 'loads')),
  order_ids                uuid[] not null default '{}',
  site_key                 text,
  scope_date               date,
  load_ids                 uuid[] not null default '{}',
  previous_conversation_id uuid,
  sync_status              text not null default 'ok' check (sync_status in ('ok', 'failed')),
  sync_error               text not null default '',
  last_synced_at           timestamptz,
  work_finished_at         timestamptz,
  foreign key (company_id, conversation_id) references public.conversations (company_id, id) on delete cascade,
  foreign key (company_id, previous_conversation_id) references public.conversations (company_id, id),
  constraint operation_scope check (
    (scope_type = 'project' and cardinality(order_ids) > 0)
    or (scope_type = 'destination' and site_key is not null and scope_date is not null)
    or (scope_type = 'loads' and cardinality(load_ids) > 0))
);
create index operation_workspaces_orders_idx on public.operation_workspaces using gin (order_ids);
create index operation_workspaces_loads_idx on public.operation_workspaces using gin (load_ids);

create table public.comm_housekeeping_runs (
  company_id uuid primary key references public.companies (id),
  ran_at     timestamptz not null
);

create trigger a_company_guard before update of company_id on public.operation_workspaces
  for each row execute function private.forbid_company_change();
alter table public.operation_workspaces enable row level security;
alter table public.comm_housekeeping_runs enable row level security;
create policy operation_workspaces_read on public.operation_workspaces for select to authenticated
  using (company_id = (select private.current_company_id()) and (private.comm_ever_member(conversation_id) or (select private.has_permission('comms.operations'))));
create policy comm_housekeeping_runs_read on public.comm_housekeeping_runs for select to authenticated
  using (company_id = (select private.current_company_id()));
revoke all on public.operation_workspaces, public.comm_housekeeping_runs from anon, authenticated;
grant select on public.operation_workspaces, public.comm_housekeeping_runs to authenticated;
grant all on public.operation_workspaces, public.comm_housekeeping_runs to service_role;

/** Normalised delivery site of an order (same rule Smart Dispatch uses). */
create or replace function private.comm_site_key(p_line1 text, p_label text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(lower(trim(coalesce(nullif(trim(p_line1), ''), p_label, ''))), '')
$$;

/** Loads in a workspace's scope that are still planned (not canceled). */
create or replace function private.comm_scope_loads(p_conversation uuid)
returns table (load_id uuid, order_id uuid, order_number text, load_number integer, load_date date)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, l.order_id, o.order_number, l.load_number, l.load_date
  from public.operation_workspaces w
  join public.order_loads l on l.company_id = w.company_id and l.status = 'planned'
  join public.orders o on o.company_id = l.company_id and o.id = l.order_id
  where w.conversation_id = p_conversation
    and ((w.scope_type = 'project' and l.order_id = any (w.order_ids))
         or (w.scope_type = 'loads' and l.id = any (w.load_ids))
         or (w.scope_type = 'destination' and l.load_date = w.scope_date and private.comm_site_key(o.site_line1, o.site_label) = w.site_key))
$$;

/** Drivers (with logins) who currently hold an active, undelivered assignment on a load in scope. */
create or replace function private.comm_scope_drivers(p_conversation uuid)
returns table (user_id uuid, driver_id uuid, load_id uuid, label text)
language sql
stable
security definer
set search_path = ''
as $$
  select d.user_id, d.id, s.load_id, s.order_number || ' load ' || s.load_number
  from private.comm_scope_loads(p_conversation) s
  join public.dispatch_assignments a on a.load_id = s.load_id and a.status = 'active'
  join public.drivers d on d.company_id = a.company_id and d.id = a.driver_id
  join public.company_memberships cm on cm.company_id = d.company_id and cm.user_id = d.user_id and cm.active
  where d.user_id is not null
    and not exists (select 1 from public.delivery_tickets t where t.company_id = a.company_id and t.load_id = a.load_id
                    and t.status::text not in ('voided', 'superseded'))
$$;

/**
 * Recalculate the driver membership of one workspace. Returns what changed.
 * Raises on failure (callers record it). Test hook: setting tlt.comm_sync_fail
 * = 'on' in a session makes it fail, to prove failures are contained.
 */
create or replace function private.comm_sync_operation(p_conversation uuid, p_trigger text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c   public.conversations%rowtype;
  v_w   public.operation_workspaces%rowtype;
  r     record;
  v_added   jsonb := '[]'::jsonb;
  v_removed jsonb := '[]'::jsonb;
  v_old uuid;
begin
  if current_setting('tlt.comm_sync_fail', true) = 'on' then
    raise exception 'Simulated synchronization failure';
  end if;
  select * into v_c from public.conversations where id = p_conversation for update;
  select * into v_w from public.operation_workspaces where conversation_id = p_conversation for update;
  if v_c.status <> 'active' then return jsonb_build_object('skipped', v_c.status); end if;

  -- Remove dispatch members who are no longer assigned (period ends now).
  for r in
    select m.id, m.user_id from public.conversation_members m
    where m.conversation_id = p_conversation and m.left_at is null and m.source = 'dispatch'
      and not exists (select 1 from private.comm_scope_drivers(p_conversation) d where d.user_id = m.user_id)
  loop
    update public.conversation_members set left_at = clock_timestamp(), left_reason = 'No longer assigned to a load in this operation'
    where id = r.id;
    v_removed := v_removed || jsonb_build_object('user_id', r.user_id);
    perform private.comm_event(v_c.company_id, p_conversation, 'member_removed', r.user_id,
      jsonb_build_object('reason', 'dispatch', 'trigger', p_trigger));
    perform private.comm_system_message(v_c.company_id, p_conversation,
      private.comm_user_name(r.user_id) || ' is no longer assigned and left the workspace (history up to now stays readable for them).');
  end loop;

  -- Add drivers who are assigned now (history from now; pinned context is visible).
  for r in select distinct on (d.user_id) d.user_id, d.load_id, d.label from private.comm_scope_drivers(p_conversation) d order by d.user_id, d.label loop
    if private.comm_add_member(v_c.company_id, p_conversation, r.user_id, 'dispatch', false) then
      -- A driver on the same load who left in this transaction was replaced (handoff).
      select m.user_id into v_old from public.conversation_members m
      join public.drivers d on d.company_id = m.company_id and d.user_id = m.user_id
      join public.dispatch_assignments a on a.company_id = d.company_id and a.driver_id = d.id and a.load_id = r.load_id and a.status = 'canceled'
      where m.conversation_id = p_conversation and m.source = 'dispatch' and m.left_at >= now() and m.user_id <> r.user_id
      limit 1;
      v_added := v_added || jsonb_build_object('user_id', r.user_id, 'load', r.label, 'replaces', v_old);
      perform private.comm_event(v_c.company_id, p_conversation, 'member_added', r.user_id,
        jsonb_build_object('reason', 'dispatch', 'trigger', p_trigger, 'load', r.label, 'replaces', v_old));
      perform private.comm_system_message(v_c.company_id, p_conversation,
        private.comm_user_name(r.user_id) || ' joined (' || r.label || ')' ||
        case when v_old is not null then ' and replaces ' || private.comm_user_name(v_old) || ' on that load' else '' end ||
        '. Pinned instructions are visible to them; earlier messages are not.');
      perform private.comm_notify(v_c.company_id, r.user_id, 'membership', 'You were added to ' || v_c.title || ' (assigned load)',
        '/communications/c/' || p_conversation, p_conversation);
      v_old := null;
    end if;
  end loop;

  update public.operation_workspaces set last_synced_at = clock_timestamp(), sync_status = 'ok', sync_error = '',
    work_finished_at = case when exists (select 1 from private.comm_scope_loads(p_conversation) s
                                         where not exists (select 1 from public.delivery_tickets t where t.load_id = s.load_id
                                                           and t.status::text not in ('voided', 'superseded')))
                            then null else coalesce(work_finished_at, clock_timestamp()) end
  where conversation_id = p_conversation;
  return jsonb_build_object('added', v_added, 'removed', v_removed);
end;
$$;

/** Sync, containing any failure: the workspace is marked failed (posting blocked) and the error recorded. */
create or replace function private.comm_sync_safely(p_conversation uuid, p_trigger text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
begin
  begin
    perform private.comm_sync_operation(p_conversation, p_trigger);
    return true;
  exception when others then
    select company_id into v_company from public.operation_workspaces where conversation_id = p_conversation;
    update public.operation_workspaces set sync_status = 'failed', sync_error = left(sqlerrm, 500) where conversation_id = p_conversation;
    insert into public.conversation_events (company_id, conversation_id, kind, details, actor_id)
    values (v_company, p_conversation, 'sync_failed', jsonb_build_object('trigger', p_trigger, 'error', left(sqlerrm, 500)), auth.uid());
    return false;
  end;
end;
$$;

/** Workspaces affected by a load (directly, through its order, or its destination and date). */
create or replace function private.comm_workspaces_for_load(p_load uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select w.conversation_id
  from public.order_loads l
  join public.orders o on o.company_id = l.company_id and o.id = l.order_id
  join public.operation_workspaces w on w.company_id = l.company_id
  join public.conversations c on c.id = w.conversation_id and c.status = 'active'
  where l.id = p_load
    and (p_load = any (w.load_ids) or l.order_id = any (w.order_ids)
         or (w.scope_type = 'destination' and w.scope_date = l.load_date and w.site_key = private.comm_site_key(o.site_line1, o.site_label)))
$$;

create or replace function private.comm_on_dispatch_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_loads uuid[];
begin
  if tg_table_name = 'dispatch_assignments' then
    v_loads := array[coalesce(new.load_id, old.load_id)];
  elsif tg_table_name = 'order_loads' then
    v_loads := array[coalesce(new.id, old.id)];
  elsif tg_table_name = 'delivery_tickets' then
    v_loads := array[coalesce(new.load_id, old.load_id)];
  else -- orders: the delivery site changed
    select array_agg(l.id) into v_loads from public.order_loads l where l.order_id = new.id;
  end if;
  -- Workspaces scoped to a destination also need a sync when a load leaves it (date or site change).
  for v_ws in
    select distinct x from (
      select private.comm_workspaces_for_load(u) as x from unnest(coalesce(v_loads, '{}'::uuid[])) u
      union
      select w.conversation_id from public.operation_workspaces w join public.conversations c on c.id = w.conversation_id and c.status = 'active'
      where tg_table_name in ('order_loads', 'orders') and w.scope_type = 'destination'
        and w.company_id = coalesce(new.company_id, old.company_id)
    ) q where x is not null
  loop
    perform private.comm_sync_safely(v_ws, tg_table_name || '.' || lower(tg_op));
  end loop;
  return null;
end;
$$;

create trigger comm_ops_assignments after insert or update or delete on public.dispatch_assignments
  for each row execute function private.comm_on_dispatch_change();
create trigger comm_ops_loads after update of status, load_date, order_id on public.order_loads
  for each row execute function private.comm_on_dispatch_change();
create trigger comm_ops_orders after update of site_line1, site_label on public.orders
  for each row when (old.site_line1 is distinct from new.site_line1 or old.site_label is distinct from new.site_label)
  execute function private.comm_on_dispatch_change();
create trigger comm_ops_tickets after insert or update of status on public.delivery_tickets
  for each row execute function private.comm_on_dispatch_change();

/** Nobody posts in a workspace whose membership could not be synchronized. */
create or replace function private.comm_guard_operation_post()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'text' and exists (select 1 from public.operation_workspaces w where w.conversation_id = new.conversation_id and w.sync_status = 'failed') then
    raise exception 'Membership of this workspace could not be updated after a dispatch change. Posting is paused until someone resyncs it.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger messages_operation_guard before insert on public.messages
  for each row execute function private.comm_guard_operation_post();

-- -----------------------------------------------------------------------------
-- Creating and managing workspaces (comms.operations)
-- -----------------------------------------------------------------------------
create or replace function private.comm_scope_from(p_company uuid, p jsonb)
returns public.operation_workspaces
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  w public.operation_workspaces%rowtype;
  v_n integer;
begin
  w.company_id := p_company;
  w.sync_status := 'ok';
  w.sync_error := '';
  w.scope_type := p ->> 'scope_type';
  w.order_ids := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p -> 'order_ids', '[]')) x), '{}');
  w.load_ids := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p -> 'load_ids', '[]')) x), '{}');
  w.site_key := private.comm_site_key(p ->> 'site', null);
  w.scope_date := nullif(p ->> 'date', '')::date;
  if w.scope_type = 'project' then
    select count(*) into v_n from public.orders where company_id = p_company and id = any (w.order_ids);
    if v_n = 0 or v_n <> cardinality(w.order_ids) then raise exception 'Choose orders of your company.' using errcode = 'P0002'; end if;
  elsif w.scope_type = 'loads' then
    select count(*) into v_n from public.order_loads where company_id = p_company and id = any (w.load_ids);
    if v_n = 0 or v_n <> cardinality(w.load_ids) then raise exception 'Choose loads of your company.' using errcode = 'P0002'; end if;
  elsif w.scope_type = 'destination' then
    if w.site_key is null or w.scope_date is null then raise exception 'Choose a destination and a date.' using errcode = 'P0001'; end if;
  else
    raise exception 'Choose a scope: project, destination or loads.';
  end if;
  return w;
end;
$$;

/** Who would be in a workspace with this scope (for review before creating or sending). */
create or replace function public.comm_operation_preview(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  w public.operation_workspaces%rowtype;
  v_tmp uuid := gen_random_uuid();
  v_result jsonb;
begin
  perform private.require_permission('comms.operations');
  w := private.comm_scope_from(v_company, p);
  -- Evaluate the scope with a throwaway row (rolled back by the savepoint below).
  begin
    insert into public.conversations (id, company_id, kind, title, created_by) values (v_tmp, v_company, 'operation', 'preview', auth.uid());
    w.conversation_id := v_tmp;
    insert into public.operation_workspaces select w.*;
    v_result := jsonb_build_object(
      'loads', coalesce((select jsonb_agg(jsonb_build_object('load_id', s.load_id, 'label', s.order_number || ' load ' || s.load_number, 'date', s.load_date))
                         from private.comm_scope_loads(v_tmp) s), '[]'::jsonb),
      'drivers', coalesce((select jsonb_agg(distinct jsonb_build_object('user_id', d.user_id, 'name', private.comm_user_name(d.user_id)))
                           from private.comm_scope_drivers(v_tmp) d), '[]'::jsonb),
      'drivers_without_login', (select count(distinct a.driver_id) from private.comm_scope_loads(v_tmp) s
                                join public.dispatch_assignments a on a.load_id = s.load_id and a.status = 'active'
                                join public.drivers d on d.id = a.driver_id where d.user_id is null));
    raise exception using errcode = 'P0004', message = 'preview';
  exception when sqlstate 'P0004' then
    null;
  end;
  return v_result;
end;
$$;

create or replace function public.comm_create_operation(p_title text, p jsonb, p_staff uuid[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  w public.operation_workspaces%rowtype;
  v_id uuid;
  v_u uuid;
  v_title text := private.clean_text(p_title, 120, 'Title');
begin
  perform private.require_permission('comms.operations');
  if length(v_title) = 0 then raise exception 'Name the workspace, for example the job or destination.'; end if;
  w := private.comm_scope_from(v_company, p);
  insert into public.conversations (company_id, kind, title, title_custom, history_policy, members_can_add, created_by)
  values (v_company, 'operation', v_title, true, 'from_join', false, auth.uid())
  returning id into v_id;
  w.conversation_id := v_id;
  w.previous_conversation_id := nullif(p ->> 'previous_conversation_id', '')::uuid;
  if w.previous_conversation_id is not null and not exists (
      select 1 from public.conversations where id = w.previous_conversation_id and company_id = v_company and kind = 'operation') then
    raise exception 'The previous workspace was not found.' using errcode = 'P0002';
  end if;
  insert into public.operation_workspaces select w.*;
  perform private.comm_add_member(v_company, v_id, auth.uid(), 'creator', true, 'manager');
  foreach v_u in array coalesce(p_staff, '{}'::uuid[]) loop
    if v_u <> auth.uid() then
      perform private.comm_require_coworker(v_company, v_u);
      perform private.comm_add_member(v_company, v_id, v_u, 'manual', false);
    end if;
  end loop;
  perform private.comm_event(v_company, v_id, 'created', null, jsonb_build_object('scope', p));
  perform private.comm_sync_operation(v_id, 'created');
  return v_id;
end;
$$;

/** Widen or narrow a workspace's scope (same operation). Substantially different work → a follow-up workspace instead. */
create or replace function public.comm_operation_update_scope(p_conversation uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  w public.operation_workspaces%rowtype;
  old public.operation_workspaces%rowtype;
begin
  perform private.require_permission('comms.operations');
  select * into old from public.operation_workspaces where conversation_id = p_conversation and company_id = v_company for update;
  if not found then raise exception 'Workspace not found.' using errcode = 'P0002'; end if;
  w := private.comm_scope_from(v_company, p);
  if w.scope_type <> old.scope_type then
    raise exception 'Changing the kind of scope is a different operation: start a follow-up workspace.' using errcode = 'P0001';
  end if;
  update public.operation_workspaces set order_ids = w.order_ids, load_ids = w.load_ids, site_key = w.site_key, scope_date = w.scope_date
  where conversation_id = p_conversation;
  perform private.comm_event(v_company, p_conversation, 'scope_changed', null, jsonb_build_object('from', to_jsonb(old), 'to', p));
  return private.comm_sync_operation(p_conversation, 'scope_changed');
end;
$$;

/** Recover after a failed synchronization. */
create or replace function public.comm_operation_resync(p_conversation uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_was text;
  v jsonb;
begin
  perform private.require_permission('comms.operations');
  select sync_status into v_was from public.operation_workspaces where conversation_id = p_conversation and company_id = v_company for update;
  if not found then raise exception 'Workspace not found.' using errcode = 'P0002'; end if;
  v := private.comm_sync_operation(p_conversation, 'manual_resync');
  if v_was = 'failed' then perform private.comm_event(v_company, p_conversation, 'sync_recovered', null, v); end if;
  return v;
end;
$$;

create or replace function public.comm_operation_close(p_conversation uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('comms.operations');
  update public.conversations set status = 'closed', closed_at = now(), closed_by = auth.uid()
  where id = p_conversation and company_id = v_company and kind = 'operation' and status = 'active';
  if not found then raise exception 'Only an active workspace can be closed.' using errcode = 'P0001'; end if;
  -- Drivers' periods end: reopening recalculates who is assigned then.
  update public.conversation_members set left_at = clock_timestamp(), left_reason = 'Workspace closed'
  where conversation_id = p_conversation and left_at is null and source = 'dispatch';
  perform private.comm_event(v_company, p_conversation, 'closed', null, jsonb_build_object('reason', p_reason));
  perform private.comm_system_message(v_company, p_conversation, private.comm_user_name(auth.uid()) || ' closed the workspace' ||
    case when length(trim(coalesce(p_reason, ''))) > 0 then ': ' || trim(p_reason) else '.' end);
end;
$$;

create or replace function public.comm_operation_reopen(p_conversation uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('comms.operations');
  update public.conversations set status = 'active', closed_at = null, closed_by = null
  where id = p_conversation and company_id = v_company and kind = 'operation' and status in ('closed', 'archived');
  if not found then raise exception 'Only a closed or archived workspace can be reopened.' using errcode = 'P0001'; end if;
  update public.operation_workspaces set work_finished_at = null where conversation_id = p_conversation;
  perform private.comm_event(v_company, p_conversation, 'reopened', null);
  perform private.comm_system_message(v_company, p_conversation, private.comm_user_name(auth.uid()) || ' reopened the workspace. Drivers were recalculated from current assignments.');
  return private.comm_sync_operation(p_conversation, 'reopened');
end;
$$;

/** Archive finished workspaces after the company's delay. Hook for alerts (20261105000300) to veto. */
create or replace function private.comm_operation_can_archive(p_conversation uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select true
$$;

create or replace function private.comm_archive_finished(p_company uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delay integer := (private.comm_settings_of(p_company)).workspace_archive_hours;
  r record;
  v_n integer := 0;
begin
  for r in
    select w.conversation_id from public.operation_workspaces w join public.conversations c on c.id = w.conversation_id
    where w.company_id = p_company and c.status = 'active' and w.sync_status = 'ok'
      and w.work_finished_at is not null and w.work_finished_at + make_interval(hours => v_delay) <= clock_timestamp()
  loop
    if private.comm_operation_can_archive(r.conversation_id) then
      update public.conversations set status = 'archived', closed_at = now() where id = r.conversation_id;
      update public.conversation_members set left_at = clock_timestamp(), left_reason = 'Workspace archived'
      where conversation_id = r.conversation_id and left_at is null and source = 'dispatch';
      insert into public.conversation_events (company_id, conversation_id, kind, details) values (p_company, r.conversation_id, 'archived', '{}'::jsonb);
      perform private.comm_system_message(p_company, r.conversation_id, 'All loads are finished; the workspace was archived automatically.');
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

/** Housekeeping while people use Communications (at most once a minute per company). */
create or replace function public.comm_housekeeping()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_last timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('comm_housekeeping:' || v_company::text));
  select ran_at into v_last from public.comm_housekeeping_runs where company_id = v_company;
  if v_last is not null and v_last > now() - interval '1 minute' then return jsonb_build_object('skipped', true); end if;
  insert into public.comm_housekeeping_runs (company_id, ran_at) values (v_company, now())
  on conflict (company_id) do update set ran_at = now();
  return jsonb_build_object('archived', private.comm_archive_finished(v_company), 'retention', private.comm_apply_retention(v_company));
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['public.comm_operation_preview(jsonb)', 'public.comm_create_operation(text, jsonb, uuid[])',
    'public.comm_operation_update_scope(uuid, jsonb)', 'public.comm_operation_resync(uuid)', 'public.comm_operation_close(uuid, text)',
    'public.comm_operation_reopen(uuid)', 'public.comm_housekeeping()'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['private.comm_scope_loads(uuid)', 'private.comm_scope_drivers(uuid)', 'private.comm_sync_operation(uuid, text)',
    'private.comm_sync_safely(uuid, text)', 'private.comm_workspaces_for_load(uuid)', 'private.comm_scope_from(uuid, jsonb)',
    'private.comm_archive_finished(uuid)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end;
$$;
