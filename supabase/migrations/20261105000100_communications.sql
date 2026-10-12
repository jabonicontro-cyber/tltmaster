-- =============================================================================
-- Employee Communications — core: direct messages, group conversations,
-- department channels, announcements, presence and work status, notification
-- preferences, quiet hours, mutes and in-app notifications.
--
-- Design (docs/COMMUNICATIONS.md):
-- * One conversation model: kind = direct | group | channel | operation
--   (operation workspaces: 20261105000200). Membership is kept as periods
--   (conversation_members rows with joined_at/left_at): leaving ends a period,
--   rejoining starts a new one, nothing is deleted.
-- * Who may read a message is decided in the database by
--   private.comm_message_visible(): a membership period that covers the
--   message's time (history_from ≤ created_at ≤ left_at). Messages pinned as
--   current context are visible to current members regardless (handoff in
--   operation workspaces). Former members keep read-only access to what they
--   could see; they never see anything written after they left.
-- * All writes go through SECURITY DEFINER functions that check the caller's
--   company, membership and permission. Tables are read-only to clients.
-- * Edits and deletions never rewrite silently: the previous text goes to
--   message_revisions (readable only with comms.admin) and the message shows
--   "edited" / "deleted".
-- * Receipts: per-member cursors (last_delivered_at, last_read_at). A message is
--   delivered/read for a member when the cursor passed its time.
-- * Presence is manual (available/busy/away) or inferred Away after inactivity
--   (an estimate). Work status is computed: Out of office (approved time off
--   now), Active delivery (an active assignment whose window contains now and
--   whose load has no delivery ticket yet), otherwise Unknown — Taviron has no
--   work schedules, so Working hours / Outside working hours are not claimed.
--   Neither is ever availability, eligibility or hours-of-service compliance.
-- * Notifications are in-app only. Mutes, quiet hours and the Active-delivery
--   policy defer routine notifications (the message itself is never held back);
--   deferred active-delivery notifications are released as ONE catch-up
--   notification when the delivery ends.
--
-- Depends on 20261031000100 (employees), 20261104000100 (time off).
-- Rollback: supabase/rollbacks/20261105000100_communications.down.sql
-- =============================================================================

insert into public.permissions (code, category, description) values
  ('comms.message',         'Communications', 'Send direct messages and post in conversations and channels you belong to'),
  ('comms.groups',    'Communications', 'Start group conversations'),
  ('comms.channels', 'Communications', 'Create department channels and manage their members'),
  ('comms.announce',        'Communications', 'Publish company and department announcements'),
  ('comms.operations',      'Communications', 'Create and manage dispatch-linked operational workspaces'),
  ('comms.alerts',   'Communications', 'Change alert priority, reassign, resolve operational alerts'),
  ('comms.admin',           'Communications', 'Configure communications, delete any message, audited administrative search');

insert into public.role_permission_defaults (role, permission) values
  ('owner', 'comms.message'), ('owner', 'comms.groups'), ('owner', 'comms.channels'), ('owner', 'comms.announce'),
  ('owner', 'comms.operations'), ('owner', 'comms.alerts'), ('owner', 'comms.admin'),
  ('office', 'comms.message'), ('office', 'comms.groups'), ('office', 'comms.channels'), ('office', 'comms.announce'),
  ('dispatcher', 'comms.message'), ('dispatcher', 'comms.groups'), ('dispatcher', 'comms.operations'), ('dispatcher', 'comms.alerts'),
  ('mechanic', 'comms.message'),
  ('driver', 'comms.message');

insert into public.role_permissions (company_id, role, permission)
select c.id, d.role, d.permission
from public.companies c cross join public.role_permission_defaults d
where d.permission like 'comms.%'
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Company settings (one row per company; defaults apply until saved)
-- -----------------------------------------------------------------------------
create table public.comm_settings (
  company_id               uuid primary key references public.companies (id),
  edit_window_minutes      integer not null default 15 check (edit_window_minutes between 0 and 1440),
  members_delete_own       boolean not null default true,
  history_for_new_members  text not null default 'from_join' check (history_for_new_members in ('from_join', 'full')),
  retention_days           integer check (retention_days between 30 and 3650),
  legal_hold               boolean not null default false,
  away_after_minutes       integer not null default 15 check (away_after_minutes between 5 and 240),
  delivery_notifications   text not null default 'defer' check (delivery_notifications in ('notice', 'defer')),
  workspace_archive_hours  integer not null default 24 check (workspace_archive_hours between 0 and 720),
  updated_by               uuid references auth.users (id) on delete set null,
  updated_at               timestamptz not null default now()
);
create trigger a_company_guard before update of company_id on public.comm_settings
  for each row execute function private.forbid_company_change();
create trigger comm_settings_audit after insert or update or delete on public.comm_settings
  for each row execute function private.audit_row_change('comm_settings');

/** The company's settings, with defaults when none are saved. */
create or replace function private.comm_settings_of(p_company uuid)
returns public.comm_settings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.comm_settings%rowtype;
begin
  select * into v from public.comm_settings where company_id = p_company;
  if not found then
    v.company_id := p_company;
    v.edit_window_minutes := 15; v.members_delete_own := true; v.history_for_new_members := 'from_join';
    v.retention_days := null; v.legal_hold := false; v.away_after_minutes := 15; v.delivery_notifications := 'defer';
    v.workspace_archive_hours := 24;
  end if;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Conversations, membership periods, messages
-- -----------------------------------------------------------------------------
create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id),
  kind            text not null check (kind in ('direct', 'group', 'channel', 'operation')),
  title           text not null default '' check (length(title) <= 120),
  title_custom    boolean not null default false,
  description     text not null default '' check (length(description) <= 500),
  department      text check (department in ('operations', 'dispatch', 'office', 'shop', 'sales', 'management', 'other')),
  direct_key      text,
  history_policy  text not null default 'from_join' check (history_policy in ('from_join', 'full')),
  members_can_add boolean not null default true,
  status          text not null default 'active' check (status in ('active', 'closed', 'archived')),
  closed_at       timestamptz,
  closed_by       uuid references auth.users (id) on delete set null,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz,
  unique (company_id, id),
  constraint conversations_direct check ((kind = 'direct') = (direct_key is not null)),
  constraint conversations_channel_title check (kind <> 'channel' or length(trim(title)) > 0)
);
create unique index conversations_direct_key on public.conversations (company_id, direct_key) where direct_key is not null;
create index conversations_company_idx on public.conversations (company_id, kind, last_message_at desc);

create table public.conversation_members (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id),
  conversation_id  uuid not null,
  user_id          uuid not null,
  role             text not null default 'member' check (role in ('member', 'manager')),
  source           text not null default 'manual' check (source in ('manual', 'dispatch', 'creator')),
  joined_at        timestamptz not null default clock_timestamp(),
  history_from     timestamptz not null default clock_timestamp(),
  left_at          timestamptz,
  left_reason      text not null default '' check (length(left_reason) <= 300),
  muted_until      timestamptz,
  last_delivered_at timestamptz,
  last_read_at     timestamptz,
  foreign key (company_id, conversation_id) references public.conversations (company_id, id) on delete cascade,
  foreign key (company_id, user_id) references public.company_memberships (company_id, user_id) on delete cascade,
  constraint conversation_members_period check (left_at is null or left_at >= joined_at)
);
create unique index conversation_members_active_key on public.conversation_members (conversation_id, user_id) where left_at is null;
create index conversation_members_user_idx on public.conversation_members (company_id, user_id, left_at);

