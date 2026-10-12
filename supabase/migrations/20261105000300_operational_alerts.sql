-- =============================================================================
-- Operational alerts: system-generated alerts with priority, recipients,
-- acknowledgment, escalation and resolution, kept apart from conversations.
--
-- * public.alert_event_types — the system catalog (not editable by companies):
--   each type's category, label, minimum priority (safety floor), defaults.
-- * public.comm_alert_settings — per company and type: enabled, default
--   priority (never below the minimum), acknowledgment scope (any = one
--   responsible recipient acknowledges for the event; all = every designated
--   recipient), escalation interval and escalation roles. Audited.
-- * public.alerts — one row per underlying event (event type + source key).
--   A repeat of the same event while open updates it (occurrences, last time,
--   history); a distinct event gets its own alert. Text never contains leave
--   categories or personal comments.
-- * public.alert_recipients (designated / escalation / reassigned; responsible
--   until explicitly reassigned), public.alert_acknowledgments (who, when, at
--   which priority), public.alert_events (append-only history: created,
--   occurred_again, priority_changed with from/to/reason, acknowledged,
--   escalated, escalation_canceled, reassigned, resolved, policy_changed).
-- * Acknowledgment: Informational needs none; Action Required and Critical
--   follow the type's scope (any = one responsible recipient; all = every
--   designated or reassigned recipient). Reading is never acknowledgment.
-- * Escalation (Critical only): when acknowledgment is outstanding after the
--   interval, escalation recipients are added as responsible and notified; the
--   original recipients stay responsible. Runs from comm_housekeeping() while
--   people use the app (no external scheduler exists).
-- * Critical notifications ignore mutes, quiet hours and the Active-delivery
--   deferral. Drivers are never designated recipients of Critical alerts that
--   need acknowledgment (no acknowledgment can depend on a driver using a phone
--   while driving).
--
-- Depends on 20261105000100/0200, 20261101000100 (work orders), 20261018000100
-- (field reports), 20261102000100 (vehicle documents), 20261104000100 (time off).
-- Rollback: supabase/rollbacks/20261105000300_operational_alerts.down.sql
-- =============================================================================

create table public.alert_event_types (
  code                    text primary key check (code ~ '^[a-z_]+\.[a-z_]+$'),
  category                text not null check (category in ('dispatch', 'maintenance', 'time_off', 'documents', 'announcements')),
  label                   text not null,
  min_priority            text not null check (min_priority in ('informational', 'action_required', 'critical')),
  default_priority        text not null check (default_priority in ('informational', 'action_required', 'critical')),
  default_ack_scope       text not null default 'any' check (default_ack_scope in ('any', 'all')),
  default_escalation_minutes integer not null default 30
);
insert into public.alert_event_types (code, category, label, min_priority, default_priority, default_ack_scope, default_escalation_minutes) values
  ('maintenance.safety_restriction', 'maintenance', 'Safety-critical defect restricts a truck', 'critical', 'critical', 'any', 30),
  ('dispatch.breakdown_report',      'dispatch',    'Driver reported a breakdown or inspection problem', 'action_required', 'critical', 'any', 15),
  ('dispatch.time_off_conflict',     'dispatch',    'Approved time off overlaps assignments', 'action_required', 'action_required', 'any', 60),
  ('dispatch.assignment_canceled',   'dispatch',    'Your assignment was canceled', 'informational', 'informational', 'any', 60),
  ('time_off.requested',             'time_off',    'Time-off request waiting for a decision', 'informational', 'informational', 'any', 60),
  ('time_off.decided',               'time_off',    'Your time-off request was decided', 'informational', 'informational', 'any', 60),
  ('documents.expiring',             'documents',   'Vehicle document expires within 30 days', 'informational', 'action_required', 'any', 1440),
  ('documents.expired',              'documents',   'Vehicle document has expired', 'action_required', 'action_required', 'any', 1440),
  ('announcements.ack_required',     'announcements', 'Announcement needs your acknowledgment', 'informational', 'action_required', 'all', 1440);

