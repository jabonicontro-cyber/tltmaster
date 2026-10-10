-- =============================================================================
-- Unified Command Center and workflow coordination (N10)
--
-- 1. Company defaults: no company-specific column defaults (company name, state).
--    New companies choose their time zone during onboarding. Company setting
--    `urgent_ack_minutes`: escalate unacknowledged urgent orders (null = off).
-- 2. Owners may use the driver portal (owner permissions are fixed and were the
--    only gap); the portal still requires a linked, active driver record.
-- 3. Urgent orders: order_urgencies (one open flag per order, explicit states,
--    who acknowledged) + append-only order_urgency_events. Flagging never assigns
--    trucks, changes assignments or promises a delivery time.
-- 4. Personal Command Center state: user_preferences (section order and
--    collapsed sections) and exception_dismissals (hide a non-urgent item from
--    your own view for a while; the problem stays open for everyone).
-- 5. Command Center functions: new `urgent_order` kind, hidden items, orders
--    scheduled today in the summary (one source for the merged page).
--
-- Additive: no existing rows change except the Owner role gaining
-- `driver.portal` in every company. Safe to run once; the verification block
-- at the end aborts the transaction if anything is inconsistent.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Company defaults and settings
-- -----------------------------------------------------------------------------
alter table public.company_settings alter column company_name set default '';
alter table public.company_settings alter column state set default '';
alter table public.company_settings
  add column urgent_ack_minutes integer check (urgent_ack_minutes between 5 and 1440);
comment on column public.company_settings.urgent_ack_minutes is
  'Escalate an urgent order that nobody acknowledged within this many minutes; null = no escalation.';
grant update (urgent_ack_minutes) on public.company_settings to authenticated;

-- Onboarding with a time zone. The previous one-argument versions stay for
-- compatibility but are no longer callable by app users.
create or replace function private.valid_timezone(p_timezone text)
returns text
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_timezone is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone)
     or p_timezone !~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$' then
    raise exception 'Choose a valid time zone.' using errcode = '22023';
  end if;
  return p_timezone;
end;
$$;

create or replace function public.complete_company_onboarding(p_company_name text, p_timezone text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz     text := private.valid_timezone(p_timezone);
  v_result jsonb := public.complete_company_onboarding(p_company_name);
begin
  -- Only a company created by this call takes the time zone; a repeated
  -- submission never overwrites a setting the owner may have changed since.
  if (v_result ->> 'created')::boolean then
    update public.company_settings set timezone = v_tz where company_id = (v_result ->> 'company_id')::uuid;
  end if;
  return v_result;
end;
$$;

create or replace function public.create_company_with_access_code(p_code_hash text, p_company_name text, p_request_key uuid, p_timezone text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz     text := private.valid_timezone(p_timezone);
  v_result jsonb := public.create_company_with_access_code(p_code_hash, p_company_name, p_request_key);
begin
  if coalesce((v_result ->> 'created')::boolean, false) then
    update public.company_settings set timezone = v_tz where company_id = (v_result ->> 'company_id')::uuid;
  end if;
  return v_result;
end;
$$;

revoke execute on function public.complete_company_onboarding(text) from public, anon, authenticated;
revoke execute on function public.create_company_with_access_code(text, text, uuid) from public, anon, authenticated;
revoke execute on function public.complete_company_onboarding(text, text), public.create_company_with_access_code(text, text, uuid, text) from public, anon;
grant execute on function public.complete_company_onboarding(text, text), public.create_company_with_access_code(text, text, uuid, text) to authenticated;
revoke execute on function private.valid_timezone(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Owners may use the driver portal (when linked to a driver record)
-- -----------------------------------------------------------------------------
insert into public.role_permission_defaults (role, permission) values ('owner', 'driver.portal') on conflict do nothing;
insert into public.role_permissions (company_id, role, permission)
select c.id, 'owner', 'driver.portal' from public.companies c
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 3. Urgent orders
-- -----------------------------------------------------------------------------
create type public.urgency_state as enum (
  'awaiting_acknowledgement', 'acknowledged', 'evaluating', 'waiting_for_information', 'blocked', 'assigned',
  'resolved', 'canceled');

create table public.order_urgencies (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id),
  order_id         uuid not null,
  reason           text not null check (length(trim(reason)) between 3 and 500),
  needed_by        timestamptz,
  state            public.urgency_state not null default 'awaiting_acknowledgement',
  state_note       text not null default '' check (length(state_note) <= 500),
  flagged_by       uuid references auth.users (id) on delete set null,
  flagged_at       timestamptz not null default now(),
  acknowledged_by  uuid references auth.users (id) on delete set null,
  acknowledged_at  timestamptz,
  state_changed_by uuid references auth.users (id) on delete set null,
  state_changed_at timestamptz not null default now(),
  closed_at        timestamptz,
  -- Orders are only ever deleted by "remove sample data"; their flags go with them (like every other order child).
  constraint order_urgencies_order_fk foreign key (company_id, order_id) references public.orders (company_id, id) on delete cascade,
  constraint order_urgencies_closed check ((state in ('resolved', 'canceled')) = (closed_at is not null)),
  constraint order_urgencies_ack check ((state = 'awaiting_acknowledgement') = (acknowledged_at is null) or state in ('resolved', 'canceled')),
  unique (company_id, id)
);
-- One open urgent flag per order: a retry or a second flag updates it, never duplicates it.
create unique index order_urgencies_open on public.order_urgencies (company_id, order_id) where closed_at is null;
create index order_urgencies_order_idx on public.order_urgencies (company_id, order_id, flagged_at desc);

create table public.order_urgency_events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id),
  urgency_id  uuid not null,
  order_id    uuid not null,
  action      text not null check (action in ('flagged', 'updated', 'state_changed', 'closed_with_order')),
  from_state  public.urgency_state,
  to_state    public.urgency_state not null,
  note        text not null default '' check (length(note) <= 500),
  details     jsonb not null default '{}',
  actor_id    uuid references auth.users (id) on delete set null,
  -- clock_timestamp: several steps in one transaction keep their real order.
  occurred_at timestamptz not null default clock_timestamp(),
  constraint order_urgency_events_urgency_fk foreign key (company_id, urgency_id) references public.order_urgencies (company_id, id) on delete cascade,
  constraint order_urgency_events_order_fk foreign key (company_id, order_id) references public.orders (company_id, id) on delete cascade
);
create index order_urgency_events_urgency_idx on public.order_urgency_events (company_id, urgency_id, occurred_at desc);