create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id),
  conversation_id  uuid not null,
  author_id        uuid references auth.users (id) on delete set null,
  kind             text not null default 'text' check (kind in ('text', 'system')),
  body             text not null default '' check (length(body) <= 4000),
  reply_to_id      uuid,
  pinned           boolean not null default false,
  client_key       uuid,
  created_at       timestamptz not null default clock_timestamp(),
  edited_at        timestamptz,
  deleted_at       timestamptz,
  deleted_by       uuid references auth.users (id) on delete set null,
  unique (company_id, id),
  foreign key (company_id, conversation_id) references public.conversations (company_id, id) on delete cascade,
  foreign key (company_id, reply_to_id) references public.messages (company_id, id),
  constraint messages_text check (kind <> 'text' or deleted_at is not null or length(trim(body)) > 0)
);
create unique index messages_client_key on public.messages (company_id, author_id, client_key) where client_key is not null;
create index messages_conversation_idx on public.messages (company_id, conversation_id, created_at);
create index messages_reply_idx on public.messages (reply_to_id) where reply_to_id is not null;
create index messages_search_idx on public.messages using gin (to_tsvector('simple', body));

-- Previous text of edited or deleted messages (audit; comms.admin only).
create table public.message_revisions (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id),
  message_id  uuid not null,
  action      text not null check (action in ('edited', 'deleted')),
  old_body    text not null,
  actor_id    uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (company_id, message_id) references public.messages (company_id, id) on delete cascade
);

-- Membership, title and lifecycle history (who, when, what, why).
create table public.conversation_events (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id),
  conversation_id  uuid not null,
  kind             text not null check (kind in ('created', 'member_added', 'member_removed', 'member_left', 'title_changed',
                                                 'role_changed', 'settings_changed', 'closed', 'reopened', 'archived',
                                                 'scope_changed', 'sync_failed', 'sync_recovered')),
  user_id          uuid,
  details          jsonb not null default '{}'::jsonb,
  actor_id         uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default clock_timestamp(),
  foreign key (company_id, conversation_id) references public.conversations (company_id, id) on delete cascade
);
create index conversation_events_idx on public.conversation_events (company_id, conversation_id, created_at);

-- -----------------------------------------------------------------------------
-- Presence, preferences, notifications
-- -----------------------------------------------------------------------------
create table public.user_presence (
  company_id     uuid not null references public.companies (id),
  user_id        uuid not null,
  manual_status  text check (manual_status in ('available', 'busy', 'away')),
  last_active_at timestamptz,
  updated_at     timestamptz not null default now(),
  primary key (company_id, user_id),
  foreign key (company_id, user_id) references public.company_memberships (company_id, user_id) on delete cascade
);

create table public.comm_preferences (
  company_id            uuid not null references public.companies (id),
  user_id               uuid not null,
  notify_direct         boolean not null default true,
  notify_group          boolean not null default true,
  notify_channel        boolean not null default true,
  notify_announcement   boolean not null default true,
  notify_alert          boolean not null default true,
  quiet_start           time,
  quiet_end             time,
  timezone              text not null default 'America/Chicago' check (length(timezone) between 1 and 64),
  updated_at            timestamptz not null default now(),
  primary key (company_id, user_id),
  foreign key (company_id, user_id) references public.company_memberships (company_id, user_id) on delete cascade,
  constraint comm_preferences_quiet check ((quiet_start is null) = (quiet_end is null) and (quiet_start is null or quiet_start <> quiet_end))
);

create table public.comm_notifications (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id),
  user_id          uuid not null,
  category         text not null check (category in ('direct', 'group', 'channel', 'announcement', 'alert', 'catch_up', 'membership')),
  title            text not null check (length(title) <= 200),
  link             text not null default '' check (length(link) <= 300),
  conversation_id  uuid,
  source_id        uuid,
  critical         boolean not null default false,
  state            text not null default 'visible' check (state in ('visible', 'deferred', 'superseded')),
  deferred_reason  text check (deferred_reason in ('quiet_hours', 'active_delivery')),
  release_at       timestamptz,
  created_at       timestamptz not null default clock_timestamp(),
  read_at          timestamptz,
  foreign key (company_id, user_id) references public.company_memberships (company_id, user_id) on delete cascade
);
create index comm_notifications_user_idx on public.comm_notifications (company_id, user_id, state, created_at desc);

-- -----------------------------------------------------------------------------
-- Announcements
-- -----------------------------------------------------------------------------
create table public.announcements (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id),
  department    text check (department in ('operations', 'dispatch', 'office', 'shop', 'sales', 'management', 'other')),
  title         text not null check (length(trim(title)) between 3 and 150),
  body          text not null check (length(trim(body)) between 1 and 8000),
  requires_ack  boolean not null default false,
  status        text not null default 'published' check (status in ('published', 'withdrawn')),
  published_by  uuid references auth.users (id) on delete set null,
  published_at  timestamptz not null default clock_timestamp(),
  edited_at     timestamptz,
  edited_by     uuid references auth.users (id) on delete set null,
  client_key    uuid,
  unique (company_id, id)
);
create unique index announcements_client_key on public.announcements (company_id, client_key) where client_key is not null;
create index announcements_company_idx on public.announcements (company_id, published_at desc);

create table public.announcement_revisions (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id),
  announcement_id  uuid not null,
  old_title        text not null,
  old_body         text not null,
  actor_id         uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default clock_timestamp(),
  foreign key (company_id, announcement_id) references public.announcements (company_id, id) on delete cascade
);

create table public.announcement_receipts (
  company_id       uuid not null references public.companies (id),
  announcement_id  uuid not null,
  user_id          uuid not null,
  read_at          timestamptz,
  acknowledged_at  timestamptz,
  primary key (announcement_id, user_id),
  foreign key (company_id, announcement_id) references public.announcements (company_id, id) on delete cascade
);

-- Company guards and audit
create trigger a_company_guard before update of company_id on public.conversations for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.conversation_members for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.messages for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.message_revisions for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.conversation_events for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.user_presence for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.comm_preferences for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.comm_notifications for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.announcements for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.announcement_revisions for each row execute function private.forbid_company_change();
create trigger a_company_guard before update of company_id on public.announcement_receipts for each row execute function private.forbid_company_change();
create trigger announcements_audit after insert or update or delete on public.announcements
  for each row execute function private.audit_row_change('announcement');

-- -----------------------------------------------------------------------------
-- Visibility helpers (used by RLS and functions)
-- -----------------------------------------------------------------------------
/** The caller's current (open) membership in a conversation, or null. */
create or replace function private.comm_active_member(p_conversation uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id from public.conversation_members m
  where m.conversation_id = p_conversation and m.user_id = auth.uid() and m.left_at is null
    and m.company_id = private.current_company_id()
  limit 1
$$;

/** True when the caller may read a message written at p_at (pinned: current members only, any time). */
create or replace function private.comm_message_visible(p_conversation uuid, p_at timestamptz, p_pinned boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_members m
    where m.conversation_id = p_conversation and m.user_id = auth.uid() and m.company_id = private.current_company_id()
      and ((p_pinned and m.left_at is null)
           or (m.history_from <= p_at and (m.left_at is null or p_at <= m.left_at))))
$$;

/** True when the caller has (or had) a membership period in the conversation. */
create or replace function private.comm_ever_member(p_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.conversation_members m
                 where m.conversation_id = p_conversation and m.user_id = auth.uid() and m.company_id = private.current_company_id())
$$;

/** Department of the caller's employee record (null when none). */
create or replace function private.comm_my_department()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select e.department from public.employees e
  where e.company_id = private.current_company_id() and e.user_id = auth.uid() limit 1
$$;

-- -----------------------------------------------------------------------------
-- Row-level security: reads only; every write goes through functions.
-- -----------------------------------------------------------------------------
alter table public.comm_settings enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_revisions enable row level security;
alter table public.conversation_events enable row level security;
alter table public.user_presence enable row level security;
alter table public.comm_preferences enable row level security;
alter table public.comm_notifications enable row level security;
alter table public.announcements enable row level security;
alter table public.announcement_revisions enable row level security;
alter table public.announcement_receipts enable row level security;

create policy comm_settings_read on public.comm_settings for select to authenticated
  using (company_id = (select private.current_company_id()));
create policy conversations_read on public.conversations for select to authenticated
  using (company_id = (select private.current_company_id()) and private.comm_ever_member(id));
create policy conversation_members_read on public.conversation_members for select to authenticated
  using (company_id = (select private.current_company_id()) and private.comm_ever_member(conversation_id));
create policy messages_read on public.messages for select to authenticated
  using (company_id = (select private.current_company_id()) and private.comm_message_visible(conversation_id, created_at, pinned));
create policy message_revisions_read on public.message_revisions for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('comms.admin')));
create policy conversation_events_read on public.conversation_events for select to authenticated
  using (company_id = (select private.current_company_id()) and private.comm_ever_member(conversation_id));