create or replace function private.alert_rank(p text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p when 'informational' then 1 when 'action_required' then 2 when 'critical' then 3 end
$$;

create table public.comm_alert_settings (
  company_id          uuid not null references public.companies (id),
  event_type          text not null references public.alert_event_types (code),
  enabled             boolean not null default true,
  default_priority    text not null check (default_priority in ('informational', 'action_required', 'critical')),
  ack_scope           text not null check (ack_scope in ('any', 'all')),
  escalation_minutes  integer not null check (escalation_minutes between 5 and 10080),
  escalation_roles    public.app_role[] not null default '{owner}',
  updated_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now(),
  primary key (company_id, event_type)
);
create trigger comm_alert_settings_audit after insert or update or delete on public.comm_alert_settings
  for each row execute function private.audit_row_change('comm_alert_settings');

create table public.alerts (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id),
  event_type         text not null references public.alert_event_types (code),
  source_key         text not null check (length(source_key) <= 200),
  entity_type        text not null default '' check (length(entity_type) <= 40),
  entity_id          uuid,
  title              text not null check (length(title) <= 200),
  detail             text not null default '' check (length(detail) <= 1000),
  link               text not null default '' check (length(link) <= 300),
  priority           text not null check (priority in ('informational', 'action_required', 'critical')),
  ack_scope          text not null check (ack_scope in ('any', 'all')),
  status             text not null default 'open' check (status in ('open', 'resolved')),
  occurrences        integer not null default 1,
  last_occurred_at   timestamptz not null default clock_timestamp(),
  escalation_due_at  timestamptz,
  escalation_level   integer not null default 0,
  created_at         timestamptz not null default clock_timestamp(),
  resolved_at        timestamptz,
  resolved_by        uuid references auth.users (id) on delete set null,
  resolution_note    text not null default '' check (length(resolution_note) <= 500),
  unique (company_id, id)
);
create unique index alerts_open_source_key on public.alerts (company_id, event_type, source_key) where status = 'open';
create index alerts_company_idx on public.alerts (company_id, status, priority, created_at desc);

create table public.alert_recipients (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id),
  alert_id    uuid not null,
  user_id     uuid not null,
  reason      text not null check (reason in ('designated', 'escalation', 'reassigned', 'informed')),
  responsible boolean not null default true,
  added_at    timestamptz not null default clock_timestamp(),
  released_at timestamptz,
  foreign key (company_id, alert_id) references public.alerts (company_id, id) on delete cascade
);
create unique index alert_recipients_active on public.alert_recipients (alert_id, user_id) where released_at is null;

create table public.alert_acknowledgments (
  company_id      uuid not null references public.companies (id),
  alert_id        uuid not null,
  user_id         uuid not null,
  acknowledged_at timestamptz not null default clock_timestamp(),
  priority_at     text not null,
  note            text not null default '' check (length(note) <= 500),
  primary key (alert_id, user_id),
  foreign key (company_id, alert_id) references public.alerts (company_id, id) on delete cascade
);

create table public.alert_events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id),
  alert_id    uuid not null,
  kind        text not null check (kind in ('created', 'occurred_again', 'priority_changed', 'acknowledged', 'escalated',
                                            'escalation_canceled', 'reassigned', 'resolved', 'policy_changed')),
  details     jsonb not null default '{}'::jsonb,
  actor_id    uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (company_id, alert_id) references public.alerts (company_id, id) on delete cascade
);
create index alert_events_idx on public.alert_events (company_id, alert_id, created_at);

create trigger a_company_guard before update of company_id on public.comm_alert_settings for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.alerts for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.alert_recipients for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.alert_acknowledgments for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.alert_events for each row execute function private.forbid_company_change();

create or replace function private.alert_is_recipient(p_alert uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.alert_recipients r where r.alert_id = p_alert and r.user_id = auth.uid()
                 and r.company_id = private.current_company_id())
$$;

alter table public.alert_event_types enable row level security;
alter table public.comm_alert_settings enable row level security;
alter table public.alerts enable row level security;
alter table public.alert_recipients enable row level security;
alter table public.alert_acknowledgments enable row level security;
alter table public.alert_events enable row level security;
create policy alert_event_types_read on public.alert_event_types for select to authenticated using (true);
create policy comm_alert_settings_read on public.comm_alert_settings for select to authenticated
  using (company_id = (select private.current_company_id()));
create policy alerts_read on public.alerts for select to authenticated
  using (company_id = (select private.current_company_id()) and ((select private.has_permission('comms.alerts')) or private.alert_is_recipient(id)));
create policy alert_recipients_read on public.alert_recipients for select to authenticated
  using (company_id = (select private.current_company_id()) and ((select private.has_permission('comms.alerts')) or private.alert_is_recipient(alert_id)));
create policy alert_acknowledgments_read on public.alert_acknowledgments for select to authenticated
  using (company_id = (select private.current_company_id()) and ((select private.has_permission('comms.alerts')) or private.alert_is_recipient(alert_id)));
create policy alert_events_read on public.alert_events for select to authenticated
  using (company_id = (select private.current_company_id()) and ((select private.has_permission('comms.alerts')) or private.alert_is_recipient(alert_id)));
revoke all on public.alert_event_types, public.comm_alert_settings, public.alerts, public.alert_recipients,
  public.alert_acknowledgments, public.alert_events from anon, authenticated;
grant select on public.alert_event_types, public.comm_alert_settings, public.alerts, public.alert_recipients,
  public.alert_acknowledgments, public.alert_events to authenticated;
