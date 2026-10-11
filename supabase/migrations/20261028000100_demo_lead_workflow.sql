-- Demo-request workflow (founder's confirmed requirements, 2026-10-11).
--
-- 1. Six lead statuses: new, contacted, demo_scheduled, demo_completed,
--    converted, not_proceeding. Earlier statuses are folded in, never lost:
--      qualified  -> contacted       (the qualification stays in the history)
--      onboarding -> converted       (onboarding progress kept in onboarding_stage)
--      won        -> converted
--      lost       -> not_proceeding
--      spam       -> not_proceeding  (disposition = 'spam': hidden from the queue)
--    Each folded lead keeps its earlier status in legacy_status and gets a
--    'status_consolidated' history entry. Reversal:
--    supabase/rollbacks/20261028000100_demo_lead_workflow.down.sql.
-- 2. Demo requests record the number of hauling trucks and dispatch bases
--    (required for new demo requests; empty for older leads).
-- 3. lead_emails records every confirmation/notification attempt — sent, failed
--    or not sent (preview mode) — so the lead stays the source of truth.
-- 4. Creating a company from a lead marks it Converted with onboarding in progress.

-- 1. Columns ------------------------------------------------------------------
alter table private.leads
  add column truck_count      integer check (truck_count between 0 and 100000),
  add column base_count       integer check (base_count between 1 and 1000),
  add column disposition      text not null default '' check (disposition in ('', 'spam')),
  add column onboarding_stage text not null default '' check (onboarding_stage in ('', 'in_progress', 'live')),
  add column legacy_status    text check (legacy_status in ('qualified', 'onboarding', 'won', 'lost', 'spam'));

alter table private.lead_events drop constraint lead_events_action_check;
alter table private.lead_events add constraint lead_events_action_check check (action in (
  'submitted', 'resubmitted', 'status_changed', 'owner_changed', 'follow_up_changed', 'note_added', 'company_created',
  'status_consolidated', 'disposition_changed', 'onboarding_changed'));

-- 2. Fold the earlier statuses (history first, then the row) -------------------
insert into private.lead_events (lead_id, actor_id, action, detail, note)
select l.id, null, 'status_consolidated',
       jsonb_build_object('from', l.status,
                          'to', case l.status when 'qualified' then 'contacted' when 'onboarding' then 'converted'
                                              when 'won' then 'converted' else 'not_proceeding' end,
                          'disposition', case when l.status = 'spam' then 'spam' else '' end,
                          'onboarding_stage', case when l.status = 'onboarding' then 'in_progress' else '' end),
       case l.status
         when 'qualified'  then 'Was marked Qualified before the status list became New, Contacted, Demo Scheduled, Demo Completed, Converted, Not Proceeding. Now Contacted; the qualification is kept in this history.'
         when 'onboarding' then 'Was marked Onboarding. Now Converted, with onboarding shown as in progress.'
         when 'won'        then 'Was marked Won. Now Converted.'
         when 'lost'       then 'Was marked Lost. Now Not Proceeding.'
         when 'spam'       then 'Was marked Spam. Now Not Proceeding, flagged as spam and hidden from the active queue.'
       end
from private.leads l
where l.status in ('qualified', 'onboarding', 'won', 'lost', 'spam');

alter table private.leads drop constraint leads_status_check;

update private.leads set
  legacy_status    = status,
  disposition      = case when status = 'spam' then 'spam' else disposition end,
  onboarding_stage = case when status = 'onboarding' then 'in_progress' else onboarding_stage end,
  status           = case status when 'qualified' then 'contacted' when 'onboarding' then 'converted'
                                 when 'won' then 'converted' else 'not_proceeding' end
where status in ('qualified', 'onboarding', 'won', 'lost', 'spam');

alter table private.leads add constraint leads_status_check
  check (status in ('new', 'contacted', 'demo_scheduled', 'demo_completed', 'converted', 'not_proceeding'));
alter table private.leads add constraint leads_spam_closed check (disposition <> 'spam' or status = 'not_proceeding');

-- 3. Email attempts ----------------------------------------------------------------
create table private.lead_emails (
  id                  bigint generated always as identity primary key,
  lead_id             uuid not null references private.leads (id) on delete cascade,
  kind                text not null check (kind in ('confirmation', 'notification')),
  recipient           text not null default '' check (length(recipient) <= 254),
  mode                text not null check (mode in ('preview', 'test', 'live')),
  status              text not null check (status in ('sent', 'failed', 'not_sent')),
  provider_message_id text,
  detail              text not null default '' check (length(detail) <= 500),
  created_at          timestamptz not null default now()
);
create index lead_emails_lead on private.lead_emails (lead_id, created_at);
revoke all on private.lead_emails from public, anon, authenticated;

-- 4. Functions ----------------------------------------------------------------------

-- Server only (service role). As before, plus the counts; returns the lead id and
-- whether to send the prospect a confirmation (at most one per lead per day) to the
-- server only — the website's answer never says whether a lead already existed.
create or replace function public.lead_submit(p_lead jsonb, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind    text := p_lead ->> 'kind';
  v_name    text := trim(coalesce(p_lead ->> 'name', ''));
  v_email   text := lower(trim(coalesce(p_lead ->> 'email', '')));
  v_message text := trim(coalesce(p_lead ->> 'message', ''));
  v_trucks  integer;
  v_bases   integer;
  v_id      uuid;
  v_recent  integer;
  v_day     integer;
  v_created boolean := false;
begin
  if coalesce(p_ip_hash, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  -- Address fingerprints are kept only as long as the limits need them.
  delete from private.lead_attempts where created_at < now() - interval '2 days';
  select count(*) filter (where created_at > now() - interval '15 minutes'), count(*)
    into v_recent, v_day
  from private.lead_attempts where ip_hash = p_ip_hash and created_at > now() - interval '1 day';
  if v_recent >= 5 or v_day >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  insert into private.lead_attempts (ip_hash) values (p_ip_hash);

  begin
    v_trucks := nullif(trim(coalesce(p_lead ->> 'truck_count', '')), '')::integer;
    v_bases  := nullif(trim(coalesce(p_lead ->> 'base_count', '')), '')::integer;
  exception when others then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end;

  if v_kind not in ('demo', 'contact') or v_name = '' or length(v_name) > 120
     or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 or length(v_message) > 4000
     or (v_kind = 'demo' and (trim(coalesce(p_lead ->> 'company_name', '')) = '' or v_trucks is null or v_bases is null))
     or v_trucks not between 0 and 100000 or v_bases not between 1 and 1000 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  select id into v_id from private.leads
  where lower(email) = v_email and status not in ('converted', 'not_proceeding') and created_at > now() - interval '90 days'
  order by created_at desc limit 1
  for update;

  if v_id is not null then
    update private.leads set
      submission_count = submission_count + 1,
      last_submitted_at = now(),
      updated_at = now(),
      company_name = coalesce(nullif(left(trim(coalesce(p_lead ->> 'company_name', '')), 160), ''), company_name),
      phone = coalesce(nullif(left(trim(coalesce(p_lead ->> 'phone', '')), 40), ''), phone),
      truck_count = coalesce(v_trucks, truck_count),
      base_count = coalesce(v_bases, base_count)
    where id = v_id;
    insert into private.lead_events (lead_id, action, detail, note)
    values (v_id, 'resubmitted',
            jsonb_build_object('kind', v_kind, 'source', left(coalesce(p_lead ->> 'source_path', ''), 200), 'truck_count', v_trucks, 'base_count', v_bases),
            left(v_message, 4000));
  else
    insert into private.leads (kind, name, email, company_name, phone, message, source_path, truck_count, base_count)
    values (v_kind, v_name, v_email,
            left(trim(coalesce(p_lead ->> 'company_name', '')), 160),
            left(trim(coalesce(p_lead ->> 'phone', '')), 40),
            v_message,
            left(coalesce(p_lead ->> 'source_path', ''), 200),
            v_trucks, v_bases)
    returning id into v_id;
    insert into private.lead_events (lead_id, action, detail) values (v_id, 'submitted', jsonb_build_object('kind', v_kind));
    v_created := true;
  end if;
  return jsonb_build_object('ok', true, 'lead_id', v_id, 'created', v_created,
    'confirm', not exists (select 1 from private.lead_emails e where e.lead_id = v_id and e.kind = 'confirmation'
                           and e.status in ('sent', 'not_sent') and e.created_at > now() - interval '1 day'));
end;
$$;

-- Server only (service role): record one email attempt for a lead.
create or replace function public.lead_record_email(p_lead uuid, p_kind text, p_recipient text, p_mode text, p_status text, p_provider_id text, p_detail text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.lead_emails (lead_id, kind, recipient, mode, status, provider_message_id, detail)
  values (p_lead, p_kind, left(coalesce(p_recipient, ''), 254), p_mode, p_status, nullif(left(coalesce(p_provider_id, ''), 200), ''), left(coalesce(p_detail, ''), 500));
end;
$$;

-- The queue: '' = every lead not flagged as spam; 'spam' = only spam; otherwise one status.
drop function public.platform_leads(text, text, boolean);
create function public.platform_leads(p_search text, p_status text, p_due_only boolean)
returns table (id uuid, kind text, status text, name text, email text, company_name text, fleet_size text,
               truck_count integer, base_count integer, disposition text, onboarding_stage text,
               owner_id uuid, owner_name text, follow_up_on date, submission_count integer,
               last_submitted_at timestamptz, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := nullif(trim(coalesce(p_search, '')), '');
  v_s text := nullif(trim(coalesce(p_status, '')), '');
begin
  perform private.require_platform_admin();
  return query
    select l.id, l.kind, l.status, l.name, l.email, l.company_name, l.fleet_size, l.truck_count, l.base_count,
           l.disposition, l.onboarding_stage, l.owner_id,
           coalesce(nullif(p.full_name, ''), p.email), l.follow_up_on, l.submission_count, l.last_submitted_at, l.created_at
    from private.leads l left join public.profiles p on p.id = l.owner_id
    where (case when v_s is null then l.disposition <> 'spam'
                when v_s = 'spam' then l.disposition = 'spam'
                else l.status = v_s and l.disposition <> 'spam' end)
      and (not coalesce(p_due_only, false) or (l.follow_up_on is not null and l.follow_up_on <= current_date and l.status not in ('converted', 'not_proceeding')))
      and (v_q is null
           or l.name ilike '%' || v_q || '%' or l.email ilike '%' || v_q || '%'
           or l.company_name ilike '%' || v_q || '%' or l.message ilike '%' || v_q || '%')
    order by (l.status = 'new') desc, l.follow_up_on nulls last, l.last_submitted_at desc
    limit 500;
end;
$$;

create or replace function public.platform_lead(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform private.require_platform_admin();
  select to_jsonb(l) || jsonb_build_object('owner_name', coalesce(nullif(p.full_name, ''), p.email)) into v
  from private.leads l left join public.profiles p on p.id = l.owner_id where l.id = p_id;
  if v is null then return null; end if;
  return v || jsonb_build_object(
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('action', e.action, 'detail', e.detail, 'note', e.note, 'occurred_at', e.occurred_at,
                                          'actor', coalesce(nullif(p.full_name, ''), p.email, case when e.action = 'status_consolidated' then 'System' else 'Website' end))
                       order by e.occurred_at, e.id)
      from private.lead_events e left join public.profiles p on p.id = e.actor_id where e.lead_id = p_id), '[]'::jsonb),
    'emails', coalesce((
      select jsonb_agg(jsonb_build_object('kind', m.kind, 'recipient', m.recipient, 'mode', m.mode, 'status', m.status,
                                          'detail', m.detail, 'created_at', m.created_at) order by m.created_at, m.id)
      from private.lead_emails m where m.lead_id = p_id), '[]'::jsonb));
end;
$$;

-- Status, owner, follow-up, spam flag and onboarding progress; each change is recorded.
drop function public.platform_lead_update(uuid, text, uuid, date);
create function public.platform_lead_update(p_id uuid, p_status text, p_owner uuid, p_follow_up date, p_spam boolean, p_onboarding text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := private.require_platform_admin();
  v       private.leads%rowtype;
  v_disp  text := case when coalesce(p_spam, false) then 'spam' else '' end;
  v_stage text := coalesce(p_onboarding, '');
begin
  select * into v from private.leads where id = p_id for update;
  if not found then raise exception 'Lead not found.' using errcode = 'P0002'; end if;
  if p_status is null or p_status not in ('new', 'contacted', 'demo_scheduled', 'demo_completed', 'converted', 'not_proceeding') then
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  if v_stage not in ('', 'in_progress', 'live') then
    raise exception 'Unknown onboarding stage.';
  end if;
  if v_disp = 'spam' and p_status <> 'not_proceeding' then
    raise exception 'Only a lead marked Not Proceeding can be flagged as spam.';
  end if;
  if v_stage <> '' and p_status <> 'converted' then
    raise exception 'Onboarding progress applies to Converted leads only.';
  end if;
  if p_owner is not null and not exists (select 1 from private.platform_admins a where a.user_id = p_owner and a.revoked_at is null) then
    raise exception 'The owner must be a member of the platform team.' using errcode = '22023';
  end if;
  if p_status <> v.status then
    insert into private.lead_events (lead_id, actor_id, action, detail) values (p_id, v_me, 'status_changed', jsonb_build_object('from', v.status, 'to', p_status));
  end if;
  if v_disp <> v.disposition then
    insert into private.lead_events (lead_id, actor_id, action, detail) values (p_id, v_me, 'disposition_changed', jsonb_build_object('from', v.disposition, 'to', v_disp));
  end if;
  if v_stage <> v.onboarding_stage then
    insert into private.lead_events (lead_id, actor_id, action, detail) values (p_id, v_me, 'onboarding_changed', jsonb_build_object('from', v.onboarding_stage, 'to', v_stage));
  end if;
  if p_owner is distinct from v.owner_id then
    insert into private.lead_events (lead_id, actor_id, action, detail) values (p_id, v_me, 'owner_changed', jsonb_build_object('from', v.owner_id, 'to', p_owner));
  end if;
  if p_follow_up is distinct from v.follow_up_on then
    insert into private.lead_events (lead_id, actor_id, action, detail) values (p_id, v_me, 'follow_up_changed', jsonb_build_object('from', v.follow_up_on, 'to', p_follow_up));
  end if;
  update private.leads set status = p_status, disposition = v_disp, onboarding_stage = v_stage,
                           owner_id = p_owner, follow_up_on = p_follow_up, updated_at = now()
  where id = p_id;
end;
$$;

create or replace function public.platform_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'new_leads', (select count(*) from private.leads where status = 'new' and disposition <> 'spam'),
    'due_follow_ups', (select count(*) from private.leads where follow_up_on <= current_date and status not in ('converted', 'not_proceeding')),
    'open_leads', (select count(*) from private.leads where status not in ('converted', 'not_proceeding')),
    'companies', (select count(*) from public.companies where active and not is_demo),
    'imports_in_review', (select count(*) from private.import_batches where status = 'review'),
    'demo_company', (select jsonb_build_object('id', c.id, 'name', c.name, 'created_at', c.created_at)
                     from public.companies c where c.is_demo and c.active order by c.created_at desc limit 1)
  );
end;
$$;

create or replace function public.platform_create_company(p_name text, p_timezone text, p_lead uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   uuid := private.require_platform_admin();
  v_name text := trim(coalesce(p_name, ''));
  v_tz   text := coalesce(nullif(trim(p_timezone), ''), 'America/Chicago');
  v_base text;
  v_slug text;
  v_id   uuid;
  v_lead private.leads%rowtype;
begin
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'Enter the company name (2 to 120 characters).' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_tz) then
    raise exception 'Unknown time zone.' using errcode = '22023';
  end if;
  v_base := trim(both '-' from left(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), 40));
  loop
    v_slug := coalesce(nullif(v_base, ''), 'company') || '-' || substr(md5(gen_random_uuid()::text), 1, 6);
    exit when not exists (select 1 from public.companies where slug = v_slug);
  end loop;
  v_id := private.create_company(v_name, v_slug);
  update public.company_settings set timezone = v_tz where company_id = v_id;
  if p_lead is not null then
    select * into v_lead from private.leads where id = p_lead for update;
    if found then
      if v_lead.status <> 'converted' then
        insert into private.lead_events (lead_id, actor_id, action, detail)
        values (p_lead, v_me, 'status_changed', jsonb_build_object('from', v_lead.status, 'to', 'converted'));
      end if;
      if v_lead.onboarding_stage = '' then
        insert into private.lead_events (lead_id, actor_id, action, detail)
        values (p_lead, v_me, 'onboarding_changed', jsonb_build_object('from', '', 'to', 'in_progress'));
      end if;
      update private.leads set status = 'converted', disposition = '',
             onboarding_stage = case when onboarding_stage = '' then 'in_progress' else onboarding_stage end,
             updated_at = now()
      where id = p_lead;
      insert into private.lead_events (lead_id, actor_id, action, detail)
      values (p_lead, v_me, 'company_created', jsonb_build_object('company_id', v_id, 'company_name', v_name));
    end if;
  end if;
  perform private.platform_log('company_created', 'company', v_id::text, 'Created company ' || v_name,
                               jsonb_build_object('timezone', v_tz, 'lead_id', p_lead));
  return v_id;
end;
$$;

-- 5. Grants -------------------------------------------------------------------------
revoke execute on function public.lead_submit(jsonb, text), public.lead_record_email(uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.lead_submit(jsonb, text), public.lead_record_email(uuid, text, text, text, text, text, text) to service_role;
revoke execute on function public.platform_leads(text, text, boolean), public.platform_lead_update(uuid, text, uuid, date, boolean, text) from public, anon;
grant execute on function public.platform_leads(text, text, boolean), public.platform_lead_update(uuid, text, uuid, date, boolean, text) to authenticated, service_role;