create policy user_presence_read on public.user_presence for select to authenticated
  using (company_id = (select private.current_company_id()));
create policy comm_preferences_read on public.comm_preferences for select to authenticated
  using (company_id = (select private.current_company_id()) and user_id = (select auth.uid()));
create policy comm_notifications_read on public.comm_notifications for select to authenticated
  using (company_id = (select private.current_company_id()) and user_id = (select auth.uid()) and state = 'visible');
create policy announcements_read on public.announcements for select to authenticated
  using (company_id = (select private.current_company_id())
         and (status = 'published' or (select private.has_permission('comms.announce')))
         and (department is null or department = (select private.comm_my_department()) or (select private.has_permission('comms.announce'))));
create policy announcement_revisions_read on public.announcement_revisions for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.has_permission('comms.announce')));
create policy announcement_receipts_read on public.announcement_receipts for select to authenticated
  using (company_id = (select private.current_company_id())
         and (user_id = (select auth.uid()) or (select private.has_permission('comms.announce'))));

revoke all on public.comm_settings, public.conversations, public.conversation_members, public.messages, public.message_revisions,
  public.conversation_events, public.user_presence, public.comm_preferences, public.comm_notifications, public.announcements,
  public.announcement_revisions, public.announcement_receipts from anon, authenticated;
grant select on public.comm_settings, public.conversations, public.conversation_members, public.messages, public.message_revisions,
  public.conversation_events, public.user_presence, public.comm_preferences, public.comm_notifications, public.announcements,
  public.announcement_revisions, public.announcement_receipts to authenticated;
grant all on public.comm_settings, public.conversations, public.conversation_members, public.messages, public.message_revisions,
  public.conversation_events, public.user_presence, public.comm_preferences, public.comm_notifications, public.announcements,
  public.announcement_revisions, public.announcement_receipts to service_role;

-- -----------------------------------------------------------------------------
-- Names, work status and presence
-- -----------------------------------------------------------------------------
create or replace function private.comm_user_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(trim(p.display_name), ''), nullif(trim(p.full_name), ''), 'Unnamed user')
  from public.profiles p where p.id = p_user
$$;

/**
 * Work status for a member right now: 'active_delivery', 'out_of_office' or
 * 'unknown' (no work schedules exist). Never availability or HOS compliance.
 */
create or replace function private.comm_work_status(p_company uuid, p_user uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.drivers d
    join public.dispatch_assignments a on a.company_id = d.company_id and a.driver_id = d.id and a.status = 'active'
    where d.company_id = p_company and d.user_id = p_user and d.active
      and now() >= a.starts_at and now() < a.ends_at
      and not exists (select 1 from public.delivery_tickets t where t.company_id = a.company_id and t.load_id = a.load_id
                      and t.status::text not in ('voided', 'superseded'))) then
    return 'active_delivery';
  end if;
  if exists (
    select 1 from public.time_off_requests t join public.employees e on e.company_id = t.company_id and e.id = t.employee_id
    where t.company_id = p_company and e.user_id = p_user and t.status = 'approved'
      and private.time_off_window(p_company, t) @> now()) then
    return 'out_of_office';
  end if;
  return 'unknown';
end;
$$;

/** Effective presence: manual status, else Away after the inactivity threshold (an estimate), else Available; null when never seen. */
create or replace function private.comm_presence(p_company uuid, p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p.manual_status is not null then p.manual_status
    when p.last_active_at is null then null
    when p.last_active_at < now() - make_interval(mins => (private.comm_settings_of(p_company)).away_after_minutes) then 'away'
    else 'available' end
  from public.user_presence p where p.company_id = p_company and p.user_id = p_user
$$;

/** Coworkers you can message, with presence and work status (no leave category or reason). */
create or replace function public.comm_directory()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('comms.message');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', m.user_id, 'name', private.comm_user_name(m.user_id), 'role', m.role,
      'department', (select e.department from public.employees e where e.company_id = v_company and e.user_id = m.user_id limit 1),
      'presence', private.comm_presence(v_company, m.user_id),
      'work_status', private.comm_work_status(v_company, m.user_id)) order by private.comm_user_name(m.user_id))
    from public.company_memberships m
    where m.company_id = v_company and m.active and m.role is not null
  ), '[]'::jsonb);
end;
$$;