grant all on public.alert_event_types, public.comm_alert_settings, public.alerts, public.alert_recipients,
  public.alert_acknowledgments, public.alert_events to service_role;

-- -----------------------------------------------------------------------------
-- Policy, recipients, raising and resolving
-- -----------------------------------------------------------------------------
/** Effective settings for a type (company row or catalog defaults). */
create or replace function private.alert_policy(p_company uuid, p_type text)
returns public.comm_alert_settings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.comm_alert_settings%rowtype;
  t public.alert_event_types%rowtype;
begin
  select * into v from public.comm_alert_settings where company_id = p_company and event_type = p_type;
  if found then return v; end if;
  select * into t from public.alert_event_types where code = p_type;
  v.company_id := p_company; v.event_type := p_type; v.enabled := true; v.default_priority := t.default_priority;
  v.ack_scope := t.default_ack_scope; v.escalation_minutes := t.default_escalation_minutes; v.escalation_roles := '{owner}';
  return v;
end;
$$;

/** Members holding any of the given permissions. */
create or replace function private.alert_users_with(p_company uuid, p_permissions text[])
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct m.user_id), '{}')
  from public.company_memberships m
  join public.role_permissions rp on rp.company_id = m.company_id and rp.role = m.role
  where m.company_id = p_company and m.active and rp.permission = any (p_permissions)
$$;