create or replace function private.guard_order_urgency_event()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only "remove sample data" may delete (with the sample order it belongs to).
  if tg_op = 'DELETE' and current_setting('tlt.sample_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'Urgent order history cannot be changed.' using errcode = '42501';
end;
$$;
create trigger order_urgency_events_append_only before update or delete on public.order_urgency_events
  for each row execute function private.guard_order_urgency_event();

-- A closed flag is history: it cannot be reopened or edited.
create or replace function private.guard_order_urgency()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('tlt.sample_purge', true) = 'on' then
      return old;
    end if;
    raise exception 'Urgent order flags cannot be deleted.' using errcode = '42501';
  end if;
  if old.closed_at is not null then
    raise exception 'This urgent flag is closed.' using errcode = '42501';
  end if;
  if (new.order_id, new.flagged_by, new.flagged_at) is distinct from (old.order_id, old.flagged_by, old.flagged_at) then
    raise exception 'The order and the person who flagged it cannot change.' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger order_urgencies_guard before update or delete on public.order_urgencies
  for each row execute function private.guard_order_urgency();

create trigger a_company_guard before update of company_id on public.order_urgencies
  for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.order_urgency_events
  for each row execute function private.forbid_company_change();

alter table public.order_urgencies enable row level security;
alter table public.order_urgency_events enable row level security;
create policy order_urgencies_read on public.order_urgencies for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('orders.view')) or (select private.has_permission('dispatch.view'))));
create policy order_urgency_events_read on public.order_urgency_events for select to authenticated
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('orders.view')) or (select private.has_permission('dispatch.view'))));
revoke all on public.order_urgencies, public.order_urgency_events from anon, authenticated;
grant select on public.order_urgencies, public.order_urgency_events to authenticated;
grant all on public.order_urgencies, public.order_urgency_events to service_role;

create or replace function private.urgency_event(p_u public.order_urgencies, p_action text, p_from public.urgency_state, p_note text, p_details jsonb default '{}')
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.order_urgency_events (company_id, urgency_id, order_id, action, from_state, to_state, note, details, actor_id)
  values (p_u.company_id, p_u.id, p_u.order_id, p_action, p_from, p_u.state, coalesce(p_note, ''), coalesce(p_details, '{}'), auth.uid());
$$;