create or replace function public.comm_set_presence(p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if p_status is not null and p_status not in ('available', 'busy', 'away') then raise exception 'Choose available, busy or away.'; end if;
  insert into public.user_presence (company_id, user_id, manual_status, last_active_at, updated_at)
  values (v_company, auth.uid(), p_status, now(), now())
  on conflict (company_id, user_id) do update set manual_status = excluded.manual_status, last_active_at = now(), updated_at = now();
end;
$$;

-- -----------------------------------------------------------------------------
-- Notification routing (in-app only)
-- -----------------------------------------------------------------------------
/** True when local time for the member is inside their quiet hours. */
create or replace function private.comm_in_quiet_hours(p_company uuid, p_user uuid, p_at timestamptz)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.comm_preferences%rowtype;
  v_local timestamp;
  v_t time;
  v_end timestamp;
begin
  select * into v from public.comm_preferences where company_id = p_company and user_id = p_user;
  if not found or v.quiet_start is null then return null; end if;
  v_local := p_at at time zone v.timezone;
  v_t := v_local::time;
  if v.quiet_start < v.quiet_end then
    if v_t >= v.quiet_start and v_t < v.quiet_end then
      v_end := v_local::date + v.quiet_end;
      return v_end at time zone v.timezone;
    end if;
  else
    if v_t >= v.quiet_start then
      v_end := (v_local::date + 1) + v.quiet_end;
      return v_end at time zone v.timezone;
    elsif v_t < v.quiet_end then
      v_end := v_local::date + v.quiet_end;
      return v_end at time zone v.timezone;
    end if;
  end if;
  return null;
end;
$$;

/**
 * Create one in-app notification, honouring preferences, quiet hours and the
 * Active-delivery policy. Critical notifications are never deferred or dropped.
 */
create or replace function private.comm_notify(
  p_company uuid, p_user uuid, p_category text, p_title text, p_link text,
  p_conversation uuid default null, p_source uuid default null, p_critical boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pref   public.comm_preferences%rowtype;
  v_quiet  timestamptz;
  v_state  text := 'visible';
  v_reason text;
begin
  if not p_critical then
    select * into v_pref from public.comm_preferences where company_id = p_company and user_id = p_user;
    if found and ((p_category = 'direct' and not v_pref.notify_direct) or (p_category = 'group' and not v_pref.notify_group)
        or (p_category = 'channel' and not v_pref.notify_channel) or (p_category = 'announcement' and not v_pref.notify_announcement)
        or (p_category = 'alert' and not v_pref.notify_alert)) then
      return;
    end if;
    if p_category in ('direct', 'group', 'channel') and private.comm_work_status(p_company, p_user) = 'active_delivery'
       and (private.comm_settings_of(p_company)).delivery_notifications = 'defer' then
      v_state := 'deferred'; v_reason := 'active_delivery';
    else
      v_quiet := private.comm_in_quiet_hours(p_company, p_user, now());
      if v_quiet is not null then v_state := 'deferred'; v_reason := 'quiet_hours'; end if;
    end if;
  end if;
  insert into public.comm_notifications (company_id, user_id, category, title, link, conversation_id, source_id, critical, state, deferred_reason, release_at)
  values (p_company, p_user, p_category, left(p_title, 200), left(coalesce(p_link, ''), 300), p_conversation, p_source, p_critical,
          v_state, v_reason, v_quiet);
end;
$$;

/**
 * Release the caller's deferred notifications that are due: quiet-hour ones
 * after quiet hours end; Active-delivery ones as ONE catch-up notification once
 * no delivery is active. Idempotent (row locks; deferred rows are superseded once).
 */
create or replace function public.comm_release_deferred()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_n integer := 0;
  v_waiting integer;
begin
  perform 1 from public.user_presence where company_id = v_company and user_id = auth.uid() for update;
  update public.comm_notifications set state = 'visible'
  where company_id = v_company and user_id = auth.uid() and state = 'deferred' and deferred_reason = 'quiet_hours'
    and (release_at is null or release_at <= now());
  get diagnostics v_n = row_count;
  if private.comm_work_status(v_company, auth.uid()) <> 'active_delivery' then
    with s as (
      update public.comm_notifications set state = 'superseded'
      where company_id = v_company and user_id = auth.uid() and state = 'deferred' and deferred_reason = 'active_delivery'
      returning conversation_id)
    select count(*) into v_waiting from s;
    if v_waiting > 0 then
      insert into public.comm_notifications (company_id, user_id, category, title, link)
      values (v_company, auth.uid(), 'catch_up',
              format('You have %s message notification%s waiting from your delivery.', v_waiting, case when v_waiting = 1 then '' else 's' end),
              '/communications');
      v_n := v_n + 1;
    end if;
  end if;
  return v_n;
end;
$$;

create or replace function public.comm_mark_notifications_read(p_ids uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.comm_notifications set read_at = coalesce(read_at, now())
  where company_id = private.require_company() and user_id = auth.uid() and (p_ids is null or id = any (p_ids));
$$;

/** Personal notification preferences and quiet hours. */
create or replace function public.comm_save_preferences(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_tz text := coalesce(nullif(p ->> 'timezone', ''), private.business_timezone(v_company));
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_tz) then raise exception 'Unknown time zone.'; end if;
  insert into public.comm_preferences (company_id, user_id, notify_direct, notify_group, notify_channel, notify_announcement, notify_alert,
                                       quiet_start, quiet_end, timezone, updated_at)
  values (v_company, auth.uid(), coalesce((p ->> 'notify_direct')::boolean, true), coalesce((p ->> 'notify_group')::boolean, true),
          coalesce((p ->> 'notify_channel')::boolean, true), coalesce((p ->> 'notify_announcement')::boolean, true),
          coalesce((p ->> 'notify_alert')::boolean, true), nullif(p ->> 'quiet_start', '')::time, nullif(p ->> 'quiet_end', '')::time, v_tz, now())
  on conflict (company_id, user_id) do update set
    notify_direct = excluded.notify_direct, notify_group = excluded.notify_group, notify_channel = excluded.notify_channel,
    notify_announcement = excluded.notify_announcement, notify_alert = excluded.notify_alert,
    quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, timezone = excluded.timezone, updated_at = now();
end;
$$;

-- -----------------------------------------------------------------------------
-- Conversations: create, members, title, mute, read
-- -----------------------------------------------------------------------------
create or replace function private.comm_event(p_company uuid, p_conversation uuid, p_kind text, p_user uuid, p_details jsonb default '{}'::jsonb)
returns void
language sql
set search_path = ''
as $$
  insert into public.conversation_events (company_id, conversation_id, kind, user_id, details, actor_id)
  values (p_company, p_conversation, p_kind, p_user, coalesce(p_details, '{}'::jsonb), auth.uid());
$$;

create or replace function private.comm_system_message(p_company uuid, p_conversation uuid, p_body text)
returns void
language sql
set search_path = ''
as $$
  insert into public.messages (company_id, conversation_id, author_id, kind, body) values (p_company, p_conversation, null, 'system', left(p_body, 4000));
$$;

create or replace function private.comm_require_coworker(p_company uuid, p_user uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.company_memberships where company_id = p_company and user_id = p_user and active and role is not null) then
    raise exception 'That person is not an active member of your company.' using errcode = 'P0002';
  end if;
end;
$$;

/** Add a membership period (no-op when already a current member). */
create or replace function private.comm_add_member(p_company uuid, p_conversation uuid, p_user uuid, p_source text, p_full_history boolean, p_role text default 'member')
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created timestamptz;
begin
  if exists (select 1 from public.conversation_members where conversation_id = p_conversation and user_id = p_user and left_at is null) then
    return false;
  end if;
  select created_at into v_created from public.conversations where id = p_conversation;
  insert into public.conversation_members (company_id, conversation_id, user_id, role, source, history_from)
  values (p_company, p_conversation, p_user, p_role, p_source, case when p_full_history then v_created else clock_timestamp() end);
  return true;
end;
$$;

/** Open (or reuse) the direct conversation with a coworker. */
create or replace function public.comm_open_direct(p_user uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_key     text;
  v_id      uuid;
begin
  perform private.require_permission('comms.message');
  if p_user = auth.uid() then raise exception 'Choose a coworker.'; end if;
  perform private.comm_require_coworker(v_company, p_user);
  v_key := least(auth.uid()::text, p_user::text) || ':' || greatest(auth.uid()::text, p_user::text);
  select id into v_id from public.conversations where company_id = v_company and direct_key = v_key;
  if v_id is null then
    insert into public.conversations (company_id, kind, direct_key, history_policy, created_by)
    values (v_company, 'direct', v_key, 'full', auth.uid())
    on conflict (company_id, direct_key) where direct_key is not null do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.conversations where company_id = v_company and direct_key = v_key;
    else
      perform private.comm_add_member(v_company, v_id, auth.uid(), 'creator', true);
      perform private.comm_add_member(v_company, v_id, p_user, 'manual', true);
      perform private.comm_event(v_company, v_id, 'created', null);
    end if;
  end if;
  return v_id;
end;
$$;

/** Start a group conversation. Title optional (otherwise generated from names). */
create or replace function public.comm_create_group(p_title text, p_members uuid[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_id      uuid;
  v_u       uuid;
  v_title   text := private.clean_text(p_title, 120, 'Title');
begin
  perform private.require_permission('comms.groups');
  if coalesce(cardinality(p_members), 0) < 1 then raise exception 'Add at least one coworker.'; end if;
  if cardinality(p_members) > 100 then raise exception 'A group can have at most 100 members.'; end if;
  insert into public.conversations (company_id, kind, title, title_custom, history_policy, created_by)
  values (v_company, 'group', v_title, length(v_title) > 0, (private.comm_settings_of(v_company)).history_for_new_members, auth.uid())
  returning id into v_id;
  perform private.comm_add_member(v_company, v_id, auth.uid(), 'creator', true, 'manager');
  foreach v_u in array p_members loop
    if v_u <> auth.uid() then
      perform private.comm_require_coworker(v_company, v_u);
      perform private.comm_add_member(v_company, v_id, v_u, 'manual', true);
      perform private.comm_notify(v_company, v_u, 'membership', 'You were added to a group conversation', '/communications/c/' || v_id, v_id);
    end if;
  end loop;
  perform private.comm_event(v_company, v_id, 'created', null, jsonb_build_object('members', to_jsonb(p_members)));
  return v_id;
end;
$$;

/** Create a department channel (comms.channels), optionally adding the department's members. */
create or replace function public.comm_create_channel(p_title text, p_description text, p_department text, p_add_department boolean, p_members uuid[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_id      uuid;
  v_u       uuid;
  v_title   text := private.clean_text(p_title, 120, 'Title');
begin
  perform private.require_permission('comms.channels');
  if length(v_title) = 0 then raise exception 'Name the channel.'; end if;
  insert into public.conversations (company_id, kind, title, title_custom, description, department, history_policy, members_can_add, created_by)
  values (v_company, 'channel', v_title, true, private.clean_text(p_description, 500, 'Description'), nullif(p_department, ''), 'full', false, auth.uid())
  returning id into v_id;
  perform private.comm_add_member(v_company, v_id, auth.uid(), 'creator', true, 'manager');
  for v_u in
    select distinct u from (
      select unnest(coalesce(p_members, '{}'::uuid[])) as u
      union
      select e.user_id from public.employees e
      join public.company_memberships cm on cm.company_id = e.company_id and cm.user_id = e.user_id and cm.active
      where p_add_department and e.company_id = v_company and e.department = p_department and e.user_id is not null
    ) x where u is not null and u <> auth.uid()
  loop
    perform private.comm_require_coworker(v_company, v_u);
    perform private.comm_add_member(v_company, v_id, v_u, 'manual', true);
  end loop;
  perform private.comm_event(v_company, v_id, 'created', null, jsonb_build_object('department', p_department));
  return v_id;
end;
$$;

/** May the caller manage membership (add+remove) in this conversation? */
create or replace function private.comm_can_manage(p_company uuid, p_conversation uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.conversations%rowtype;
begin
  select * into v from public.conversations where id = p_conversation and company_id = p_company;
  if not found then return false; end if;
  if v.kind = 'channel' then return private.has_permission('comms.channels'); end if;
  if v.kind = 'operation' then return private.has_permission('comms.operations'); end if;
  if v.kind = 'direct' then return false; end if;
  return exists (select 1 from public.conversation_members m where m.conversation_id = p_conversation and m.user_id = auth.uid()
                 and m.left_at is null and m.role = 'manager');
end;
$$;

/** Add coworkers. Members may add to groups when the group allows it; channels/operations need the manage permission. */
create or replace function public.comm_add_members(p_conversation uuid, p_members uuid[], p_share_history boolean default false)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v public.conversations%rowtype;
  v_u uuid;
  v_n integer := 0;
  v_full boolean;
begin
  select * into v from public.conversations where id = p_conversation and company_id = v_company for update;
  if not found then raise exception 'Conversation not found.' using errcode = 'P0002'; end if;
  if v.kind = 'direct' then raise exception 'Start a group to add more people.' using errcode = 'P0001'; end if;
  if v.status <> 'active' then raise exception 'This conversation is %.', v.status using errcode = 'P0001'; end if;
  if not (private.comm_can_manage(v_company, p_conversation)
          or (v.kind = 'group' and v.members_can_add and private.comm_active_member(p_conversation) is not null)) then
    raise exception 'You cannot add people to this conversation.' using errcode = '42501';
  end if;
  -- Sharing full history needs the conversation's policy or a manager's explicit choice.
  v_full := v.history_policy = 'full' or (p_share_history and private.comm_can_manage(v_company, p_conversation));
  foreach v_u in array coalesce(p_members, '{}'::uuid[]) loop
    perform private.comm_require_coworker(v_company, v_u);
    if private.comm_add_member(v_company, p_conversation, v_u, 'manual', v_full) then
      v_n := v_n + 1;
      perform private.comm_event(v_company, p_conversation, 'member_added', v_u, jsonb_build_object('history', case when v_full then 'full' else 'from_join' end));
      perform private.comm_system_message(v_company, p_conversation, private.comm_user_name(auth.uid()) || ' added ' || private.comm_user_name(v_u) || '.');
      perform private.comm_notify(v_company, v_u, 'membership', 'You were added to ' || coalesce(nullif(v.title, ''), 'a conversation'), '/communications/c/' || p_conversation, p_conversation);
    end if;
  end loop;
  return v_n;
end;
$$;

/** Remove a member (managers) or leave (yourself). The period ends now; history up to now stays readable. */
create or replace function public.comm_remove_member(p_conversation uuid, p_user uuid, p_reason text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v public.conversations%rowtype;
  v_self boolean := p_user = auth.uid();
begin
  select * into v from public.conversations where id = p_conversation and company_id = v_company for update;
  if not found then raise exception 'Conversation not found.' using errcode = 'P0002'; end if;
  if v.kind = 'direct' then raise exception 'Direct conversations cannot be left; mute it instead.' using errcode = 'P0001'; end if;
  if not v_self and not private.comm_can_manage(v_company, p_conversation) then
    raise exception 'Only conversation managers can remove members.' using errcode = '42501';
  end if;
  update public.conversation_members set left_at = clock_timestamp(), left_reason = left(coalesce(p_reason, ''), 300)
  where conversation_id = p_conversation and user_id = p_user and left_at is null;
  if not found then raise exception 'That person is not a current member.' using errcode = 'P0002'; end if;
  perform private.comm_event(v_company, p_conversation, case when v_self then 'member_left' else 'member_removed' end, p_user,
                             jsonb_build_object('reason', p_reason));
  perform private.comm_system_message(v_company, p_conversation,
    case when v_self then private.comm_user_name(p_user) || ' left.' else private.comm_user_name(auth.uid()) || ' removed ' || private.comm_user_name(p_user) || '.' end);
  if not v_self then
    perform private.comm_notify(v_company, p_user, 'membership', 'You were removed from ' || coalesce(nullif(v.title, ''), 'a conversation'), '/communications', null);
  end if;
end;
$$;

/** Rename a group (creator/managers) or channel (channel managers). Empty restores the generated name. */
create or replace function public.comm_set_title(p_conversation uuid, p_title text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v public.conversations%rowtype;
  v_title text := private.clean_text(p_title, 120, 'Title');
begin
  select * into v from public.conversations where id = p_conversation and company_id = v_company for update;
  if not found then raise exception 'Conversation not found.' using errcode = 'P0002'; end if;
  if v.kind = 'direct' or not private.comm_can_manage(v_company, p_conversation) then
    raise exception 'You cannot rename this conversation.' using errcode = '42501';
  end if;
  if v.kind = 'channel' and length(v_title) = 0 then raise exception 'A channel needs a name.'; end if;
  update public.conversations set title = v_title, title_custom = length(v_title) > 0 where id = p_conversation;
  perform private.comm_event(v_company, p_conversation, 'title_changed', null, jsonb_build_object('from', v.title, 'to', v_title));
  perform private.comm_system_message(v_company, p_conversation, private.comm_user_name(auth.uid()) ||
    case when length(v_title) > 0 then ' named the conversation "' || v_title || '".' else ' removed the custom name.' end);
end;
$$;

/** Change a member's role (manager / member) in a group or channel. */
create or replace function public.comm_set_member_role(p_conversation uuid, p_user uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if p_role not in ('member', 'manager') then raise exception 'Choose member or manager.'; end if;
  if not private.comm_can_manage(v_company, p_conversation) then raise exception 'You cannot change roles here.' using errcode = '42501'; end if;
  update public.conversation_members set role = p_role where conversation_id = p_conversation and user_id = p_user and left_at is null;
  if not found then raise exception 'That person is not a current member.' using errcode = 'P0002'; end if;
  perform private.comm_event(v_company, p_conversation, 'role_changed', p_user, jsonb_build_object('role', p_role));
end;
$$;

/** Mute: minutes > 0 for a time, null for indefinitely, 0 to unmute. */
create or replace function public.comm_mute(p_conversation uuid, p_minutes integer)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_until timestamptz := case when p_minutes is null then 'infinity'::timestamptz when p_minutes = 0 then null
                              else now() + make_interval(mins => least(p_minutes, 60 * 24 * 30)) end;
begin
  update public.conversation_members set muted_until = v_until
  where conversation_id = p_conversation and user_id = auth.uid() and left_at is null and company_id = private.require_company();
  if not found then raise exception 'You are not a member of this conversation.' using errcode = 'P0002'; end if;
  return v_until;
end;
$$;

/** Mark everything in the conversation as read by the caller. */
create or replace function public.comm_mark_read(p_conversation uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.conversation_members set last_read_at = clock_timestamp(), last_delivered_at = clock_timestamp()
  where conversation_id = p_conversation and user_id = auth.uid() and left_at is null and company_id = private.require_company();
$$;

-- -----------------------------------------------------------------------------
-- Messages: send, edit, delete, pin
-- -----------------------------------------------------------------------------
create or replace function public.comm_send(p_conversation uuid, p_body text, p_reply_to uuid default null, p_client_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v public.conversations%rowtype;
  v_body text := trim(coalesce(p_body, ''));
  v_id uuid;
  v_at timestamptz;
  v_parent public.messages%rowtype;
  r record;
  v_cat text;
  v_title text;
begin
  perform private.require_permission('comms.message');
  if p_client_key is not null then
    select id, created_at into v_id, v_at from public.messages where company_id = v_company and author_id = auth.uid() and client_key = p_client_key;
    if found then return jsonb_build_object('id', v_id, 'created_at', v_at, 'duplicate', true); end if;
  end if;
  select * into v from public.conversations where id = p_conversation and company_id = v_company;
  if not found then raise exception 'Conversation not found.' using errcode = 'P0002'; end if;
  if private.comm_active_member(p_conversation) is null then
    raise exception 'You are not a current member of this conversation.' using errcode = '42501';
  end if;
  if v.status <> 'active' then raise exception 'This conversation is % — reopen it to post.', v.status using errcode = 'P0001'; end if;
  if length(v_body) = 0 then raise exception 'Write a message.' using errcode = 'P0001'; end if;
  if length(v_body) > 4000 then raise exception 'A message can be at most 4000 characters.' using errcode = 'P0001'; end if;
  if p_reply_to is not null then
    select * into v_parent from public.messages where id = p_reply_to and conversation_id = p_conversation;
    if not found or not private.comm_message_visible(p_conversation, v_parent.created_at, v_parent.pinned) then
      raise exception 'The message you reply to was not found.' using errcode = 'P0002';
    end if;
    if v_parent.reply_to_id is not null then p_reply_to := v_parent.reply_to_id; end if; -- one level of threads
  end if;
  insert into public.messages (company_id, conversation_id, author_id, kind, body, reply_to_id, client_key)
  values (v_company, p_conversation, auth.uid(), 'text', v_body, p_reply_to, p_client_key)
  returning id, created_at into v_id, v_at;
  update public.conversations set last_message_at = v_at where id = p_conversation;
  update public.conversation_members set last_read_at = v_at, last_delivered_at = v_at
  where conversation_id = p_conversation and user_id = auth.uid() and left_at is null;

  v_cat := case v.kind when 'direct' then 'direct' when 'channel' then 'channel' else 'group' end;
  v_title := case v.kind when 'direct' then 'New message from ' || private.comm_user_name(auth.uid())
                         else 'New message in ' || coalesce(nullif(v.title, ''), 'a group conversation') end;
  for r in select m.user_id, m.muted_until from public.conversation_members m
           where m.conversation_id = p_conversation and m.left_at is null and m.user_id <> auth.uid() loop
    if r.muted_until is null or r.muted_until <= now() then
      perform private.comm_notify(v_company, r.user_id, v_cat, v_title, '/communications/c/' || p_conversation, p_conversation, v_id);
    end if;
  end loop;
  return jsonb_build_object('id', v_id, 'created_at', v_at, 'duplicate', false);
exception
  when unique_violation then
    select id, created_at into v_id, v_at from public.messages where company_id = v_company and author_id = auth.uid() and client_key = p_client_key;
    if found then return jsonb_build_object('id', v_id, 'created_at', v_at, 'duplicate', true); end if;
    raise;
end;
$$;

create or replace function public.comm_edit_message(p_message uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v public.messages%rowtype;
  v_body text := trim(coalesce(p_body, ''));
  v_window integer := (private.comm_settings_of(v_company)).edit_window_minutes;
begin
  select * into v from public.messages where id = p_message and company_id = v_company for update;
  if not found then raise exception 'Message not found.' using errcode = 'P0002'; end if;
  if v.author_id is distinct from auth.uid() or v.kind <> 'text' then raise exception 'You can only edit your own messages.' using errcode = '42501'; end if;
  if v.deleted_at is not null then raise exception 'A deleted message cannot be edited.' using errcode = 'P0001'; end if;
  if private.comm_active_member(v.conversation_id) is null then raise exception 'You are no longer a member of this conversation.' using errcode = '42501'; end if;
  if clock_timestamp() > v.created_at + make_interval(mins => v_window) then
    raise exception 'Messages can be edited for % minutes after sending.', v_window using errcode = 'P0001';
  end if;
  if length(v_body) = 0 or length(v_body) > 4000 then raise exception 'Write a message (at most 4000 characters).' using errcode = 'P0001'; end if;
  if v_body = v.body then return; end if;
  insert into public.message_revisions (company_id, message_id, action, old_body, actor_id) values (v_company, p_message, 'edited', v.body, auth.uid());
  update public.messages set body = v_body, edited_at = now() where id = p_message;
end;
$$;

create or replace function public.comm_delete_message(p_message uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v public.messages%rowtype;
  s public.comm_settings%rowtype := private.comm_settings_of(v_company);
  v_admin boolean := private.has_permission('comms.admin');
begin
  select * into v from public.messages where id = p_message and company_id = v_company for update;
  if not found then raise exception 'Message not found.' using errcode = 'P0002'; end if;
  if v.deleted_at is not null then return; end if;
  if v.kind <> 'text' then raise exception 'System messages cannot be deleted.' using errcode = '42501'; end if;
  if not v_admin then
    if v.author_id is distinct from auth.uid() or not s.members_delete_own then
      raise exception 'You cannot delete this message.' using errcode = '42501';
    end if;
    if clock_timestamp() > v.created_at + make_interval(mins => s.edit_window_minutes) then
      raise exception 'Messages can be deleted for % minutes after sending.', s.edit_window_minutes using errcode = 'P0001';
    end if;
  elsif not private.comm_message_visible(v.conversation_id, v.created_at, v.pinned) and v.author_id is distinct from auth.uid() then
    perform private.log_event('comm_admin_delete', 'message', p_message, 'Administrator deleted a message they could not otherwise see', '{}'::jsonb);
  end if;
  insert into public.message_revisions (company_id, message_id, action, old_body, actor_id) values (v_company, p_message, 'deleted', v.body, auth.uid());
  update public.messages set body = '', deleted_at = now(), deleted_by = auth.uid(), pinned = false where id = p_message;
end;
$$;

/** Pin a message as current context (visible to current members, including people who join later). */
create or replace function public.comm_pin_message(p_message uuid, p_pinned boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v public.messages%rowtype;
begin
  select * into v from public.messages where id = p_message and company_id = v_company for update;
  if not found or not private.comm_message_visible(v.conversation_id, v.created_at, v.pinned) then raise exception 'Message not found.' using errcode = 'P0002'; end if;
  if not private.comm_can_manage(v_company, v.conversation_id) then raise exception 'Only conversation managers can pin messages.' using errcode = '42501'; end if;
  if v.deleted_at is not null then raise exception 'A deleted message cannot be pinned.' using errcode = 'P0001'; end if;
  update public.messages set pinned = p_pinned where id = p_message;
end;
$$;

-- -----------------------------------------------------------------------------
-- Inbox, thread view, receipts
-- -----------------------------------------------------------------------------
/** The caller's conversations with unread counts, mute state and last activity (no message text). */
create or replace function public.comm_inbox()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  -- Receiving the list counts as delivery.
  update public.conversation_members set last_delivered_at = clock_timestamp()
  where company_id = v_company and user_id = auth.uid() and left_at is null;
  insert into public.user_presence (company_id, user_id, last_active_at) values (v_company, auth.uid(), now())
  on conflict (company_id, user_id) do update set last_active_at = now();
  return coalesce((
    select jsonb_agg(row_to_json(x)::jsonb order by x.last_activity desc nulls last)
    from (
      select c.id, c.kind, c.status, c.department,
             case when c.kind = 'direct' then (select private.comm_user_name(o.user_id) from public.conversation_members o
                                               where o.conversation_id = c.id and o.user_id <> auth.uid() order by o.joined_at limit 1)
                  when c.title_custom or c.kind = 'channel' or c.kind = 'operation' then c.title
                  else (select string_agg(private.comm_user_name(o.user_id), ', ' order by private.comm_user_name(o.user_id))
                        from (select distinct o2.user_id from public.conversation_members o2
                              where o2.conversation_id = c.id and o2.left_at is null and o2.user_id <> auth.uid()) o) end as title,
             (select o.user_id from public.conversation_members o where c.kind = 'direct' and o.conversation_id = c.id and o.user_id <> auth.uid() limit 1) as other_user_id,
             m.left_at is null as active_member,
             m.muted_until,
             greatest(c.last_message_at, c.created_at) as last_activity,
             (select count(*) from public.messages msg
              where msg.conversation_id = c.id and msg.author_id is distinct from auth.uid() and msg.deleted_at is null
                and msg.created_at > coalesce(m.last_read_at, '-infinity'::timestamptz)
                and private.comm_message_visible(c.id, msg.created_at, msg.pinned)) as unread
      from public.conversations c
      join lateral (select * from public.conversation_members mm where mm.conversation_id = c.id and mm.user_id = auth.uid()
                    order by mm.left_at is null desc, mm.joined_at desc limit 1) m on true
      where c.company_id = v_company
    ) x
  ), '[]'::jsonb);
end;
$$;

/** Delivery/read state of the caller's own messages: per message, members who received and read it. */
create or replace function public.comm_receipts(p_conversation uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  if not private.comm_ever_member(p_conversation) then raise exception 'Conversation not found.' using errcode = 'P0002'; end if;
  return coalesce((
    select jsonb_object_agg(msg.id, jsonb_build_object(
      'recipients', (select count(*) from public.conversation_members m where m.conversation_id = p_conversation and m.user_id <> auth.uid()
                     and m.history_from <= msg.created_at and (m.left_at is null or m.left_at >= msg.created_at)),
      'delivered', (select count(*) from public.conversation_members m where m.conversation_id = p_conversation and m.user_id <> auth.uid()
                    and m.history_from <= msg.created_at and (m.left_at is null or m.left_at >= msg.created_at) and m.last_delivered_at >= msg.created_at),
      'read', (select count(*) from public.conversation_members m where m.conversation_id = p_conversation and m.user_id <> auth.uid()
               and m.history_from <= msg.created_at and (m.left_at is null or m.left_at >= msg.created_at) and m.last_read_at >= msg.created_at)))
    from public.messages msg
    where msg.conversation_id = p_conversation and msg.company_id = v_company and msg.author_id = auth.uid()
      and msg.created_at > now() - interval '30 days'
  ), '{}'::jsonb);
end;
$$;

/** Search what the caller may read: messages, channels, announcements. */
create or replace function public.comm_search(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_q text := trim(coalesce(p_query, ''));
begin
  if length(v_q) < 2 then raise exception 'Search for at least 2 characters.'; end if;
  return jsonb_build_object(
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', msg.id, 'conversation_id', msg.conversation_id, 'body', left(msg.body, 300),
                                                              'author', private.comm_user_name(msg.author_id), 'created_at', msg.created_at) order by msg.created_at desc)
                          from (select * from public.messages msg
                                where msg.company_id = v_company and msg.deleted_at is null and msg.kind = 'text'
                                  and msg.body ilike '%' || replace(replace(v_q, '%', '\%'), '_', '\_') || '%'
                                  and private.comm_message_visible(msg.conversation_id, msg.created_at, msg.pinned)
                                order by msg.created_at desc limit 50) msg), '[]'::jsonb),
    'announcements', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'published_at', a.published_at) order by a.published_at desc)
                               from public.announcements a
                               where a.company_id = v_company and a.status = 'published'
                                 and (a.department is null or a.department = private.comm_my_department() or private.has_permission('comms.announce'))
                                 and (a.title ilike '%' || v_q || '%' or a.body ilike '%' || v_q || '%')), '[]'::jsonb));
end;
$$;

/** Administrative search across all conversations of the company (comms.admin). Every search is audited. */
create or replace function public.comm_admin_search(p_query text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_q text := trim(coalesce(p_query, ''));
begin
  perform private.require_permission('comms.admin');
  if length(v_q) < 2 then raise exception 'Search for at least 2 characters.'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Give the reason for this administrative search.' using errcode = 'P0001'; end if;
  perform private.log_event('comm_admin_search', 'company', v_company, 'Administrative communications search',
                            jsonb_build_object('query', v_q, 'reason', p_reason));
  return coalesce((select jsonb_agg(jsonb_build_object('id', msg.id, 'conversation_id', msg.conversation_id, 'body', left(msg.body, 300),
                                                       'author', private.comm_user_name(msg.author_id), 'created_at', msg.created_at) order by msg.created_at desc)
                   from (select * from public.messages msg
                         where msg.company_id = v_company and msg.deleted_at is null and msg.kind = 'text'
                           and msg.body ilike '%' || replace(replace(v_q, '%', '\%'), '_', '\_') || '%'
                         order by msg.created_at desc limit 100) msg), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- Announcements
-- -----------------------------------------------------------------------------
create or replace function public.comm_publish_announcement(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_id uuid;
  v_key uuid := nullif(p ->> 'client_key', '')::uuid;
  v_dept text := nullif(p ->> 'department', '');
  r record;
begin
  perform private.require_permission('comms.announce');
  if v_key is not null then
    select id into v_id from public.announcements where company_id = v_company and client_key = v_key;
    if found then return v_id; end if;
  end if;
  insert into public.announcements (company_id, department, title, body, requires_ack, published_by, client_key)
  values (v_company, v_dept, private.clean_text(p ->> 'title', 150, 'Title'), private.clean_text(p ->> 'body', 8000, 'Text'),
          coalesce((p ->> 'requires_ack')::boolean, false), auth.uid(), v_key)
  returning id into v_id;
  for r in select m.user_id from public.company_memberships m
           where m.company_id = v_company and m.active and m.role is not null and m.user_id <> auth.uid()
             and (v_dept is null or exists (select 1 from public.employees e where e.company_id = v_company and e.user_id = m.user_id and e.department = v_dept)) loop
    perform private.comm_notify(v_company, r.user_id, 'announcement', 'Announcement: ' || (p ->> 'title'), '/communications/announcements/' || v_id, null, v_id);
  end loop;
  return v_id;
end;
$$;

create or replace function public.comm_edit_announcement(p_id uuid, p_title text, p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v public.announcements%rowtype;
begin
  perform private.require_permission('comms.announce');
  select * into v from public.announcements where id = p_id and company_id = v_company for update;
  if not found then raise exception 'Announcement not found.' using errcode = 'P0002'; end if;
  insert into public.announcement_revisions (company_id, announcement_id, old_title, old_body, actor_id) values (v_company, p_id, v.title, v.body, auth.uid());
  update public.announcements set title = private.clean_text(p_title, 150, 'Title'), body = private.clean_text(p_body, 8000, 'Text'),
    edited_at = now(), edited_by = auth.uid() where id = p_id;
end;
$$;

create or replace function public.comm_withdraw_announcement(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_permission('comms.announce');
  update public.announcements set status = 'withdrawn', edited_at = now(), edited_by = auth.uid()
  where id = p_id and company_id = private.require_company();
  if not found then raise exception 'Announcement not found.' using errcode = 'P0002'; end if;
end;
$$;

/** Record that the caller read (and, when asked, acknowledged) an announcement they may see. */
create or replace function public.comm_announcement_receipt(p_id uuid, p_acknowledge boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v public.announcements%rowtype;
begin
  select * into v from public.announcements where id = p_id and company_id = v_company and status = 'published';
  if not found or not (v.department is null or v.department = private.comm_my_department() or private.has_permission('comms.announce')) then
    raise exception 'Announcement not found.' using errcode = 'P0002';
  end if;
  if p_acknowledge and not v.requires_ack then raise exception 'This announcement does not ask for acknowledgment.'; end if;
  insert into public.announcement_receipts (company_id, announcement_id, user_id, read_at, acknowledged_at)
  values (v_company, p_id, auth.uid(), now(), case when p_acknowledge then now() end)
  on conflict (announcement_id, user_id) do update set read_at = coalesce(public.announcement_receipts.read_at, now()),
    acknowledged_at = coalesce(public.announcement_receipts.acknowledged_at, excluded.acknowledged_at);
end;
$$;

-- -----------------------------------------------------------------------------
-- Company settings (comms.admin) and retention
-- -----------------------------------------------------------------------------
create or replace function public.comm_save_settings(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  s public.comm_settings%rowtype := private.comm_settings_of(v_company);
begin
  perform private.require_permission('comms.admin');
  insert into public.comm_settings (company_id, edit_window_minutes, members_delete_own, history_for_new_members, retention_days, legal_hold,
                                    away_after_minutes, delivery_notifications, workspace_archive_hours, updated_by, updated_at)
  values (v_company,
          coalesce((p ->> 'edit_window_minutes')::integer, s.edit_window_minutes),
          coalesce((p ->> 'members_delete_own')::boolean, s.members_delete_own),
          coalesce(nullif(p ->> 'history_for_new_members', ''), s.history_for_new_members),
          case when p ? 'retention_days' then nullif(p ->> 'retention_days', '')::integer else s.retention_days end,
          coalesce((p ->> 'legal_hold')::boolean, s.legal_hold),
          coalesce((p ->> 'away_after_minutes')::integer, s.away_after_minutes),
          coalesce(nullif(p ->> 'delivery_notifications', ''), s.delivery_notifications),
          coalesce((p ->> 'workspace_archive_hours')::integer, s.workspace_archive_hours),
          auth.uid(), now())
  on conflict (company_id) do update set
    edit_window_minutes = excluded.edit_window_minutes, members_delete_own = excluded.members_delete_own,
    history_for_new_members = excluded.history_for_new_members, retention_days = excluded.retention_days, legal_hold = excluded.legal_hold,
    away_after_minutes = excluded.away_after_minutes, delivery_notifications = excluded.delivery_notifications,
    workspace_archive_hours = excluded.workspace_archive_hours, updated_by = auth.uid(), updated_at = now();
end;
$$;

/** Apply message retention (never under legal hold). Messages and their revisions older than the period are removed. */
create or replace function private.comm_apply_retention(p_company uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.comm_settings%rowtype := private.comm_settings_of(p_company);
  v_n integer := 0;
begin
  if s.retention_days is null or s.legal_hold then return 0; end if;
  delete from public.messages m
  where m.company_id = p_company and m.created_at < now() - make_interval(days => s.retention_days)
    and not exists (select 1 from public.messages r where r.reply_to_id = m.id and r.created_at >= now() - make_interval(days => s.retention_days));
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform private.log_event('comm_retention', 'company', p_company, format('Retention removed %s messages', v_n), jsonb_build_object('days', s.retention_days));
  end if;
  return v_n;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.comm_directory()', 'public.comm_set_presence(text)', 'public.comm_release_deferred()', 'public.comm_mark_notifications_read(uuid[])',
    'public.comm_save_preferences(jsonb)', 'public.comm_open_direct(uuid)', 'public.comm_create_group(text, uuid[])',
    'public.comm_create_channel(text, text, text, boolean, uuid[])', 'public.comm_add_members(uuid, uuid[], boolean)',
    'public.comm_remove_member(uuid, uuid, text)', 'public.comm_set_title(uuid, text)', 'public.comm_set_member_role(uuid, uuid, text)',
    'public.comm_mute(uuid, integer)', 'public.comm_mark_read(uuid)', 'public.comm_send(uuid, text, uuid, uuid)',
    'public.comm_edit_message(uuid, text)', 'public.comm_delete_message(uuid)', 'public.comm_pin_message(uuid, boolean)',
    'public.comm_inbox()', 'public.comm_receipts(uuid)', 'public.comm_search(text)', 'public.comm_admin_search(text, text)',
    'public.comm_publish_announcement(jsonb)', 'public.comm_edit_announcement(uuid, text, text)', 'public.comm_withdraw_announcement(uuid)',
    'public.comm_announcement_receipt(uuid, boolean)', 'public.comm_save_settings(jsonb)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array[
    'private.comm_settings_of(uuid)', 'private.comm_user_name(uuid)', 'private.comm_work_status(uuid, uuid)', 'private.comm_presence(uuid, uuid)',
    'private.comm_in_quiet_hours(uuid, uuid, timestamptz)', 'private.comm_notify(uuid, uuid, text, text, text, uuid, uuid, boolean)',
    'private.comm_require_coworker(uuid, uuid)', 'private.comm_add_member(uuid, uuid, uuid, text, boolean, text)',
    'private.comm_apply_retention(uuid)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end;
$$;