/** Is acknowledgment still outstanding (and from whom)? */
create or replace function private.alert_outstanding(p_alert uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.alerts%rowtype;
begin
  select * into a from public.alerts where id = p_alert;
  if a.status <> 'open' or a.priority = 'informational' then return '{}'; end if;
  if a.ack_scope = 'any' then
    if exists (select 1 from public.alert_acknowledgments k join public.alert_recipients r on r.alert_id = k.alert_id and r.user_id = k.user_id
               where k.alert_id = p_alert) then
      return '{}';
    end if;
    return coalesce((select array_agg(r.user_id) from public.alert_recipients r where r.alert_id = p_alert and r.responsible and r.released_at is null), '{}');
  end if;
  -- Scope 'all': every designated (or reassigned) responsible recipient must acknowledge.
  return coalesce((select array_agg(r.user_id) from public.alert_recipients r
                   where r.alert_id = p_alert and r.responsible and r.released_at is null and r.reason in ('designated', 'reassigned')
                     and not exists (select 1 from public.alert_acknowledgments k where k.alert_id = p_alert and k.user_id = r.user_id)), '{}');
end;
$$;

/**
 * Raise (or update) the alert for one underlying event. Returns the alert id, or
 * null when the company disabled the type. p_priority null = the company default.
 */
create or replace function private.comm_raise_alert(
  p_company uuid, p_type text, p_source_key text, p_entity_type text, p_entity_id uuid,
  p_title text, p_detail text, p_link text, p_recipients uuid[], p_priority text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  pol public.comm_alert_settings%rowtype := private.alert_policy(p_company, p_type);
  t   public.alert_event_types%rowtype;
  v_id uuid;
  v_priority text;
  u uuid;
begin
  if not pol.enabled then return null; end if;
  select * into t from public.alert_event_types where code = p_type;
  select id into v_id from public.alerts where company_id = p_company and event_type = p_type and source_key = p_source_key and status = 'open' for update;
  if found then
    update public.alerts set occurrences = occurrences + 1, last_occurred_at = clock_timestamp(),
      detail = left(coalesce(p_detail, detail), 1000) where id = v_id;
    insert into public.alert_events (company_id, alert_id, kind, details) values (p_company, v_id, 'occurred_again', jsonb_build_object('detail', p_detail));
    return v_id;
  end if;
  v_priority := coalesce(p_priority, pol.default_priority);
  if private.alert_rank(v_priority) < private.alert_rank(t.min_priority) then v_priority := t.min_priority; end if;
  insert into public.alerts (company_id, event_type, source_key, entity_type, entity_id, title, detail, link, priority, ack_scope, escalation_due_at)
  values (p_company, p_type, p_source_key, coalesce(p_entity_type, ''), p_entity_id, left(p_title, 200), left(coalesce(p_detail, ''), 1000),
          left(coalesce(p_link, ''), 300), v_priority, pol.ack_scope,
          case when v_priority = 'critical' then clock_timestamp() + make_interval(mins => pol.escalation_minutes) end)
  returning id into v_id;
  insert into public.alert_events (company_id, alert_id, kind, details) values (p_company, v_id, 'created', jsonb_build_object('priority', v_priority));
  foreach u in array coalesce(p_recipients, '{}'::uuid[]) loop
    insert into public.alert_recipients (company_id, alert_id, user_id, reason, responsible)
    values (p_company, v_id, u, case when v_priority = 'informational' then 'informed' else 'designated' end, v_priority <> 'informational')
    on conflict do nothing;
    perform private.comm_notify(p_company, u, 'alert', p_title, '/communications/alerts/' || v_id, null, v_id, v_priority = 'critical');
  end loop;
  return v_id;
end;
$$;

/** Resolve the open alert of an event (automatic or by hand). Resolution is separate from acknowledgment. */
create or replace function private.comm_resolve_alert(p_company uuid, p_type text, p_source_key text, p_note text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.alerts%rowtype;
  u uuid;
begin
  select * into a from public.alerts where company_id = p_company and event_type = p_type and source_key = p_source_key and status = 'open' for update;
  if not found then return null; end if;
  update public.alerts set status = 'resolved', resolved_at = clock_timestamp(), resolved_by = auth.uid(),
    resolution_note = left(coalesce(p_note, ''), 500), escalation_due_at = null where id = a.id;
  insert into public.alert_events (company_id, alert_id, kind, details, actor_id)
  values (p_company, a.id, 'resolved', jsonb_build_object('note', p_note, 'outstanding_at_resolution', to_jsonb(private.alert_outstanding(a.id))), auth.uid());
  -- A linked resolution notice for anything beyond awareness.
  if a.priority <> 'informational' then
    for u in select distinct r.user_id from public.alert_recipients r where r.alert_id = a.id loop
      perform private.comm_notify(p_company, u, 'alert', 'Resolved: ' || a.title, '/communications/alerts/' || a.id, null, a.id, false);
    end loop;
  end if;
  return a.id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Actions on alerts (recipients / comms.alerts)
-- -----------------------------------------------------------------------------
create or replace function public.comm_alert_acknowledge(p_alert uuid, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  a public.alerts%rowtype;
  v_out uuid[];
begin
  select * into a from public.alerts where id = p_alert and company_id = v_company for update;
  if not found then raise exception 'Alert not found.' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.alert_recipients where alert_id = p_alert and user_id = auth.uid() and responsible and released_at is null) then
    raise exception 'Only responsible recipients can acknowledge this alert.' using errcode = '42501';
  end if;
  insert into public.alert_acknowledgments (company_id, alert_id, user_id, priority_at, note)
  values (v_company, p_alert, auth.uid(), a.priority, left(coalesce(p_note, ''), 500))
  on conflict (alert_id, user_id) do nothing;
  if found then
    insert into public.alert_events (company_id, alert_id, kind, details, actor_id) values (v_company, p_alert, 'acknowledged', jsonb_build_object('priority', a.priority), auth.uid());
  end if;
  v_out := private.alert_outstanding(p_alert);
  if cardinality(v_out) = 0 and a.escalation_due_at is not null then
    update public.alerts set escalation_due_at = null where id = p_alert;
  end if;
  return jsonb_build_object('outstanding', to_jsonb(v_out));
end;
$$;

create or replace function public.comm_alert_set_priority(p_alert uuid, p_priority text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  a public.alerts%rowtype;
  t public.alert_event_types%rowtype;
  pol public.comm_alert_settings%rowtype;
  v_out uuid[];
  u uuid;
begin
  perform private.require_permission('comms.alerts');
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason for changing the priority.' using errcode = 'P0001'; end if;
  select * into a from public.alerts where id = p_alert and company_id = v_company for update;
  if not found then raise exception 'Alert not found.' using errcode = 'P0002'; end if;
  if a.status <> 'open' then raise exception 'Only an open alert can change priority.' using errcode = 'P0001'; end if;
  select * into t from public.alert_event_types where code = a.event_type;
  if private.alert_rank(p_priority) is null then raise exception 'Choose a priority.'; end if;
  if private.alert_rank(p_priority) < private.alert_rank(t.min_priority) then
    raise exception 'This kind of alert cannot be lower than % (safety minimum).', replace(t.min_priority, '_', ' ') using errcode = 'P0001';
  end if;
  if p_priority = a.priority then return jsonb_build_object('unchanged', true); end if;
  pol := private.alert_policy(v_company, a.event_type);
  update public.alerts set priority = p_priority,
    escalation_due_at = case when p_priority = 'critical' then coalesce(escalation_due_at, clock_timestamp() + make_interval(mins => pol.escalation_minutes)) else null end
  where id = p_alert;
  -- Recipients who were only informed become responsible when follow-up is now needed.
  if p_priority <> 'informational' then
    update public.alert_recipients set responsible = true, reason = 'designated' where alert_id = p_alert and reason = 'informed' and released_at is null;
  end if;
  insert into public.alert_events (company_id, alert_id, kind, details, actor_id)
  values (v_company, p_alert, 'priority_changed', jsonb_build_object('from', a.priority, 'to', p_priority, 'reason', p_reason), auth.uid());
  if a.priority = 'critical' and p_priority <> 'critical' and a.escalation_due_at is not null then
    insert into public.alert_events (company_id, alert_id, kind, details, actor_id) values (v_company, p_alert, 'escalation_canceled', jsonb_build_object('reason', 'priority lowered'), auth.uid());
  end if;
  v_out := private.alert_outstanding(p_alert);
  for u in select distinct r.user_id from public.alert_recipients r where r.alert_id = p_alert and r.released_at is null loop
    perform private.comm_notify(v_company, u, 'alert', 'Priority changed to ' || replace(p_priority, '_', ' ') || ': ' || a.title,
                                '/communications/alerts/' || p_alert, null, p_alert, p_priority = 'critical');
  end loop;
  return jsonb_build_object('outstanding', to_jsonb(v_out));
end;
$$;

/** Explicitly move responsibility from one recipient to another (the only way responsibility ends). */
create or replace function public.comm_alert_reassign(p_alert uuid, p_from uuid, p_to uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  a public.alerts%rowtype;
begin
  perform private.require_permission('comms.alerts');
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason for the reassignment.' using errcode = 'P0001'; end if;
  select * into a from public.alerts where id = p_alert and company_id = v_company for update;
  if not found then raise exception 'Alert not found.' using errcode = 'P0002'; end if;
  perform private.comm_require_coworker(v_company, p_to);
  update public.alert_recipients set responsible = false, released_at = clock_timestamp()
  where alert_id = p_alert and user_id = p_from and released_at is null;
  if not found then raise exception 'That person is not a current recipient.' using errcode = 'P0002'; end if;
  insert into public.alert_recipients (company_id, alert_id, user_id, reason, responsible) values (v_company, p_alert, p_to, 'reassigned', true)
  on conflict (alert_id, user_id) where released_at is null do update set responsible = true, reason = 'reassigned';
  insert into public.alert_events (company_id, alert_id, kind, details, actor_id)
  values (v_company, p_alert, 'reassigned', jsonb_build_object('from', p_from, 'to', p_to, 'reason', p_reason), auth.uid());
  perform private.comm_notify(v_company, p_to, 'alert', 'Assigned to you: ' || a.title, '/communications/alerts/' || p_alert, null, p_alert, a.priority = 'critical');
end;
$$;

create or replace function public.comm_alert_resolve(p_alert uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  a public.alerts%rowtype;
begin
  perform private.require_permission('comms.alerts');
  if length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Describe how it was resolved.' using errcode = 'P0001'; end if;
  select * into a from public.alerts where id = p_alert and company_id = v_company;
  if not found then raise exception 'Alert not found.' using errcode = 'P0002'; end if;
  if a.status <> 'open' then raise exception 'This alert is already resolved.' using errcode = 'P0001'; end if;
  perform private.comm_resolve_alert(v_company, a.event_type, a.source_key, p_note);
end;
$$;

/** Company alert settings (comms.admin). Defaults never go below the safety minimum. */
create or replace function public.comm_save_alert_setting(p_type text, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  t public.alert_event_types%rowtype;
  pol public.comm_alert_settings%rowtype;
  v_priority text;
begin
  perform private.require_permission('comms.admin');
  select * into t from public.alert_event_types where code = p_type;
  if not found then raise exception 'Unknown alert type.' using errcode = 'P0002'; end if;
  pol := private.alert_policy(v_company, p_type);
  v_priority := coalesce(nullif(p ->> 'default_priority', ''), pol.default_priority);
  if private.alert_rank(v_priority) < private.alert_rank(t.min_priority) then
    raise exception '% cannot be lower than % (safety minimum).', t.label, replace(t.min_priority, '_', ' ') using errcode = 'P0001';
  end if;
  if t.min_priority = 'critical' and (p ->> 'enabled')::boolean is false then
    raise exception '% is a safety alert and cannot be turned off.', t.label using errcode = 'P0001';
  end if;
  insert into public.comm_alert_settings (company_id, event_type, enabled, default_priority, ack_scope, escalation_minutes, escalation_roles, updated_by, updated_at)
  values (v_company, p_type, coalesce((p ->> 'enabled')::boolean, pol.enabled), v_priority,
          coalesce(nullif(p ->> 'ack_scope', ''), pol.ack_scope), coalesce((p ->> 'escalation_minutes')::integer, pol.escalation_minutes),
          coalesce((select array_agg(x::public.app_role) from jsonb_array_elements_text(p -> 'escalation_roles') x), pol.escalation_roles),
          auth.uid(), now())
  on conflict (company_id, event_type) do update set enabled = excluded.enabled, default_priority = excluded.default_priority,
    ack_scope = excluded.ack_scope, escalation_minutes = excluded.escalation_minutes, escalation_roles = excluded.escalation_roles,
    updated_by = auth.uid(), updated_at = now();
end;
$$;

-- -----------------------------------------------------------------------------
-- Escalation and document checks (from comm_housekeeping)
-- -----------------------------------------------------------------------------
create or replace function private.comm_escalate_due(p_company uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.alerts%rowtype;
  pol public.comm_alert_settings%rowtype;
  u uuid;
  v_n integer := 0;
  v_to uuid[];
begin
  for a in select * from public.alerts where company_id = p_company and status = 'open' and priority = 'critical'
             and escalation_due_at is not null and escalation_due_at <= clock_timestamp() for update skip locked loop
    if cardinality(private.alert_outstanding(a.id)) = 0 then
      update public.alerts set escalation_due_at = null where id = a.id;
      continue;
    end if;
    pol := private.alert_policy(p_company, a.event_type);
    select coalesce(array_agg(m.user_id), '{}') into v_to from public.company_memberships m
    where m.company_id = p_company and m.active and m.role = any (pol.escalation_roles);
    foreach u in array v_to loop
      insert into public.alert_recipients (company_id, alert_id, user_id, reason, responsible) values (p_company, a.id, u, 'escalation', true)
      on conflict (alert_id, user_id) where released_at is null do nothing;
      perform private.comm_notify(p_company, u, 'alert', 'Escalated: ' || a.title, '/communications/alerts/' || a.id, null, a.id, true);
    end loop;
    insert into public.alert_events (company_id, alert_id, kind, details)
    values (p_company, a.id, 'escalated', jsonb_build_object('level', a.escalation_level + 1, 'to', to_jsonb(v_to), 'outstanding', to_jsonb(private.alert_outstanding(a.id))));
    update public.alerts set escalation_level = escalation_level + 1,
      escalation_due_at = case when escalation_level + 1 < 3 then clock_timestamp() + make_interval(mins => pol.escalation_minutes) end
    where id = a.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create or replace function private.comm_document_alerts(p_company uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
  v_today date := private.business_today(p_company);
  v_to uuid[] := private.alert_users_with(p_company, array['fleet.edit']);
  v_n integer := 0;
begin
  for d in
    select v.id, v.kind, v.expires_on, coalesce(t.unit_number, r.unit_number) as unit, case when v.truck_id is not null then 'trucks' else 'trailers' end as path,
           coalesce(v.truck_id, v.trailer_id) as vehicle_id
    from public.vehicle_documents v
    left join public.trucks t on t.id = v.truck_id
    left join public.trailers r on r.id = v.trailer_id
    where v.company_id = p_company and v.archived_at is null and v.expires_on is not null and v.expires_on <= v_today + 30
  loop
    if d.expires_on < v_today then
      perform private.comm_resolve_alert(p_company, 'documents.expiring', d.id::text, 'Expired');
      if private.comm_raise_alert(p_company, 'documents.expired', d.id::text, 'vehicle_document', d.id,
           'Expired: ' || d.unit || ' ' || replace(d.kind, '_', ' '), 'Expired on ' || d.expires_on, '/fleet/' || d.path || '/' || d.vehicle_id, v_to) is not null then
        v_n := v_n + 1;
      end if;
    elsif not exists (select 1 from public.alerts where company_id = p_company and event_type = 'documents.expiring' and source_key = d.id::text and status = 'open') then
      perform private.comm_raise_alert(p_company, 'documents.expiring', d.id::text, 'vehicle_document', d.id,
        d.unit || ' ' || replace(d.kind, '_', ' ') || ' expires ' || d.expires_on, '', '/fleet/' || d.path || '/' || d.vehicle_id, v_to);
      v_n := v_n + 1;
    end if;
  end loop;
  -- Archived or renewed documents: resolve their alerts.
  perform private.comm_resolve_alert(p_company, x.event_type, x.source_key, 'Document renewed or archived')
  from public.alerts x
  where x.company_id = p_company and x.status = 'open' and x.event_type in ('documents.expiring', 'documents.expired')
    and not exists (select 1 from public.vehicle_documents v where v.id::text = x.source_key and v.archived_at is null
                    and v.expires_on is not null and v.expires_on <= v_today + 30);
  return v_n;
end;
$$;

-- Workspaces with an open Critical alert on one of their loads or trucks are not archived.
create or replace function private.comm_operation_can_archive(p_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1 from public.alerts a
    join public.operation_workspaces w on w.conversation_id = p_conversation and w.company_id = a.company_id
    where a.status = 'open' and a.priority = 'critical'
      and (a.entity_id = any (w.load_ids)
           or a.entity_id in (select l.id from public.order_loads l where l.order_id = any (w.order_ids))
           or a.entity_id in (select da.truck_id from public.dispatch_assignments da where da.load_id = any (w.load_ids)
                              or da.load_id in (select l.id from public.order_loads l where l.order_id = any (w.order_ids)))))
$$;

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
  return jsonb_build_object(
    'escalated', private.comm_escalate_due(v_company),
    'documents', private.comm_document_alerts(v_company),
    'archived', private.comm_archive_finished(v_company),
    'retention', private.comm_apply_retention(v_company));
end;
$$;

-- -----------------------------------------------------------------------------
-- Sources (triggers): the alert commits with the event that caused it.
-- -----------------------------------------------------------------------------
create or replace function private.alerts_from_work_orders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unit text;
begin
  select unit_number into v_unit from public.trucks where id = new.truck_id;
  if new.safety_critical and new.status not in ('completed', 'closed', 'canceled')
     and (tg_op = 'INSERT' or not old.safety_critical or old.status in ('completed', 'closed', 'canceled')) then
    perform private.comm_raise_alert(new.company_id, 'maintenance.safety_restriction', new.id::text, 'truck', new.truck_id,
      'Truck ' || v_unit || ' restricted: ' || new.title, 'Work order ' || new.number || '. The truck cannot be dispatched until cleared.',
      '/maintenance/work-orders/' || new.id, private.alert_users_with(new.company_id, array['comms.alerts', 'maintenance.clear']));
  elsif tg_op = 'UPDATE' and old.safety_critical and (new.status in ('completed', 'closed', 'canceled') or not new.safety_critical) then
    perform private.comm_resolve_alert(new.company_id, 'maintenance.safety_restriction', new.id::text,
      case when new.clearance_status = 'cleared' then 'Cleared for service after inspection' when new.status = 'canceled' then 'Work order canceled'
           else 'Safety-critical flag removed' end);
  end if;
  return null;
end;
$$;
create trigger alerts_work_orders after insert or update of status, safety_critical on public.work_orders
  for each row execute function private.alerts_from_work_orders();

create or replace function private.alerts_from_field_reports()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.kind in ('breakdown', 'inspection_issue') then
    perform private.comm_raise_alert(new.company_id, 'dispatch.breakdown_report', new.id::text, 'load', new.load_id,
      case when new.kind = 'breakdown' then 'Breakdown reported' else 'Inspection problem reported' end ||
        coalesce(' — truck ' || (new.snapshot ->> 'truck_unit'), ''),
      coalesce(new.snapshot ->> 'order_number', '') || ' load ' || coalesce(new.snapshot ->> 'load_number', ''),
      '/field-reports/' || new.id, private.alert_users_with(new.company_id, array['comms.alerts', 'field_reports.manage']));
  elsif tg_op = 'UPDATE' and new.status = 'resolved' and old.status <> 'resolved' then
    perform private.comm_resolve_alert(new.company_id, 'dispatch.breakdown_report', new.id::text, 'Report resolved: ' || new.resolution_note);
  end if;
  return null;
end;
$$;
create trigger alerts_field_reports after insert or update of status on public.field_reports
  for each row execute function private.alerts_from_field_reports();

create or replace function private.alerts_from_assignments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_label text;
begin
  if new.status = 'canceled' and old.status = 'active' then
    select user_id into v_user from public.drivers where id = new.driver_id;
    if v_user is not null then
      select o.order_number || ' load ' || l.load_number into v_label from public.order_loads l join public.orders o on o.id = l.order_id where l.id = new.load_id;
      perform private.comm_raise_alert(new.company_id, 'dispatch.assignment_canceled', new.id::text, 'load', new.load_id,
        'Your assignment on ' || coalesce(v_label, 'a load') || ' was canceled', 'Check My Day for your current loads.', '/driver', array[v_user]);
    end if;
  end if;
  return null;
end;
$$;
create trigger alerts_assignments after update of status on public.dispatch_assignments
  for each row execute function private.alerts_from_assignments();

create or replace function private.alerts_from_time_off()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_emp public.employees%rowtype;
  v_conf jsonb;
  v_when text;
begin
  select * into v_emp from public.employees where id = new.employee_id;
  v_when := case when new.start_date = new.end_date then to_char(new.start_date, 'Mon FMDD') else to_char(new.start_date, 'Mon FMDD') || '–' || to_char(new.end_date, 'Mon FMDD') end;
  if tg_op = 'INSERT' and new.status = 'pending' then
    -- Never the category or the comment.
    perform private.comm_raise_alert(new.company_id, 'time_off.requested', new.id::text, 'time_off_request', new.id,
      'Time off requested: ' || v_emp.full_name || ', ' || v_when, '', '/time-off/' || new.id,
      private.alert_users_with(new.company_id, array['time_off.approve']));
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status <> 'pending' then
    perform private.comm_resolve_alert(new.company_id, 'time_off.requested', new.id::text, initcap(new.status));
    if new.status in ('approved', 'denied') and v_emp.user_id is not null then
      perform private.comm_raise_alert(new.company_id, 'time_off.decided', new.id::text, 'time_off_request', new.id,
        'Your time off (' || v_when || ') was ' || new.status, '', '/time-off/' || new.id, array[v_emp.user_id]);
    end if;
    if new.status = 'approved' then
      v_conf := private.time_off_assignment_conflicts(new.company_id, new.id);
      if jsonb_array_length(v_conf) > 0 then
        perform private.comm_raise_alert(new.company_id, 'dispatch.time_off_conflict', new.id::text, 'time_off_request', new.id,
          v_emp.full_name || ' is on approved leave ' || v_when || ' but has ' || jsonb_array_length(v_conf) || ' assignment(s)',
          'Review and reassign in Dispatch.', '/time-off/' || new.id, private.alert_users_with(new.company_id, array['comms.alerts']));
      end if;
    end if;
  elsif tg_op = 'UPDATE' and old.status = 'approved' and new.status = 'canceled' then
    perform private.comm_resolve_alert(new.company_id, 'dispatch.time_off_conflict', new.id::text, 'Leave canceled');
  end if;
  return null;
end;
$$;
create trigger alerts_time_off after insert or update of status on public.time_off_requests
  for each row execute function private.alerts_from_time_off();

create or replace function private.alerts_from_announcements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_to uuid[];
begin
  if new.requires_ack and new.status = 'published' then
    select coalesce(array_agg(m.user_id), '{}') into v_to from public.company_memberships m
    where m.company_id = new.company_id and m.active and m.role is not null and m.user_id is distinct from new.published_by
      and (new.department is null or exists (select 1 from public.employees e where e.company_id = new.company_id and e.user_id = m.user_id and e.department = new.department));
    perform private.comm_raise_alert(new.company_id, 'announcements.ack_required', new.id::text, 'announcement', new.id,
      'Please acknowledge: ' || new.title, '', '/communications/announcements/' || new.id, v_to);
  end if;
  return null;
end;
$$;
create trigger alerts_announcements after insert on public.announcements
  for each row execute function private.alerts_from_announcements();

/** Acknowledging the announcement acknowledges its alert; when everyone has, it resolves. */
create or replace function private.alerts_from_announcement_receipts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alert uuid;
begin
  if new.acknowledged_at is not null and (tg_op = 'INSERT' or old.acknowledged_at is null) then
    select id into v_alert from public.alerts where company_id = new.company_id and event_type = 'announcements.ack_required'
      and source_key = new.announcement_id::text and status = 'open';
    if v_alert is not null and exists (select 1 from public.alert_recipients where alert_id = v_alert and user_id = new.user_id and released_at is null) then
      insert into public.alert_acknowledgments (company_id, alert_id, user_id, priority_at) select new.company_id, v_alert, new.user_id, priority from public.alerts where id = v_alert
      on conflict do nothing;
      insert into public.alert_events (company_id, alert_id, kind, details, actor_id) values (new.company_id, v_alert, 'acknowledged', '{}'::jsonb, new.user_id);
      if not exists (select 1 from public.alert_recipients r where r.alert_id = v_alert and r.released_at is null
                     and not exists (select 1 from public.alert_acknowledgments k where k.alert_id = v_alert and k.user_id = r.user_id)) then
        perform private.comm_resolve_alert(new.company_id, 'announcements.ack_required', new.announcement_id::text, 'Everyone acknowledged');
      end if;
    end if;
  end if;
  return null;
end;
$$;
create trigger alerts_announcement_receipts after insert or update of acknowledged_at on public.announcement_receipts
  for each row execute function private.alerts_from_announcement_receipts();

/** Open alert counts for the caller (for badges): total open, critical, and those waiting for the caller's acknowledgment. */
create or replace function public.comm_alert_counts()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'open', count(*) filter (where a.status = 'open'),
    'critical', count(*) filter (where a.status = 'open' and a.priority = 'critical'),
    'mine', count(*) filter (where a.status = 'open' and auth.uid() = any (private.alert_outstanding(a.id))))
  from public.alerts a
  where a.company_id = private.require_company()
    and exists (select 1 from public.alert_recipients r where r.alert_id = a.id and r.user_id = auth.uid() and r.released_at is null)
$$;

do $$
declare f text;
begin
  foreach f in array array['public.comm_alert_acknowledge(uuid, text)', 'public.comm_alert_set_priority(uuid, text, text)',
    'public.comm_alert_reassign(uuid, uuid, uuid, text)', 'public.comm_alert_resolve(uuid, text)', 'public.comm_save_alert_setting(text, jsonb)',
    'public.comm_alert_counts()', 'public.comm_housekeeping()'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['private.alert_policy(uuid, text)', 'private.alert_users_with(uuid, text[])',
    'private.comm_raise_alert(uuid, text, text, text, uuid, text, text, text, uuid[], text)', 'private.comm_resolve_alert(uuid, text, text, text)',
    'private.comm_escalate_due(uuid)', 'private.comm_document_alerts(uuid)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end;
$$;