/** Flag an order as urgent (orders.edit). One open flag per order; repeating it updates the reason or deadline. */
create or replace function public.flag_order_urgent(p_order_id uuid, p_reason text, p_needed_by timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_reason  text := private.clean_text(p_reason, 500, 'Reason');
  v_order   public.orders%rowtype;
  v_u       public.order_urgencies%rowtype;
begin
  perform private.require_permission('orders.edit');
  v_company := private.require_company();
  if length(v_reason) < 3 then raise exception 'Say why the order is urgent.' using errcode = '22023'; end if;

  select * into v_order from public.orders where id = p_order_id and company_id = v_company for update;
  if not found then raise exception 'Order not found.' using errcode = 'P0002'; end if;
  if v_order.status in ('completed', 'canceled') then
    raise exception 'A % order cannot be flagged as urgent.', v_order.status using errcode = '22023';
  end if;

  select * into v_u from public.order_urgencies
  where company_id = v_company and order_id = p_order_id and closed_at is null for update;
  if found then
    if v_u.reason = v_reason and v_u.needed_by is not distinct from p_needed_by then
      return jsonb_build_object('urgency_id', v_u.id, 'created', false, 'changed', false);
    end if;
    if p_needed_by is not null and p_needed_by is distinct from v_u.needed_by and p_needed_by < now() then
      raise exception 'The deadline must be in the future.' using errcode = '22023';
    end if;
    update public.order_urgencies set reason = v_reason, needed_by = p_needed_by where id = v_u.id returning * into v_u;
    perform private.urgency_event(v_u, 'updated', v_u.state, v_reason, jsonb_build_object('needed_by', p_needed_by));
    perform private.log_event('order.urgent_updated', 'order', p_order_id,
      format('%s urgency updated: %s', v_order.order_number, v_reason), jsonb_build_object('urgency_id', v_u.id, 'needed_by', p_needed_by));
    return jsonb_build_object('urgency_id', v_u.id, 'created', false, 'changed', true);
  end if;

  if p_needed_by is not null and p_needed_by < now() then
    raise exception 'The deadline must be in the future.' using errcode = '22023';
  end if;
  begin
    insert into public.order_urgencies (company_id, order_id, reason, needed_by, flagged_by, state_changed_by)
    values (v_company, p_order_id, v_reason, p_needed_by, auth.uid(), auth.uid())
    returning * into v_u;
  exception when unique_violation then
    raise exception 'Someone else just flagged this order. Refresh to see it.' using errcode = 'PT409';
  end;
  perform private.urgency_event(v_u, 'flagged', null, v_reason, jsonb_build_object('needed_by', p_needed_by));
  perform private.log_event('order.urgent_flagged', 'order', p_order_id,
    format('%s flagged urgent: %s', v_order.order_number, v_reason), jsonb_build_object('urgency_id', v_u.id, 'needed_by', p_needed_by));
  return jsonb_build_object('urgency_id', v_u.id, 'created', true, 'changed', true);
end;
$$;

/**
 * Move an urgent flag to another state. Dispatch (dispatch.edit) acknowledges,
 * evaluates, waits for information, blocks, marks assigned or resolves; the
 * office (orders.edit) can resolve or cancel the flag. Never touches the order,
 * its loads or its assignments.
 */
create or replace function public.update_order_urgency(p_urgency_id uuid, p_state public.urgency_state, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_note    text := private.clean_text(p_note, 500, 'Note');
  v_u       public.order_urgencies%rowtype;
  v_from    public.urgency_state;
  v_number  text;
begin
  v_company := private.require_company();
  if p_state = 'awaiting_acknowledgement' then
    raise exception 'An urgent flag cannot go back to awaiting acknowledgement.' using errcode = '22023';
  end if;
  if p_state = 'canceled' then
    perform private.require_permission('orders.edit');
  elsif p_state = 'resolved' then
    if not (private.has_permission('dispatch.edit') or private.has_permission('orders.edit')) then
      raise exception 'You do not have permission to resolve urgent orders.' using errcode = '42501';
    end if;
  else
    perform private.require_permission('dispatch.edit');
  end if;
  if p_state in ('blocked', 'waiting_for_information', 'resolved', 'canceled') and v_note = '' then
    raise exception 'Add a note: what is blocking, what is missing, or how it was resolved.' using errcode = '22023';
  end if;

  select * into v_u from public.order_urgencies where id = p_urgency_id and company_id = v_company for update;
  if not found then raise exception 'Urgent flag not found.' using errcode = 'P0002'; end if;
  if v_u.closed_at is not null then
    raise exception 'This urgent flag is already %.', v_u.state using errcode = 'PT409';
  end if;
  if v_u.state = p_state and v_u.state_note = v_note then
    return jsonb_build_object('urgency_id', v_u.id, 'state', v_u.state, 'changed', false);
  end if;
  if p_state = 'assigned' and not exists (
       select 1 from public.dispatch_assignments a
       join public.order_loads l on l.id = a.load_id and l.company_id = a.company_id
       where a.company_id = v_company and l.order_id = v_u.order_id and a.status = 'active' and l.status = 'planned') then
    raise exception 'No truck is assigned to this order yet. Assign one on the dispatch board first.' using errcode = '22023';
  end if;

  v_from := v_u.state;
  update public.order_urgencies
     set state = p_state, state_note = v_note, state_changed_by = auth.uid(), state_changed_at = now(),
         acknowledged_by = coalesce(acknowledged_by, case when p_state not in ('resolved', 'canceled') or v_from <> 'awaiting_acknowledgement' then auth.uid() end),
         acknowledged_at = coalesce(acknowledged_at, case when p_state not in ('resolved', 'canceled') or v_from <> 'awaiting_acknowledgement' then now() end),
         closed_at = case when p_state in ('resolved', 'canceled') then now() end
   where id = v_u.id
  returning * into v_u;
  perform private.urgency_event(v_u, 'state_changed', v_from, v_note);
  select order_number into v_number from public.orders where id = v_u.order_id and company_id = v_company;
  perform private.log_event('order.urgent_' || p_state::text, 'order', v_u.order_id,
    format('%s urgent: %s%s', v_number, replace(p_state::text, '_', ' '), case when v_note <> '' then ' — ' || v_note else '' end),
    jsonb_build_object('urgency_id', v_u.id, 'from', v_from, 'to', p_state));
  return jsonb_build_object('urgency_id', v_u.id, 'state', v_u.state, 'changed', true);
end;
$$;

-- A completed or canceled order no longer needs urgent handling: its open flag
-- closes with it (recorded in the flag's history), so nobody has to clear it by hand.
create or replace function private.close_urgency_with_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_u    public.order_urgencies%rowtype;
  v_from public.urgency_state;
begin
  if new.status in ('completed', 'canceled') and old.status is distinct from new.status then
    for v_u in select * from public.order_urgencies where company_id = new.company_id and order_id = new.id and closed_at is null for update loop
      v_from := v_u.state;
      update public.order_urgencies
         set state = 'resolved', state_note = 'Order ' || new.status::text, state_changed_by = auth.uid(), state_changed_at = now(), closed_at = now()
       where id = v_u.id returning * into v_u;
      perform private.urgency_event(v_u, 'closed_with_order', v_from, 'Order ' || new.status::text);
    end loop;
  end if;
  return new;
end;
$$;
create trigger orders_close_urgency after update of status on public.orders
  for each row execute function private.close_urgency_with_order();

-- -----------------------------------------------------------------------------
-- 4. Personal Command Center state
-- -----------------------------------------------------------------------------
create table public.user_preferences (
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id    uuid not null,
  key        text not null check (key in ('command_center')),
  value      jsonb not null check (jsonb_typeof(value) = 'object' and pg_column_size(value) <= 4000),
  updated_at timestamptz not null default now(),
  primary key (company_id, user_id, key),
  constraint user_preferences_member_fk foreign key (company_id, user_id)
    references public.company_memberships (company_id, user_id) on delete cascade
);
create trigger a_company_guard before update of company_id on public.user_preferences
  for each row execute function private.forbid_company_change();
alter table public.user_preferences enable row level security;
create policy user_preferences_own on public.user_preferences for select to authenticated
  using (company_id = (select private.current_company_id()) and user_id = (select auth.uid()));
revoke all on public.user_preferences from anon, authenticated;
grant select on public.user_preferences to authenticated;
grant all on public.user_preferences to service_role;

create table public.exception_dismissals (
  company_id    uuid not null references public.companies (id) on delete cascade,
  user_id       uuid not null,
  exception_key text not null check (length(exception_key) between 3 and 120),
  kind          text not null,
  hidden_until  timestamptz not null,
  created_at    timestamptz not null default now(),
  primary key (company_id, user_id, exception_key),
  constraint exception_dismissals_member_fk foreign key (company_id, user_id)
    references public.company_memberships (company_id, user_id) on delete cascade
);
create trigger a_company_guard before update of company_id on public.exception_dismissals
  for each row execute function private.forbid_company_change();
alter table public.exception_dismissals enable row level security;
create policy exception_dismissals_own on public.exception_dismissals for select to authenticated
  using (company_id = (select private.current_company_id()) and user_id = (select auth.uid()));
revoke all on public.exception_dismissals from anon, authenticated;
grant select on public.exception_dismissals to authenticated;
grant all on public.exception_dismissals to service_role;

/** Save the caller's own Command Center layout in the current company (order and collapsed sections only). */
create or replace function public.save_my_preference(p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if p_key <> 'command_center' then raise exception 'Unknown preference.' using errcode = '22023'; end if;
  if jsonb_typeof(p_value) <> 'object' or pg_column_size(p_value) > 4000
     or exists (select 1 from jsonb_object_keys(p_value) k where k not in ('order', 'collapsed'))
     or exists (select 1 from jsonb_each(p_value) e where jsonb_typeof(e.value) <> 'array') then
    raise exception 'Invalid preference.' using errcode = '22023';
  end if;
  insert into public.user_preferences (company_id, user_id, key, value)
  values (v_company, auth.uid(), p_key, p_value)
  on conflict (company_id, user_id, key) do update set value = excluded.value, updated_at = now();
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Command Center functions
-- -----------------------------------------------------------------------------
alter table public.exception_assignments drop constraint exception_assignments_kind_check;
alter table public.exception_assignments add constraint exception_assignments_kind_check
  check (kind in ('missing_ticket', 'unassigned_load', 'ticket_review', 'billing_blocked', 'equipment_out_of_service',
                  'assignment_problem', 'delay_report', 'equipment_report', 'urgent_order'));

create or replace function private.require_command_center()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if not (private.has_permission('dispatch.view') or private.has_permission('tickets.view')
          or private.has_permission('billing.view') or private.has_permission('fleet.view')
          or private.has_permission('field_reports.view') or private.has_permission('orders.view')) then
    raise exception 'You do not have permission to open the command center.' using errcode = '42501';
  end if;
  return v_company;
end;
$$;

create or replace function private.exception_visible(p_kind text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case p_kind
    when 'missing_ticket'           then private.has_permission('tickets.view') or private.has_permission('billing.view')
    when 'unassigned_load'          then private.has_permission('dispatch.view')
    when 'ticket_review'            then private.has_permission('tickets.view')
    when 'billing_blocked'          then private.has_permission('billing.view')
    when 'equipment_out_of_service' then private.has_permission('fleet.view')
    when 'assignment_problem'       then private.has_permission('dispatch.view')
    when 'delay_report'             then private.field_report_visible('delay')
    when 'equipment_report'         then private.field_report_visible('breakdown')
    when 'urgent_order'             then private.has_permission('dispatch.view') or private.has_permission('orders.view')
    else false
  end
$$;

create or replace function private.exception_resolve_permission(p_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'missing_ticket'           then 'tickets.edit'
    when 'unassigned_load'          then 'dispatch.edit'
    when 'ticket_review'            then 'tickets.review'
    when 'billing_blocked'          then 'billing.manage'
    when 'equipment_out_of_service' then 'fleet.service'
    when 'assignment_problem'       then 'dispatch.edit'
    when 'delay_report'             then 'field_reports.manage'
    when 'equipment_report'         then 'field_reports.manage'
    when 'urgent_order'             then 'dispatch.edit'
  end
$$;

create or replace function public.exception_assignee_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid;
begin
  perform private.require_permission('exceptions.assign');
  v_company := private.require_company();
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', coalesce(nullif(trim(p.full_name), ''), 'Unnamed user'),
                                        'role', m.role, 'kinds', k.kinds) order by p.full_name)
    from public.company_memberships m
    join public.profiles p on p.id = m.user_id
    cross join lateral (
      select coalesce(jsonb_agg(kind order by kind), '[]') as kinds
      from unnest(array['missing_ticket', 'unassigned_load', 'ticket_review', 'billing_blocked',
                        'equipment_out_of_service', 'assignment_problem',
                        'delay_report', 'equipment_report', 'urgent_order']) kind
      where exists (select 1 from public.role_permissions rp
                    where rp.company_id = v_company and rp.role = m.role
                      and rp.permission = private.exception_resolve_permission(kind))
        and (kind <> 'delay_report' or exists (select 1 from public.role_permissions rp
                    where rp.company_id = v_company and rp.role = m.role and rp.permission = 'dispatch.view'))
    ) k
    where m.company_id = v_company and m.active and m.role is not null and jsonb_array_length(k.kinds) > 0), '[]');
end;
$$;

-- Same as before (N8) plus urgent orders at the end.
create or replace function private.operational_exceptions(p_company uuid)
returns table (
  exception_key text, kind text, priority integer, since timestamptz,
  order_id uuid, order_number text, customer_name text,
  load_id uuid, load_number integer, load_date date,
  ticket_id uuid, ticket_number text,
  equipment_kind text, equipment_id uuid, unit_number text,
  assignment_id uuid, reasons text[], details jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := private.business_today(p_company);
begin
  -- Past-due loads without a live ticket (billing readiness rule).
  return query
  select 'missing_ticket:' || b.load_id, 'missing_ticket', 2,
         least(b.ends_at, coalesce(o.completed_at, b.ends_at)),
         b.order_id, b.order_number, b.customer_name, b.load_id, b.load_number, b.load_date,
         null::uuid, null::text, null::text, null::uuid, null::text, b.assignment_id,
         array_remove(array[
           case when b.voided_numbers is not null then 'ticket_voided' else 'no_ticket' end,
           case when b.assignment_id is null then 'not_assigned' end], null),
         jsonb_build_object('voided_numbers', to_jsonb(b.voided_numbers), 'order_status', b.order_status)
  from public.billing_load_status b
  join public.orders o on o.id = b.order_id and o.company_id = b.company_id
  where b.company_id = p_company and b.documentation_state = 'missing';

  -- Today's loads that have not ended and have no active assignment.
  return query
  select 'unassigned_load:' || l.id, 'unassigned_load', 1,
         coalesce((select max(a.canceled_at) from public.dispatch_assignments a
                   where a.load_id = l.id and a.company_id = l.company_id), l.created_at),
         o.id, o.order_number, c.name, l.id, l.load_number, l.load_date,
         null::uuid, null::text, null::text, null::uuid, null::text, null::uuid,
         array[case when exists (select 1 from public.dispatch_assignments a
                                 where a.load_id = l.id and a.company_id = l.company_id)
                    then 'assignment_removed' else 'no_assignment' end],
         jsonb_build_object('starts_at', l.starts_at, 'ends_at', l.ends_at)
  from public.order_loads l
  join public.orders o on o.id = l.order_id and o.company_id = l.company_id
  left join public.customers c on c.id = o.customer_id and c.company_id = o.company_id
  where l.company_id = p_company and l.status = 'planned' and l.load_date = v_today and l.ends_at > now()
    and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed')
    and not exists (select 1 from public.dispatch_assignments a
                    where a.load_id = l.id and a.company_id = l.company_id and a.status = 'active');

  -- Tickets waiting for review (current revisions only).
  return query
  select 'ticket_review:' || t.ticket_number, 'ticket_review', case when t.status = 'needs_review' then 2 else 3 end,
         t.created_at,
         t.order_id, t.snapshot ->> 'order_number', t.snapshot ->> 'customer_name', t.load_id,
         (t.snapshot ->> 'load_number')::int, (t.snapshot ->> 'load_date')::date,
         t.id, t.ticket_number, null::text, null::uuid, null::text, null::uuid,
         case when t.status = 'needs_review' and cardinality(t.review_reasons) > 0 then t.review_reasons
              when t.status = 'needs_review' then array['flagged_for_review']
              else array['awaiting_acceptance'] end,
         jsonb_build_object('status', t.status, 'revision', t.revision, 'review_note', t.review_note)
  from public.delivery_tickets t
  where t.company_id = p_company and t.status in ('submitted', 'needs_review');

  -- Orders documented and reviewed but blocked by unacknowledged exceptions.
  return query
  select 'billing_blocked:' || s.order_id, 'billing_blocked', 3, null::timestamptz,
         s.order_id, s.order_number, s.customer_name, null::uuid, null::int, null::date,
         null::uuid, null::text, null::text, null::uuid, null::text, null::uuid,
         array[case when s.last_acknowledged_at is not null then 'acknowledgment_outdated'
                    else 'exceptions_unacknowledged' end],
         jsonb_build_object('exceptions_count', s.exceptions_count)
  from public.billing_order_status s
  where s.company_id = p_company and s.readiness = 'blocked';

  -- Active equipment out of service, with the upcoming loads booked on it.
  return query
  select 'equipment_out_of_service:' || e.kind || ':' || e.id, 'equipment_out_of_service',
         case when e.upcoming > 0 then 2 else 3 end, e.since,
         null::uuid, null::text, null::text, null::uuid, null::int, null::date,
         null::uuid, null::text, e.kind, e.id, e.unit_number, null::uuid,
         array['out_of_service'],
         jsonb_build_object('reason', e.reason, 'expected_return_date', e.expected_return_date, 'upcoming_loads', e.upcoming)
  from (
    select 'truck' as kind, tr.id, tr.unit_number, tr.out_of_service_since as since, tr.out_of_service_reason as reason,
           tr.expected_return_date,
           (select count(*) from public.dispatch_assignments a
             where a.truck_id = tr.id and a.company_id = tr.company_id and a.status = 'active' and a.ends_at > now())::int as upcoming
    from public.trucks tr
    where tr.company_id = p_company and tr.active and tr.service_status = 'out_of_service'
    union all
    select 'trailer', tl.id, tl.unit_number, tl.out_of_service_since, tl.out_of_service_reason, tl.expected_return_date,
           (select count(*) from public.dispatch_assignments a
             where a.trailer_id = tl.id and a.company_id = tl.company_id and a.status = 'active' and a.ends_at > now())::int
    from public.trailers tl
    where tl.company_id = p_company and tl.active and tl.service_status = 'out_of_service'
  ) e;

  -- Upcoming active assignments that the dispatch rules would now refuse, or
  -- whose load falls outside the order's scheduled dates.
  return query
  select 'assignment_problem:' || x.assignment_id, 'assignment_problem',
         case when x.load_date <= v_today + 1 then 1 else 2 end, null::timestamptz,
         x.order_id, x.order_number, x.customer_name, x.load_id, x.load_number, x.load_date,
         null::uuid, null::text, null::text, null::uuid, null::text, x.assignment_id,
         x.blockers, jsonb_build_object('starts_at', x.starts_at, 'truck_id', x.truck_id, 'trailer_id', x.trailer_id, 'driver_id', x.driver_id)
  from (
    select a.id as assignment_id, a.truck_id, a.trailer_id, a.driver_id, a.starts_at,
           l.id as load_id, l.load_number, l.load_date, o.id as order_id, o.order_number, c.name as customer_name,
           array(select jsonb_array_elements_text(
                   private.assignment_eligibility(p_company, a.truck_id, a.trailer_id, a.driver_id, l.load_date) -> 'blockers'))
           || case when o.scheduled_start is null or l.load_date < o.scheduled_start
                        or l.load_date > coalesce(o.scheduled_end, o.scheduled_start)
                   then array['load_outside_schedule'] else '{}'::text[] end as blockers
    from public.dispatch_assignments a
    join public.order_loads l on l.id = a.load_id and l.company_id = a.company_id
    join public.orders o on o.id = l.order_id and o.company_id = l.company_id
    left join public.customers c on c.id = o.customer_id and c.company_id = o.company_id
    where a.company_id = p_company and a.status = 'active' and a.ends_at > now() and l.status = 'planned'
  ) x
  where cardinality(x.blockers) > 0;

  -- Driver field reports not yet resolved (one item per report).
  return query
  select 'field_report:' || r.id,
         case when r.kind in ('delay', 'cannot_complete') then 'delay_report' else 'equipment_report' end,
         case when r.status = 'acknowledged' then 3 when r.kind in ('cannot_complete', 'breakdown') then 1 else 2 end,
         r.created_at,
         r.order_id, r.snapshot ->> 'order_number', r.snapshot ->> 'customer_name', r.load_id,
         (r.snapshot ->> 'load_number')::int, (r.snapshot ->> 'load_date')::date,
         null::uuid, null::text,
         nullif(r.equipment, ''),
         case r.equipment when 'truck' then r.truck_id when 'trailer' then r.trailer_id end,
         case r.equipment when 'truck' then r.snapshot ->> 'truck_unit' when 'trailer' then r.snapshot ->> 'trailer_unit' end,
         r.assignment_id,
         array['report_' || r.kind] || case when r.status = 'acknowledged' then array['report_acknowledged'] else '{}'::text[] end,
         jsonb_build_object('report_id', r.id, 'report_kind', r.kind, 'status', r.status,
                            'driver_name', r.snapshot ->> 'driver_name', 'description', left(r.description, 300))
  from public.field_reports r
  where r.company_id = p_company and r.status in ('open', 'acknowledged');

  -- Urgent orders flagged by the office, until resolved. Unacknowledged ones
  -- (or past their deadline) are urgent; escalation follows the company setting.
  return query
  select 'urgent_order:' || u.id, 'urgent_order',
         case when u.state = 'awaiting_acknowledgement' or (u.needed_by is not null and u.needed_by < now()) then 1
              when u.state = 'assigned' then 3 else 2 end,
         u.flagged_at,
         o.id, o.order_number, c.name, null::uuid, null::int, null::date,
         null::uuid, null::text, null::text, null::uuid, null::text, null::uuid,
         array_remove(array[
           'urgent_' || u.state::text,
           case when u.state = 'awaiting_acknowledgement' and s.urgent_ack_minutes is not null
                     and u.flagged_at < now() - make_interval(mins => s.urgent_ack_minutes) then 'urgent_ack_overdue' end,
           case when u.needed_by is not null and u.needed_by < now() then 'urgent_deadline_passed' end], null),
         jsonb_build_object(
           'urgency_id', u.id, 'state', u.state, 'reason', u.reason, 'needed_by', u.needed_by, 'state_note', u.state_note,
           'flagged_by_name', (select coalesce(nullif(trim(p.full_name), ''), 'Unnamed user') from public.profiles p where p.id = u.flagged_by),
           'acknowledged_by_name', (select coalesce(nullif(trim(p.full_name), ''), 'Unnamed user') from public.profiles p where p.id = u.acknowledged_by),
           'acknowledged_at', u.acknowledged_at,
           'escalated', u.state = 'awaiting_acknowledgement' and s.urgent_ack_minutes is not null
                        and u.flagged_at < now() - make_interval(mins => s.urgent_ack_minutes),
           'order_status', o.status,
           'active_assignments', (select count(*) from public.dispatch_assignments a
                                  join public.order_loads l on l.id = a.load_id and l.company_id = a.company_id
                                  where a.company_id = u.company_id and l.order_id = o.id and a.status = 'active' and l.status = 'planned'))
  from public.order_urgencies u
  join public.orders o on o.id = u.order_id and o.company_id = u.company_id
  join public.company_settings s on s.company_id = u.company_id
  left join public.customers c on c.id = o.customer_id and c.company_id = o.company_id
  where u.company_id = p_company and u.closed_at is null;
end;
$$;

/**
 * Hide a non-urgent item from the caller's own queue for a while. The item stays
 * open, counted and visible to everyone else; urgent items cannot be hidden.
 */
create or replace function public.hide_exception(p_key text, p_hours integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_command_center();
  v_e       record;
  v_until   timestamptz;
begin
  if p_hours is null or p_hours not between 1 and 168 then
    raise exception 'Choose how long to hide it (1 hour to 7 days).' using errcode = '22023';
  end if;
  select * into v_e from private.operational_exceptions(v_company) e
  where e.exception_key = p_key and private.exception_visible(e.kind);
  if not found then
    raise exception 'This item is no longer open. Refresh the command center.' using errcode = 'PT409';
  end if;
  if v_e.priority = 1 then
    raise exception 'Urgent items cannot be hidden.' using errcode = '42501';
  end if;
  v_until := now() + make_interval(hours => p_hours);
  insert into public.exception_dismissals (company_id, user_id, exception_key, kind, hidden_until)
  values (v_company, auth.uid(), p_key, v_e.kind, v_until)
  on conflict (company_id, user_id, exception_key) do update set hidden_until = excluded.hidden_until, created_at = now();
  return jsonb_build_object('hidden_until', v_until);
end;
$$;

create or replace function public.unhide_exception(p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  delete from public.exception_dismissals where company_id = v_company and user_id = auth.uid() and exception_key = p_key;
end;
$$;

drop function public.command_center_exceptions(text, boolean, integer, integer);

/** One page of the queue. Items the caller hid (non-urgent only) are listed separately with p_hidden. */
create or replace function public.command_center_exceptions(p_kind text default null, p_mine boolean default false,
  p_limit integer default 25, p_offset integer default 0, p_hidden boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_command_center();
  v_limit   integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset  integer := greatest(coalesce(p_offset, 0), 0);
  v_result  jsonb;
begin
  if p_kind is not null and private.exception_resolve_permission(p_kind) is null then
    raise exception 'Unknown exception type.';
  end if;

  with visible as (
    select e.*, x.assigned_to, x.assigned_at, x.note as assignment_note, p.full_name as assignee_name,
           case when e.priority > 1 and d.hidden_until > now() then d.hidden_until end as hidden_until
    from private.operational_exceptions(v_company) e
    left join public.exception_assignments x
      on x.company_id = v_company and x.exception_key = e.exception_key and x.ended_at is null
    left join public.profiles p on p.id = x.assigned_to
    left join public.exception_dismissals d
      on d.company_id = v_company and d.user_id = auth.uid() and d.exception_key = e.exception_key
    where private.exception_visible(e.kind)
      and (p_kind is null or e.kind = p_kind)
      and (not coalesce(p_mine, false) or x.assigned_to = auth.uid())
  ), shown as (
    select * from visible where (hidden_until is not null) = coalesce(p_hidden, false)
  ), page as (
    select * from shown
    order by priority, since nulls last, exception_key
    limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from shown),
    'hidden', (select count(*) from visible where hidden_until is not null),
    'limit', v_limit,
    'offset', v_offset,
    'items', coalesce((select jsonb_agg(to_jsonb(page) order by priority, since nulls last, exception_key) from page), '[]'))
  into v_result;
  return v_result;
end;
$$;

-- Same counts as before plus urgent orders, the caller's hidden items and orders
-- scheduled today (previously counted separately by the dashboard).
create or replace function public.command_center_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company  uuid := private.require_command_center();
  v_today    date := private.business_today(v_company);
  v_dispatch boolean := private.has_permission('dispatch.view');
  v_fleet    boolean := private.has_permission('fleet.view');
  v_billing  boolean := private.has_permission('billing.view');
  v_counts   jsonb;
  v_ex       jsonb;
begin
  select coalesce(jsonb_object_agg(kind, n), '{}'), jsonb_build_object(
           'total', coalesce(sum(n), 0), 'urgent', coalesce(sum(urgent), 0), 'mine', coalesce(sum(mine), 0),
           'hidden', coalesce(sum(hidden), 0))
  into v_counts, v_ex
  from (
    select e.kind, count(*)::int as n, count(*) filter (where e.priority = 1)::int as urgent,
           count(*) filter (where exists (select 1 from public.exception_assignments x
                                          where x.company_id = v_company and x.exception_key = e.exception_key
                                            and x.ended_at is null and x.assigned_to = auth.uid()))::int as mine,
           count(*) filter (where e.priority > 1 and exists (select 1 from public.exception_dismissals d
                                          where d.company_id = v_company and d.user_id = auth.uid()
                                            and d.exception_key = e.exception_key and d.hidden_until > now()))::int as hidden
    from private.operational_exceptions(v_company) e
    where private.exception_visible(e.kind)
    group by e.kind
  ) k;

  return jsonb_build_object(
    'as_of', now(),
    'today', v_today,
    'exceptions', v_ex,
    'by_kind', v_counts,
    'orders_today', case when private.has_permission('orders.view') then (
      select count(*) from public.orders o
      -- Same rule as the orders list filter "Scheduled today" (canceled excluded).
      where o.company_id = v_company and o.status <> 'canceled'
        and o.scheduled_start <= v_today and coalesce(o.scheduled_end, o.scheduled_start) >= v_today) end,
    'urgent_orders', case when private.exception_visible('urgent_order') then coalesce((v_counts ->> 'urgent_order')::int, 0) end,
    'loads_today', case when v_dispatch then (
      select count(*) from public.order_loads l join public.orders o on o.id = l.order_id and o.company_id = l.company_id
      where l.company_id = v_company and l.status = 'planned' and l.load_date = v_today
        and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed')) end,
    'loads_today_assigned', case when v_dispatch then (
      select count(*) from public.order_loads l join public.orders o on o.id = l.order_id and o.company_id = l.company_id
      where l.company_id = v_company and l.status = 'planned' and l.load_date = v_today
        and o.status in ('scheduled', 'dispatched', 'in_progress', 'partially_completed', 'completed')
        and exists (select 1 from public.dispatch_assignments a where a.load_id = l.id and a.status = 'active')) end,
    'unassigned_loads', case when private.exception_visible('unassigned_load') then coalesce((v_counts ->> 'unassigned_load')::int, 0) end,
    'assignment_problems', case when private.exception_visible('assignment_problem') then coalesce((v_counts ->> 'assignment_problem')::int, 0) end,
    'trucks_out_of_service', case when v_fleet then (
      select count(*) from public.trucks where company_id = v_company and active and service_status = 'out_of_service') end,
    'trailers_out_of_service', case when v_fleet then (
      select count(*) from public.trailers where company_id = v_company and active and service_status = 'out_of_service') end,
    'tickets_to_review', case when private.exception_visible('ticket_review') then coalesce((v_counts ->> 'ticket_review')::int, 0) end,
    'missing_tickets', case when private.exception_visible('missing_ticket') then coalesce((v_counts ->> 'missing_ticket')::int, 0) end,
    'billing_blocked', case when v_billing then coalesce((v_counts ->> 'billing_blocked')::int, 0) end,
    'driver_reports', case when private.has_permission('field_reports.view') then
      coalesce((v_counts ->> 'delay_report')::int, 0) + coalesce((v_counts ->> 'equipment_report')::int, 0) end,
    'billing_ready', case when v_billing then (
      select count(*) from public.billing_order_status where company_id = v_company and readiness = 'ready') end,
    'can', jsonb_build_object('dispatch', v_dispatch, 'fleet', v_fleet, 'billing', v_billing,
                              'tickets', private.has_permission('tickets.view'),
                              'orders', private.has_permission('orders.view'),
                              'assign', private.has_permission('exceptions.assign')));
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Grants
-- -----------------------------------------------------------------------------
revoke execute on function
  public.flag_order_urgent(uuid, text, timestamptz),
  public.update_order_urgency(uuid, public.urgency_state, text),
  public.save_my_preference(text, jsonb),
  public.hide_exception(text, integer),
  public.unhide_exception(text),
  public.command_center_exceptions(text, boolean, integer, integer, boolean)
from public, anon;
grant execute on function
  public.flag_order_urgent(uuid, text, timestamptz),
  public.update_order_urgency(uuid, public.urgency_state, text),
  public.save_my_preference(text, jsonb),
  public.hide_exception(text, integer),
  public.unhide_exception(text),
  public.command_center_exceptions(text, boolean, integer, integer, boolean)
to authenticated;
revoke execute on function
  private.guard_order_urgency_event(),
  private.guard_order_urgency(),
  private.urgency_event(public.order_urgencies, text, public.urgency_state, text, jsonb),
  private.close_urgency_with_order()
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7. Verification
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.companies c where not exists (
       select 1 from public.role_permissions rp where rp.company_id = c.id and rp.role = 'owner' and rp.permission = 'driver.portal')) then
    raise exception 'Owner driver.portal grant incomplete; aborting.';
  end if;
  if exists (select 1 from information_schema.column_privileges
             where table_schema = 'public' and table_name in ('order_urgencies', 'order_urgency_events', 'user_preferences', 'exception_dismissals')
               and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT') then
    raise exception 'Unexpected write grants on new tables; aborting.';
  end if;
end
$$;
