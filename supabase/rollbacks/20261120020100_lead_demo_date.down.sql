-- Rollback of 20261120020100_lead_demo_date.sql (not a migration; run by hand after a backup, after rolling back
-- 20261120020200 and later, which use private.person_name). Removes the lead demo date (the dates and their history
-- entries are removed: back up first), the pipeline function and display names on the lead page; staff names go back
-- to full name, else email.
begin;

drop function if exists public.platform_lead_pipeline();
drop function if exists public.platform_lead_demo_date(uuid, date);

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

create or replace function private.staff_name(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(nullif((select p.full_name from public.profiles p where p.id = p_user), ''), (select p.email from public.profiles p where p.id = p_user), 'Taviron')
$$;
revoke all on function private.staff_name(uuid) from public, anon, authenticated;

drop function if exists private.person_name(uuid);

delete from private.lead_events where action = 'demo_date_changed';
alter table private.lead_events drop constraint lead_events_action_check;
alter table private.lead_events add constraint lead_events_action_check check (action in (
  'submitted', 'resubmitted', 'status_changed', 'owner_changed', 'follow_up_changed', 'note_added', 'company_created',
  'status_consolidated', 'disposition_changed', 'onboarding_changed'));
alter table private.leads drop column if exists demo_on;

commit;
