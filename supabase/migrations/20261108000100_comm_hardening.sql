-- =============================================================================
-- Communications hardening (follow-up to 20261105000100–0400, already applied on
-- the hosted database and therefore not edited).
--
-- 1. Edit and own-delete window: fixed at 5 minutes from creation, on the server.
--    Repeated edits never restart it (it counts from created_at). The old
--    comm_settings.edit_window_minutes is no longer read.
-- 2. Manager removal: after the window (or of someone else's message) only
--    comms.admin may remove a message, with a required reason. A tombstone stays
--    (messages.removal_kind = 'manager'); the old text is kept in the admin-only
--    message_revisions with the reason, and the removal is written to the audit log
--    (without the text).
-- 3. Message content retention: 14 days from creation, for every conversation kind
--    (direct, group, channel, operation), replies, revisions and attachments.
--    Edits and replies never extend it. Enforced:
--      - at read time: comm_message_visible (used by RLS, search, unread counts,
--        replies, pins and attachment access) hides content older than 14 days;
--      - by the purge: private.comm_apply_retention empties expired bodies, deletes
--        their revisions and marks their attachments expired (storage objects are
--        removed through the Storage API by /api/cron/comm-housekeeping, because
--        Supabase forbids deleting storage rows in SQL).
--    A company legal hold overrides both. Audit records (audit_events) follow their
--    own policy and never contain message text. comm_settings.retention_days is no
--    longer read for messages.
-- 4. Scheduled job: public.comm_housekeeping_all() (service role only) runs
--    escalation, document alerts, workspace archiving and retention for every
--    company. Called by the Vercel cron route; scheduled with pg_cron as well when
--    that extension is installed. The per-company comm_housekeeping() still runs
--    while people use Communications.
-- 5. Workspaces are archived only when, beyond the existing checks, no open
--    action-required or critical alert and no delivery ticket awaiting review
--    remains on their loads or trucks.
-- 6. Driver replacement handoff: the replacing driver inherits the replaced
--    driver's history window and gets a handoff message (pinned instructions, open
--    alerts and tickets awaiting review). The replaced driver keeps their history
--    up to the handoff and receives nothing new.
-- 7. comm_seed_demo_samples(): fictional sample channel content for demo companies
--    only (refused for real companies); platform_prospect_demo_add_owner also adds the
--    new owner to that sample channel. In demo companies, Communications shows people by
--    their employee record's name (the presenter's persona), never the login's own name.
--
-- Rollback: supabase/rollbacks/20261108000100_comm_hardening.down.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Columns and constraints
-- -----------------------------------------------------------------------------
alter table public.messages
  add column expired_at   timestamptz,
  add column removal_kind text check (removal_kind in ('author', 'manager'));
alter table public.messages drop constraint messages_text;
alter table public.messages add constraint messages_text
  check (kind <> 'text' or deleted_at is not null or expired_at is not null or length(trim(body)) > 0);
create index messages_retention_idx on public.messages (company_id, created_at) where expired_at is null;

alter table public.message_revisions add column reason text not null default '' check (length(reason) <= 300);

alter table public.message_attachments
  add column expired_at      timestamptz,
  add column file_removed_at timestamptz;
alter table public.message_attachments drop constraint message_attachments_status_check;
alter table public.message_attachments add constraint message_attachments_status_check
  check (status in ('pending', 'uploaded', 'attached', 'discarded', 'expired'));
alter table public.message_attachments drop constraint message_attachments_state;
alter table public.message_attachments add constraint message_attachments_state check (
  (status = 'pending' and uploaded_at is null and message_id is null)
  or (status = 'uploaded' and uploaded_at is not null and message_id is null)
  or (status = 'attached' and uploaded_at is not null and message_id is not null and attached_at is not null)
  or (status = 'discarded' and message_id is null)
  or (status = 'expired' and expired_at is not null));
create index message_attachments_expired_idx on public.message_attachments (expired_at) where status = 'expired' and file_removed_at is null;

-- -----------------------------------------------------------------------------
-- Policy constants and the read-time retention rule
-- -----------------------------------------------------------------------------
/** Authors may edit or delete their own message for this long after sending. */
create or replace function private.comm_edit_window()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '5 minutes' $$;

