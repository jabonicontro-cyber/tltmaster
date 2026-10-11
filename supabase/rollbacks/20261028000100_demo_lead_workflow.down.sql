-- Reverses supabase/migrations/20261028000100_demo_lead_workflow.sql.
-- NOT a migration: run by hand, only after a backup and only if the founder asks.
-- Lead records, history and email attempts are kept; nothing is deleted except
-- the new functions. Statuses go back to the earlier list:
--   leads folded by the migration      -> their legacy_status
--   demo_completed (set after it)      -> qualified
--   converted / not_proceeding (after) -> onboarding if onboarding started, won;
--                                         spam if flagged, lost
-- The added columns stay (additive; the earlier functions ignore them).
begin;

drop function if exists public.lead_record_email(uuid, text, text, text, text, text, text);
drop function if exists public.platform_lead_update(uuid, text, uuid, date, boolean, text);
drop function if exists public.platform_leads(text, text, boolean);

alter table private.leads drop constraint leads_spam_closed;
alter table private.leads drop constraint leads_status_check;
update private.leads set status = coalesce(legacy_status, case status
    when 'demo_completed' then 'qualified'
    when 'converted' then case when onboarding_stage = 'in_progress' then 'onboarding' else 'won' end
    when 'not_proceeding' then case when disposition = 'spam' then 'spam' else 'lost' end
    else status end);
alter table private.leads add constraint leads_status_check
  check (status in ('new', 'contacted', 'demo_scheduled', 'qualified', 'onboarding', 'won', 'lost', 'spam'));
insert into private.lead_events (lead_id, action, detail, note)
select id, 'note_added', jsonb_build_object('rollback', '20261028000100'), 'Status list rolled back to the earlier version.' from private.leads;

