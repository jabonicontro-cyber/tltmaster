-- Rollback for 20261108000100_comm_hardening.sql (not a migration; run by hand on a backed-up database).
-- Restores the Communications functions as released in 20261105000100–0300 and removes the hardening columns.
-- Expired message rows keep their empty body as deleted tombstones; expired attachments become discarded.

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.unschedule(jobid) from cron.job where jobname = 'comm-housekeeping'$q$;
  end if;
end;
$$;

drop function if exists public.comm_seed_demo_samples();

-- platform_prospect_demo_add_owner as released in 20261107000100 (no sample channel join).
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
  insert into public.audit_events (company_id, actor_id, action, entity_type, entity_id, summary, details)
  values (p_company, null, 'membership.demo_owner_added', 'company', p_company, 'Prospect demo owner added by the platform operator',
          jsonb_build_object('user_id', p_user));
end;
$$;

drop function if exists public.comm_housekeeping_all();
drop function if exists public.comm_mark_attachment_files_removed(uuid[]);
drop function if exists public.comm_expired_attachment_files(integer);
drop function if exists public.comm_delete_message(uuid, text);

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


update public.messages set deleted_at = coalesce(deleted_at, expired_at) where expired_at is not null;
alter table public.messages drop constraint messages_text;
alter table public.messages add constraint messages_text check (kind <> 'text' or deleted_at is not null or length(trim(body)) > 0);
drop index if exists public.messages_retention_idx;
alter table public.messages drop column expired_at, drop column removal_kind;
alter table public.message_revisions drop column reason;

update public.message_attachments set status = 'discarded', message_id = null where status = 'expired';
alter table public.message_attachments drop constraint message_attachments_state;
alter table public.message_attachments add constraint message_attachments_state check (
  (status = 'pending' and uploaded_at is null and message_id is null)
  or (status = 'uploaded' and uploaded_at is not null and message_id is null)
  or (status = 'attached' and uploaded_at is not null and message_id is not null and attached_at is not null)
  or (status = 'discarded' and message_id is null));
alter table public.message_attachments drop constraint message_attachments_status_check;
alter table public.message_attachments add constraint message_attachments_status_check
  check (status in ('pending', 'uploaded', 'attached', 'discarded'));
drop index if exists public.message_attachments_expired_idx;
alter table public.message_attachments drop column expired_at, drop column file_removed_at;

revoke execute on function public.comm_delete_message(uuid) from public, anon;
grant execute on function public.comm_delete_message(uuid) to authenticated;
revoke execute on function private.comm_apply_retention(uuid) from public, anon, authenticated;

drop function if exists private.comm_legal_hold(uuid);
drop function if exists private.comm_retention();
drop function if exists private.comm_edit_window();