/** Message content (bodies, revisions, attachments) is kept this long from creation, unless under legal hold. */
create or replace function private.comm_retention()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '14 days' $$;

/** True when the company's communications are under legal hold (nothing expires). */
create or replace function private.comm_legal_hold(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.legal_hold from public.comm_settings s where s.company_id = p_company), false)
$$;

/**
 * True when the caller may read a message written at p_at (pinned: current members
 * only, any time) and its content is still within retention (or under legal hold).
 */
create or replace function private.comm_message_visible(p_conversation uuid, p_at timestamptz, p_pinned boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (p_at > now() - private.comm_retention() or private.comm_legal_hold(private.current_company_id()))
    and exists (
      select 1 from public.conversation_members m
      where m.conversation_id = p_conversation and m.user_id = auth.uid() and m.company_id = private.current_company_id()
        and ((p_pinned and m.left_at is null)
             or (m.history_from <= p_at and (m.left_at is null or p_at <= m.left_at))))
$$;

-- -----------------------------------------------------------------------------
-- Edit, delete, remove
-- -----------------------------------------------------------------------------
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
begin
  select * into v from public.messages where id = p_message and company_id = v_company for update;
  if not found or not private.comm_message_visible(v.conversation_id, v.created_at, v.pinned) then
    raise exception 'Message not found.' using errcode = 'P0002';
  end if;
  if v.author_id is distinct from auth.uid() or v.kind <> 'text' then raise exception 'You can only edit your own messages.' using errcode = '42501'; end if;
  if v.deleted_at is not null or v.expired_at is not null then raise exception 'A deleted message cannot be edited.' using errcode = 'P0001'; end if;
  if private.comm_active_member(v.conversation_id) is null then raise exception 'You are no longer a member of this conversation.' using errcode = '42501'; end if;
  -- Counted from creation: earlier edits never restart the window.
  if clock_timestamp() > v.created_at + private.comm_edit_window() then
    raise exception 'Messages can be edited for 5 minutes after sending.' using errcode = 'P0001';
  end if;
  if length(v_body) = 0 or length(v_body) > 4000 then raise exception 'Write a message (at most 4000 characters).' using errcode = 'P0001'; end if;
  if v_body = v.body then return; end if;
  insert into public.message_revisions (company_id, message_id, action, old_body, actor_id) values (v_company, p_message, 'edited', v.body, auth.uid());
  update public.messages set body = v_body, edited_at = now() where id = p_message;
end;
$$;

drop function if exists public.comm_delete_message(uuid);

/**
 * Delete a message. Authors: their own, within 5 minutes of sending (when the
 * company allows members to delete). Managers (comms.admin): any message at any
 * time, with a reason; audited. Either way a tombstone stays and the old text is
 * kept for administrators until retention removes it (never under legal hold).
 */
create or replace function public.comm_delete_message(p_message uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v public.messages%rowtype;
  s public.comm_settings%rowtype := private.comm_settings_of(v_company);
  v_own boolean;
  v_reason text := left(trim(coalesce(p_reason, '')), 300);
begin
  select * into v from public.messages where id = p_message and company_id = v_company for update;
  if not found then raise exception 'Message not found.' using errcode = 'P0002'; end if;
  if v.deleted_at is not null then return; end if;
  if v.expired_at is not null then raise exception 'This message has already expired.' using errcode = 'P0001'; end if;
  if v.kind <> 'text' then raise exception 'System messages cannot be deleted.' using errcode = '42501'; end if;
  v_own := v.author_id = auth.uid() and s.members_delete_own and clock_timestamp() <= v.created_at + private.comm_edit_window()
           and private.comm_message_visible(v.conversation_id, v.created_at, v.pinned);
  if v_own then
    insert into public.message_revisions (company_id, message_id, action, old_body, actor_id) values (v_company, p_message, 'deleted', v.body, auth.uid());
    update public.messages set body = '', deleted_at = now(), deleted_by = auth.uid(), pinned = false, removal_kind = 'author' where id = p_message;
    return;
  end if;
  if not private.has_permission('comms.admin') then
    if v.author_id = auth.uid() then
      raise exception 'Messages can be deleted for 5 minutes after sending.' using errcode = 'P0001';
    end if;
    raise exception 'You cannot delete this message.' using errcode = '42501';
  end if;
  if length(v_reason) < 5 then raise exception 'Give the reason for removing this message.' using errcode = 'P0001'; end if;
  insert into public.message_revisions (company_id, message_id, action, old_body, actor_id, reason) values (v_company, p_message, 'deleted', v.body, auth.uid(), v_reason);
  update public.messages set body = '', deleted_at = now(), deleted_by = auth.uid(), pinned = false, removal_kind = 'manager' where id = p_message;
  perform private.log_event('comm_message_removed', 'message', p_message, 'A manager removed a message',
    jsonb_build_object('conversation_id', v.conversation_id, 'author_id', v.author_id, 'reason', v_reason,
                       'visible_to_remover', private.comm_message_visible(v.conversation_id, v.created_at, v.pinned)));
end;
$$;

-- -----------------------------------------------------------------------------
-- Search (expired content is excluded by comm_message_visible and here)
-- -----------------------------------------------------------------------------
create or replace function public.comm_admin_search(p_query text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_q text := trim(coalesce(p_query, ''));
  v_hold boolean := private.comm_legal_hold(v_company);
begin
  perform private.require_permission('comms.admin');
  if length(v_q) < 2 then raise exception 'Search for at least 2 characters.'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Give the reason for this administrative search.' using errcode = 'P0001'; end if;
  perform private.log_event('comm_admin_search', 'company', v_company, 'Administrative communications search',
                            jsonb_build_object('query', v_q, 'reason', p_reason));
  return coalesce((select jsonb_agg(jsonb_build_object('id', msg.id, 'conversation_id', msg.conversation_id, 'body', left(msg.body, 300),
                                                       'author', private.comm_user_name(msg.author_id), 'created_at', msg.created_at) order by msg.created_at desc)
                   from (select * from public.messages msg
                         where msg.company_id = v_company and msg.deleted_at is null and msg.expired_at is null and msg.kind = 'text'
                           and (v_hold or msg.created_at > now() - private.comm_retention())
                           and msg.body ilike '%' || replace(replace(v_q, '%', '\%'), '_', '\_') || '%'
                         order by msg.created_at desc limit 100) msg), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- Retention purge
-- -----------------------------------------------------------------------------
/**
 * Expire message content older than the retention period (never under legal hold):
 * bodies are emptied, their revisions deleted and their attachments marked expired
 * (no longer readable; the stored file is removed by the scheduled job). The rows
 * stay so threads and receipts remain consistent. Returns the number of messages.
 */
create or replace function private.comm_apply_retention(p_company uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cut timestamptz := clock_timestamp() - private.comm_retention();
  v_n integer := 0;
  v_files integer := 0;
begin
  if private.comm_legal_hold(p_company) then return 0; end if;
  update public.message_attachments a set status = 'expired', expired_at = clock_timestamp()
  where a.company_id = p_company and a.status <> 'expired'
    and ((a.message_id is not null and exists (select 1 from public.messages m where m.id = a.message_id and m.created_at < v_cut))
         or (a.message_id is null and a.created_at < v_cut));
  get diagnostics v_files = row_count;
  delete from public.message_revisions r using public.messages m
  where r.message_id = m.id and m.company_id = p_company and m.created_at < v_cut;
  update public.messages set body = '', pinned = false, expired_at = clock_timestamp()
  where company_id = p_company and expired_at is null and created_at < v_cut;
  get diagnostics v_n = row_count;
  if v_n > 0 or v_files > 0 then
    insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
    values (p_company, null, 'comm_retention', 'company', p_company,
            format('Retention expired %s messages and %s files', v_n, v_files),
            jsonb_build_object('retention', private.comm_retention()::text, 'messages', v_n, 'files', v_files));
  end if;
  return v_n;
end;
$$;

/** Service role: stored files of expired attachments still to be removed through the Storage API. */
create or replace function public.comm_expired_attachment_files(p_limit integer default 500)
returns table (attachment_id uuid, object_path text)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.object_path from public.message_attachments a
  where a.status = 'expired' and a.file_removed_at is null
  order by a.expired_at
  limit least(greatest(coalesce(p_limit, 500), 1), 1000)
$$;

/** Service role: record that the stored files were removed. */
create or replace function public.comm_mark_attachment_files_removed(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.message_attachments set file_removed_at = clock_timestamp()
  where id = any (coalesce(p_ids, '{}')) and status = 'expired' and file_removed_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- Archive veto: no outstanding actions
-- -----------------------------------------------------------------------------
/**
 * A finished workspace is archived only when no open critical or action-required
 * alert and no delivery ticket awaiting review remains on its loads or trucks.
 */
create or replace function private.comm_operation_can_archive(p_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with w as (select * from public.operation_workspaces where conversation_id = p_conversation),
  loads as (
    select unnest(w.load_ids) as id from w
    union select l.id from public.order_loads l, w where l.order_id = any (w.order_ids)),
  trucks as (select da.truck_id as id from public.dispatch_assignments da where da.load_id in (select id from loads))
  select not exists (
      select 1 from public.alerts a, w
      where a.company_id = w.company_id and a.status = 'open' and a.priority in ('critical', 'action_required')
        and (a.entity_id in (select id from loads) or a.entity_id in (select id from trucks)))
    and not exists (
      select 1 from public.delivery_tickets t, w
      where t.company_id = w.company_id and t.load_id in (select id from loads) and t.status::text in ('submitted', 'needs_review'))
$$;

-- -----------------------------------------------------------------------------
-- Dispatch sync with driver-replacement handoff
-- -----------------------------------------------------------------------------
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
  v_old_from timestamptz;
  v_pins integer;
  v_alerts text;
  v_tickets integer;
begin
  if current_setting('tlt.comm_sync_fail', true) = 'on' then
    raise exception 'Simulated synchronization failure';
  end if;
  select * into v_c from public.conversations where id = p_conversation for update;
  select * into v_w from public.operation_workspaces where conversation_id = p_conversation for update;
  if v_c.status <> 'active' then return jsonb_build_object('skipped', v_c.status); end if;

  -- Remove dispatch members who are no longer assigned (period ends now: no new content reaches them).
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
      select m.user_id, m.history_from into v_old, v_old_from from public.conversation_members m
      join public.drivers d on d.company_id = m.company_id and d.user_id = m.user_id
      join public.dispatch_assignments a on a.company_id = d.company_id and a.driver_id = d.id and a.load_id = r.load_id and a.status = 'canceled'
      where m.conversation_id = p_conversation and m.source = 'dispatch' and m.left_at >= now() and m.user_id <> r.user_id
      order by m.left_at desc
      limit 1;
      v_added := v_added || jsonb_build_object('user_id', r.user_id, 'load', r.label, 'replaces', v_old);
      perform private.comm_event(v_c.company_id, p_conversation, 'member_added', r.user_id,
        jsonb_build_object('reason', 'dispatch', 'trigger', p_trigger, 'load', r.label, 'replaces', v_old));
      if v_old is not null then
        -- Handoff: the replacement sees what the replaced driver saw (within retention), plus a summary of what is open.
        update public.conversation_members set history_from = least(history_from, v_old_from)
        where conversation_id = p_conversation and user_id = r.user_id and left_at is null;
        select count(*) into v_pins from public.messages
        where conversation_id = p_conversation and pinned and deleted_at is null and expired_at is null;
        select string_agg(a.title, '; ' order by a.created_at) into v_alerts
        from public.alerts a
        where a.company_id = v_c.company_id and a.status = 'open' and a.priority in ('critical', 'action_required')
          and (a.entity_id = r.load_id
               or a.entity_id in (select da.truck_id from public.dispatch_assignments da where da.load_id = r.load_id and da.status = 'active'));
        select count(*) into v_tickets from public.delivery_tickets t
        where t.company_id = v_c.company_id and t.load_id = r.load_id and t.status::text in ('submitted', 'needs_review');
        perform private.comm_system_message(v_c.company_id, p_conversation,
          'Handoff on ' || r.label || ': ' || private.comm_user_name(r.user_id) || ' replaces ' || private.comm_user_name(v_old) || '. '
          || v_pins || ' pinned instruction' || case when v_pins = 1 then '' else 's' end || ' apply. '
          || case when v_alerts is null then 'No open alerts on this load. ' else 'Open alerts: ' || left(v_alerts, 600) || '. ' end
          || case when v_tickets > 0 then v_tickets || ' delivery ticket(s) await review. ' else '' end
          || 'The conversation so far is visible to ' || private.comm_user_name(r.user_id) || '; '
          || private.comm_user_name(v_old) || ' keeps their history but receives nothing new.');
        perform private.comm_notify(v_c.company_id, r.user_id, 'membership', 'Handoff: you now have ' || r.label || ' in ' || v_c.title,
          '/communications/c/' || p_conversation, p_conversation);
      else
        perform private.comm_system_message(v_c.company_id, p_conversation,
          private.comm_user_name(r.user_id) || ' joined (' || r.label || '). Pinned instructions are visible to them; earlier messages are not.');
        perform private.comm_notify(v_c.company_id, r.user_id, 'membership', 'You were added to ' || v_c.title || ' (assigned load)',
          '/communications/c/' || p_conversation, p_conversation);
      end if;
      v_old := null; v_old_from := null;
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

-- -----------------------------------------------------------------------------
-- Scheduled housekeeping for every company
-- -----------------------------------------------------------------------------
/**
 * Service role / scheduler only: escalation, document alerts, workspace archiving
 * and retention for every active company. One company's failure never stops the
 * others; it is returned in 'failed'.
 */
create or replace function public.comm_housekeeping_all()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_done integer := 0;
  v_expired integer := 0;
  v_failed jsonb := '[]'::jsonb;
begin
  for r in select c.id from public.companies c where c.active loop
    begin
      perform private.comm_escalate_due(r.id);
      perform private.comm_document_alerts(r.id);
      perform private.comm_archive_finished(r.id);
      v_expired := v_expired + private.comm_apply_retention(r.id);
      insert into public.comm_housekeeping_runs (company_id, ran_at) values (r.id, now())
      on conflict (company_id) do update set ran_at = now();
      v_done := v_done + 1;
    exception when others then
      v_failed := v_failed || jsonb_build_object('company_id', r.id, 'error', left(sqlerrm, 200));
    end;
  end loop;
  return jsonb_build_object('companies', v_done, 'expired_messages', v_expired, 'failed', v_failed);
end;
$$;

-- pg_cron (when installed): every 15 minutes. Installing the extension is an owner action.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.schedule('comm-housekeeping', '*/15 * * * *', 'select public.comm_housekeeping_all()')$q$;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Demo sample content (demo companies only)
-- -----------------------------------------------------------------------------
/**
 * Fictional sample Communications content for a demo company: a Dispatch channel
 * with the demo's members (never platform operators) and pinned sample
 * instructions. Idempotent; re-adds samples once retention has expired them.
 * Refused for real companies. Sends nothing outside Taviron.
 */
create or replace function public.comm_seed_demo_samples()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_conv uuid;
  v_n integer := 0;
  r record;
begin
  perform private.require_permission('comms.admin');
  if not exists (select 1 from public.companies where id = v_company and is_demo) then
    raise exception 'Sample content is only for demo companies.' using errcode = '42501';
  end if;
  select id into v_conv from public.conversations
  where company_id = v_company and kind = 'channel' and department = 'dispatch' and title = 'Dispatch desk' limit 1;
  if v_conv is null then
    insert into public.conversations (company_id, kind, title, title_custom, description, department, history_policy, members_can_add)
    values (v_company, 'channel', 'Dispatch desk', true, 'Sample channel: daily dispatch notes for drivers and the office.', 'dispatch', 'full', false)
    returning id into v_conv;
    insert into public.conversation_events (company_id, conversation_id, kind, details) values (v_company, v_conv, 'created', '{"sample": true}'::jsonb);
  end if;
  for r in select m.user_id from public.company_memberships m
           where m.company_id = v_company and m.active and m.role is not null
             and not exists (select 1 from private.platform_admins p where p.user_id = m.user_id and p.revoked_at is null) loop
    if private.comm_add_member(v_company, v_conv, r.user_id, 'manual', true, 'manager') then v_n := v_n + 1; end if;
  end loop;
  if not exists (select 1 from public.messages where conversation_id = v_conv and expired_at is null
                 and created_at > now() - private.comm_retention() + interval '1 day') then
    insert into public.messages (company_id, conversation_id, author_id, kind, body, pinned) values
      (v_company, v_conv, null, 'system', 'Sample instruction: check in with the receiving office before unloading at every customer site.', true),
      (v_company, v_conv, null, 'system', 'Sample instruction: post any delay over 30 minutes here so dispatch can update the customer.', true),
      (v_company, v_conv, null, 'system', 'Sample note: fuel cards renew Friday. Messages here expire after 14 days.', false);
    update public.conversations set last_message_at = clock_timestamp() where id = v_conv;
    v_n := v_n + 3;
  end if;
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- Prospect demo owners join the sample conversations when they are added
-- (redefines 20261107000100's function; same signature and grants).
-- -----------------------------------------------------------------------------
create or replace function public.platform_prospect_demo_add_owner(p_company uuid, p_user uuid, p_full_name text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.companies where id = p_company and demo_kind = 'prospect' and active) then
    raise exception 'Owners can be added this way only to an active prospect demo company.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'That login does not exist yet. Create it with a setup link first.' using errcode = 'P0002';
  end if;
  insert into public.company_memberships (company_id, user_id, role, active) values (p_company, p_user, 'owner', true)
  on conflict (company_id, user_id) do update set role = 'owner', active = true;
  -- Their first sign-in lands in the demo only if they belong to no other company.
  update public.profiles set active_company_id = p_company
  where id = p_user and (active_company_id is null
    or not exists (select 1 from public.company_memberships m where m.user_id = p_user and m.company_id = active_company_id and m.active));
  -- Their name (only when the login has none yet), and the demo's matching, still unlinked employee record.
  if nullif(trim(p_full_name), '') is not null then
    update public.profiles set full_name = left(trim(p_full_name), 120) where id = p_user and coalesce(trim(full_name), '') = '';
    update public.employees set user_id = p_user
    where company_id = p_company and user_id is null and lower(full_name) = lower(trim(p_full_name))
      and not exists (select 1 from public.employees e where e.company_id = p_company and e.user_id = p_user);
  end if;
  -- They see the demo's sample conversations at once (no Refresh needed): the sample channel and the demo's
  -- operational workspaces (an owner of the demo sees its operations, as the operator who created them does).
  perform private.comm_add_member(p_company, c.id, p_user, 'manual', true, 'manager')
  from public.conversations c
  where c.company_id = p_company and c.status = 'active'
    and ((c.kind = 'channel' and c.title = 'Dispatch desk' and c.department = 'dispatch') or c.kind = 'operation');
  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  values (p_company, null, 'membership.demo_owner_added', 'company', p_company, 'Prospect demo owner added by the platform operator',
          jsonb_build_object('user_id', p_user));
end;
$$;

-- -----------------------------------------------------------------------------
-- Names in demo companies: the employee record's name (the presenter's persona)
-- -----------------------------------------------------------------------------
/**
 * The name shown for a person in Communications. In a demo company a login linked to an employee record appears
 * under that record's name, so the presenter's own name never shows inside the demo (docs/DEMO_TENANTS.md §2).
 * Real companies are unchanged: display name, then full name.
 */
create or replace function private.comm_user_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select nullif(trim(e.full_name), '') from public.employees e join public.companies c on c.id = e.company_id
     where e.company_id = private.current_company_id() and e.user_id = p_user and c.is_demo limit 1),
    (select coalesce(nullif(trim(p.display_name), ''), nullif(trim(p.full_name), ''), 'Unnamed user') from public.profiles p where p.id = p_user))
$$;
revoke execute on function private.comm_user_name(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
revoke execute on function public.comm_delete_message(uuid, text) from public, anon;
grant execute on function public.comm_delete_message(uuid, text) to authenticated;
revoke execute on function public.comm_seed_demo_samples() from public, anon;
grant execute on function public.comm_seed_demo_samples() to authenticated;
revoke execute on function public.comm_housekeeping_all() from public, anon, authenticated;
grant execute on function public.comm_housekeeping_all() to service_role;
revoke execute on function public.comm_expired_attachment_files(integer) from public, anon, authenticated;
grant execute on function public.comm_expired_attachment_files(integer) to service_role;
revoke execute on function public.comm_mark_attachment_files_removed(uuid[]) from public, anon, authenticated;
grant execute on function public.comm_mark_attachment_files_removed(uuid[]) to service_role;
revoke execute on function private.comm_legal_hold(uuid) from public, anon, authenticated;
revoke execute on function private.comm_edit_window() from public, anon;
revoke execute on function private.comm_retention() from public, anon;