-- The earlier function definitions, exactly as they were before the migration.
CREATE OR REPLACE FUNCTION public.lead_submit(p_lead jsonb, p_ip_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_kind    text := p_lead ->> 'kind';
  v_name    text := trim(coalesce(p_lead ->> 'name', ''));
  v_email   text := lower(trim(coalesce(p_lead ->> 'email', '')));
  v_message text := trim(coalesce(p_lead ->> 'message', ''));
  v_id      uuid;
  v_recent  integer;
  v_day     integer;
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

  if v_kind not in ('demo', 'contact') or v_name = '' or length(v_name) > 120
     or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 or length(v_message) > 4000 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  select id into v_id from private.leads
  where lower(email) = v_email and status not in ('won', 'lost', 'spam') and created_at > now() - interval '90 days'
  order by created_at desc limit 1
  for update;

  if v_id is not null then
    update private.leads set
      submission_count = submission_count + 1,
      last_submitted_at = now(),
      updated_at = now(),
      company_name = coalesce(nullif(left(trim(coalesce(p_lead ->> 'company_name', '')), 160), ''), company_name),
      phone = coalesce(nullif(left(trim(coalesce(p_lead ->> 'phone', '')), 40), ''), phone)
    where id = v_id;
    insert into private.lead_events (lead_id, action, detail, note)
    values (v_id, 'resubmitted', jsonb_build_object('kind', v_kind, 'source', left(coalesce(p_lead ->> 'source_path', ''), 200)), left(v_message, 4000));
    return jsonb_build_object('ok', true);
  end if;

  insert into private.leads (kind, name, email, company_name, phone, role_title, fleet_size, message, source_path)
  values (v_kind, v_name, v_email,
          left(trim(coalesce(p_lead ->> 'company_name', '')), 160),
          left(trim(coalesce(p_lead ->> 'phone', '')), 40),
          left(trim(coalesce(p_lead ->> 'role_title', '')), 120),
          left(trim(coalesce(p_lead ->> 'fleet_size', '')), 40),
          v_message,
          left(coalesce(p_lead ->> 'source_path', ''), 200))
  returning id into v_id;
  insert into private.lead_events (lead_id, action, detail) values (v_id, 'submitted', jsonb_build_object('kind', v_kind));
  return jsonb_build_object('ok', true);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.platform_create_company(p_name text, p_timezone text, p_lead uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me   uuid := private.require_platform_admin();
  v_name text := trim(coalesce(p_name, ''));
  v_tz   text := coalesce(nullif(trim(p_timezone), ''), 'America/Chicago');
  v_base text;
  v_slug text;
  v_id   uuid;
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
    update private.leads set status = 'onboarding', updated_at = now() where id = p_lead and status not in ('won', 'onboarding');
    insert into private.lead_events (lead_id, actor_id, action, detail)
    select p_lead, v_me, 'company_created', jsonb_build_object('company_id', v_id, 'company_name', v_name)
    where exists (select 1 from private.leads where id = p_lead);
  end if;
  perform private.platform_log('company_created', 'company', v_id::text, 'Created company ' || v_name,
                               jsonb_build_object('timezone', v_tz, 'lead_id', p_lead));
  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.platform_lead(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v jsonb;
begin
  perform private.require_platform_admin();
  select to_jsonb(l) || jsonb_build_object('owner_name', coalesce(nullif(p.full_name, ''), p.email)) into v
  from private.leads l left join public.profiles p on p.id = l.owner_id where l.id = p_id;
  if v is null then return null; end if;
  return v || jsonb_build_object('events', coalesce((
    select jsonb_agg(jsonb_build_object('action', e.action, 'detail', e.detail, 'note', e.note, 'occurred_at', e.occurred_at,
                                        'actor', coalesce(nullif(p.full_name, ''), p.email, 'Website')) order by e.occurred_at, e.id)
    from private.lead_events e left join public.profiles p on p.id = e.actor_id where e.lead_id = p_id), '[]'::jsonb));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.platform_lead_update(p_id uuid, p_status text, p_owner uuid, p_follow_up date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := private.require_platform_admin();
  v    private.leads%rowtype;
begin
  select * into v from private.leads where id = p_id for update;
  if not found then raise exception 'Lead not found.' using errcode = 'P0002'; end if;
  if p_status not in ('new', 'contacted', 'demo_scheduled', 'qualified', 'onboarding', 'won', 'lost', 'spam') then
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  if p_owner is not null and not exists (select 1 from private.platform_admins a where a.user_id = p_owner and a.revoked_at is null) then
    raise exception 'The owner must be a member of the platform team.' using errcode = '22023';
  end if;
  if p_status <> v.status then
    insert into private.lead_events (lead_id, actor_id, action, detail) values (p_id, v_me, 'status_changed', jsonb_build_object('from', v.status, 'to', p_status));
  end if;
  if p_owner is distinct from v.owner_id then
    insert into private.lead_events (lead_id, actor_id, action, detail) values (p_id, v_me, 'owner_changed', jsonb_build_object('from', v.owner_id, 'to', p_owner));
  end if;
  if p_follow_up is distinct from v.follow_up_on then
    insert into private.lead_events (lead_id, actor_id, action, detail) values (p_id, v_me, 'follow_up_changed', jsonb_build_object('from', v.follow_up_on, 'to', p_follow_up));
  end if;
  update private.leads set status = p_status, owner_id = p_owner, follow_up_on = p_follow_up, updated_at = now() where id = p_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.platform_leads(p_search text, p_status text, p_due_only boolean)
 RETURNS TABLE(id uuid, kind text, status text, name text, email text, company_name text, fleet_size text, owner_id uuid, owner_name text, follow_up_on date, submission_count integer, last_submitted_at timestamp with time zone, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_q text := nullif(trim(coalesce(p_search, '')), '');
begin
  perform private.require_platform_admin();
  return query
    select l.id, l.kind, l.status, l.name, l.email, l.company_name, l.fleet_size, l.owner_id,
           coalesce(nullif(p.full_name, ''), p.email), l.follow_up_on, l.submission_count, l.last_submitted_at, l.created_at
    from private.leads l left join public.profiles p on p.id = l.owner_id
    where (nullif(p_status, '') is null and l.status <> 'spam' or l.status = p_status)
      and (not coalesce(p_due_only, false) or (l.follow_up_on is not null and l.follow_up_on <= current_date and l.status not in ('won', 'lost', 'spam')))
      and (v_q is null
           or l.name ilike '%' || v_q || '%' or l.email ilike '%' || v_q || '%'
           or l.company_name ilike '%' || v_q || '%' or l.message ilike '%' || v_q || '%')
    order by (l.status = 'new') desc, l.follow_up_on nulls last, l.last_submitted_at desc
    limit 500;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.platform_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'new_leads', (select count(*) from private.leads where status = 'new'),
    'due_follow_ups', (select count(*) from private.leads where follow_up_on <= current_date and status not in ('won', 'lost', 'spam')),
    'open_leads', (select count(*) from private.leads where status not in ('won', 'lost', 'spam')),
    'companies', (select count(*) from public.companies where active and not is_demo),
    'imports_in_review', (select count(*) from private.import_batches where status = 'review'),
    'demo_company', (select jsonb_build_object('id', c.id, 'name', c.name, 'created_at', c.created_at)
                     from public.companies c where c.is_demo and c.active order by c.created_at desc limit 1)
  );
end;
$function$
;

revoke execute on function public.platform_leads(text, text, boolean), public.platform_lead_update(uuid, text, uuid, date) from public, anon;
grant execute on function public.platform_leads(text, text, boolean), public.platform_lead_update(uuid, text, uuid, date) to authenticated, service_role;
revoke execute on function public.lead_submit(jsonb, text) from public, anon, authenticated;
grant execute on function public.lead_submit(jsonb, text) to service_role;

commit;
