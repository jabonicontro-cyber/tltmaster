-- Platform console (PC1, owner 2026-11-12): a demo date on leads, display names in the console, and the lead pipeline.
--   1. private.leads.demo_on: the day a demo is booked (or was held). Set through public.platform_lead_demo_date()
--      (platform admins only); every change is a 'demo_date_changed' entry in the lead's history. The status is not
--      changed by it: Demo Scheduled stays a decision the team makes.
--   2. private.person_name(user): the name a person chose to be shown by (display name, else full name, else email).
--      The lead page's history now uses it, so a renamed team member shows their current name.
--   3. public.platform_lead_pipeline(): every lead not flagged as spam that is still open, or was closed in the last
--      90 days, with its owner, follow-up and demo dates, for the pipeline columns (platform admins only).
-- No emails, no business records. Reversible: supabase/rollbacks/20261120020100_lead_demo_date.down.sql.

alter table private.leads add column demo_on date check (demo_on between date '2020-01-01' and date '2100-12-31');

alter table private.lead_events drop constraint lead_events_action_check;
alter table private.lead_events add constraint lead_events_action_check check (action in (
  'submitted', 'resubmitted', 'status_changed', 'owner_changed', 'follow_up_changed', 'note_added', 'company_created',
  'status_consolidated', 'disposition_changed', 'onboarding_changed', 'demo_date_changed'));

-- The name a person is shown by. Called from platform functions only (security definer callers).
create or replace function private.person_name(p_user uuid)
returns text language sql stable set search_path = '' as $$
  select coalesce(nullif(btrim(p.display_name), ''), nullif(btrim(p.full_name), ''), p.email)
  from public.profiles p where p.id = p_user
$$;
revoke all on function private.person_name(uuid) from public, anon, authenticated;

-- Staff names in company history and support screens follow the display name too (was full name, else email).
create or replace function private.staff_name(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(private.person_name(p_user), 'Taviron')
$$;
revoke all on function private.staff_name(uuid) from public, anon, authenticated;

-- Set or clear a lead's demo date. Admins only; recorded in the lead's history.
create or replace function public.platform_lead_demo_date(p_id uuid, p_demo_on date)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := private.require_platform_admin();
  v private.leads%rowtype;
begin
  select * into v from private.leads where id = p_id for update;
  if not found then raise exception 'Lead not found.' using errcode = 'P0002'; end if;
  if p_demo_on is not null and (p_demo_on < current_date - 365 or p_demo_on > current_date + 365) then
    raise exception 'Choose a demo date within a year of today.' using errcode = '22023';
  end if;
  if p_demo_on is not distinct from v.demo_on then return; end if;
  insert into private.lead_events (lead_id, actor_id, action, detail)
  values (p_id, v_me, 'demo_date_changed', jsonb_build_object('from', v.demo_on, 'to', p_demo_on));
  update private.leads set demo_on = p_demo_on, updated_at = now() where id = p_id;
end;
$$;
revoke all on function public.platform_lead_demo_date(uuid, date) from public, anon;
grant execute on function public.platform_lead_demo_date(uuid, date) to authenticated;

-- The lead page: as 20261028000100, with people shown by their current display name.
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
  select to_jsonb(l) || jsonb_build_object('owner_name', private.person_name(l.owner_id)) into v
  from private.leads l where l.id = p_id;
  if v is null then return null; end if;
  return v || jsonb_build_object(
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('action', e.action, 'detail', e.detail, 'note', e.note, 'occurred_at', e.occurred_at,
                                          'actor', coalesce(private.person_name(e.actor_id), case when e.action = 'status_consolidated' then 'System' else 'Website' end))
                       order by e.occurred_at, e.id)
      from private.lead_events e where e.lead_id = p_id), '[]'::jsonb),
    'emails', coalesce((
      select jsonb_agg(jsonb_build_object('kind', m.kind, 'recipient', m.recipient, 'mode', m.mode, 'status', m.status,
                                          'detail', m.detail, 'created_at', m.created_at) order by m.created_at, m.id)
      from private.lead_emails m where m.lead_id = p_id), '[]'::jsonb));
end;
$$;

-- The pipeline: open leads, plus those closed (converted or not proceeding) in the last 90 days. No spam.
create or replace function public.platform_lead_pipeline()
returns table (id uuid, kind text, status text, name text, company_name text, truck_count integer, owner_name text,
               follow_up_on date, demo_on date, onboarding_stage text, created_at timestamptz, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  return query
    select l.id, l.kind, l.status, l.name, l.company_name, l.truck_count, private.person_name(l.owner_id),
           l.follow_up_on, l.demo_on, l.onboarding_stage, l.created_at, l.updated_at
    from private.leads l
    where l.disposition <> 'spam'
      and (l.status not in ('converted', 'not_proceeding') or l.updated_at > now() - interval '90 days')
    order by l.demo_on nulls last, l.follow_up_on nulls last, l.last_submitted_at desc
    limit 600;
end;
$$;
revoke all on function public.platform_lead_pipeline() from public, anon;
grant execute on function public.platform_lead_pipeline() to authenticated;
