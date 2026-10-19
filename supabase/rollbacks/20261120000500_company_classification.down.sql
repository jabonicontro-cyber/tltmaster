-- Rollback of 20261120000500_company_classification (not a migration). Refuses while any company is archived or
-- classified practice (restore/reclassify them first, so nobody silently regains or loses access).
do $$
begin
  if exists (select 1 from public.companies where archived_at is not null or classification <> 'production') then
    raise exception 'Restore archived companies and reclassify practice companies as production before rolling back.';
  end if;
end $$;
drop function if exists public.platform_company_delete(uuid, text);
drop function if exists public.platform_company_delete_preview(uuid);
drop function if exists private.company_record_counts(uuid);
drop function if exists public.platform_company_restore(uuid);
drop function if exists public.platform_company_archive(uuid, text);
drop function if exists public.platform_company_classify(uuid, text);
drop function if exists public.platform_company_directory();
create function public.platform_company_directory()
 returns table (id uuid, name text, slug text, active boolean, created_at timestamptz, members integer, customers integer,
                trucks integer, drivers integer, owner_login boolean, imports_in_review integer, missing text[])
 language plpgsql
 stable
 security definer
 set search_path to ''
as $fn$
begin
  perform private.require_platform_admin();
  return query
    select c.id, c.name, c.slug, c.active, c.created_at, (x.s ->> 'members')::int, (x.s ->> 'customers')::int,
           (x.s ->> 'trucks')::int, (x.s ->> 'drivers')::int, (x.s ->> 'owner_login')::boolean,
           (x.s ->> 'imports_in_review')::int, private.setup_missing(x.s)
    from public.companies c cross join lateral (select private.company_setup(c.id) as s) x
    where not c.is_demo
    order by c.active desc, c.created_at desc;
end;
$fn$;
revoke all on function public.platform_company_directory() from public, anon;
grant execute on function public.platform_company_directory() to authenticated;
CREATE OR REPLACE FUNCTION public.platform_launchpad()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_companies jsonb;
  v_attention jsonb;
begin
  perform private.require_platform_admin();

  with c as (
    select c.id, c.name, c.active, c.created_at, private.company_setup(c.id) as setup
    from public.companies c where not c.is_demo
  )
  select jsonb_build_object(
    'total', count(*), 'active', count(*) filter (where active), 'inactive', count(*) filter (where not active),
    'created_30d', count(*) filter (where created_at > now() - interval '30 days'),
    'setup_incomplete', count(*) filter (where active and cardinality(private.setup_missing(setup)) > 0))
  into v_companies from c;

  with lead_items as (
    -- One item per lead: an overdue follow-up wins over "due today", which wins over "new".
    select distinct on (l.id)
           case when l.follow_up_on < current_date then 'lead_overdue'
                when l.follow_up_on = current_date then 'lead_due_today'
                else 'lead_new' end as kind,
           case when l.follow_up_on < current_date then 1 else 2 end as priority,
           l.name || coalesce(nullif(' (' || l.company_name || ')', ' ()'), '') as title,
           case when l.follow_up_on < current_date then 'Follow-up was due ' || to_char(l.follow_up_on, 'Mon FMDD')
                when l.follow_up_on = current_date then 'Follow-up due today'
                else 'Not contacted yet' end as detail,
           'lead' as ref_type, l.id::text as ref_id,
           coalesce(l.last_submitted_at, l.created_at) as since, l.follow_up_on as due_on
    from private.leads l
    where l.disposition <> 'spam' and l.status not in ('converted', 'not_proceeding')
      and (l.status = 'new' or l.follow_up_on <= current_date)
    order by l.id
  ), items as (
    select * from lead_items
    union all
    select 'lead_email_failed', 1, l.name, 'An email about this lead failed to send in the last 7 days', 'lead', l.id::text, max(e.created_at), null::date
    from private.lead_emails e join private.leads l on l.id = e.lead_id
    where e.status = 'failed' and e.created_at > now() - interval '7 days'
    group by l.id, l.name
    union all
    select 'import_review', 2, initcap(b.entity) || ' import for ' || c.name,
           'Waiting for review' || case when b.file_name <> '' then ' (' || b.file_name || ')' else '' end,
           'import', b.id::text, b.created_at, null::date
    from private.import_batches b join public.companies c on c.id = b.company_id
    where b.status = 'review'
    union all
    select 'company_setup', 3, c.name, 'Missing ' || array_to_string(private.setup_missing(private.company_setup(c.id)), ', '),
           'company', c.id::text, c.created_at, null::date
    from public.companies c
    where c.active and not c.is_demo and cardinality(private.setup_missing(private.company_setup(c.id))) > 0
    union all
    select 'demo_refresh_failed', 1, c.name, coalesce(nullif(a.summary, ''), 'The last refresh failed'), 'demo', c.id::text, a.occurred_at, null::date
    from public.companies c
    join lateral (select x.action, x.summary, x.occurred_at from private.platform_audit x
                  where x.target_type = 'company' and x.target_id = c.id::text and x.action in ('demo_refreshed', 'demo_refresh_failed')
                  order by x.occurred_at desc limit 1) a on a.action = 'demo_refresh_failed'
    where c.is_demo and c.active
  )
  -- Oldest problems first, except company setup: the most recently created companies are the ones being onboarded.
  , ranked as (
    select i.*, row_number() over (order by i.priority,
             case when i.kind = 'company_setup' then -extract(epoch from i.since) else extract(epoch from i.since) end nulls last) as rn
    from items i
  )
  select jsonb_build_object(
           'items', coalesce((select jsonb_agg(to_jsonb(r) - 'rn' order by r.rn) from ranked r where r.rn <= 30), '[]'),
           'total', (select count(*) from ranked),
           'by_kind', (select coalesce(jsonb_object_agg(kind, n), '{}') from (select kind, count(*) n from ranked group by kind) k))
  into v_attention;

  return jsonb_build_object(
    'as_of', now(),
    'companies', v_companies,
    'leads', jsonb_build_object(
      'by_status', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from private.leads where disposition <> 'spam' group by status) s),
      'new', (select count(*) from private.leads where status = 'new' and disposition <> 'spam'),
      'overdue', (select count(*) from private.leads where follow_up_on < current_date and disposition <> 'spam' and status not in ('converted', 'not_proceeding')),
      'due_today', (select count(*) from private.leads where follow_up_on = current_date and disposition <> 'spam' and status not in ('converted', 'not_proceeding')),
      'demo_scheduled', (select count(*) from private.leads where status = 'demo_scheduled' and disposition <> 'spam'),
      'onboarding', (select count(*) from private.leads where onboarding_stage = 'in_progress')),
    'imports', jsonb_build_object(
      'in_review', (select count(*) from private.import_batches where status = 'review'),
      'oldest_review_at', (select min(created_at) from private.import_batches where status = 'review'),
      'approved_30d', (select count(*) from private.import_batches where status = 'approved' and decided_at > now() - interval '30 days')),
    'email_failures_7d', (select count(*) from private.lead_emails where status = 'failed' and created_at > now() - interval '7 days'),
    'demos', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', c.id, 'name', c.name, 'kind', c.demo_kind, 'created_at', c.created_at,
                'last_refresh_at', r.occurred_at, 'last_refresh_ok', r.action = 'demo_refreshed', 'last_refresh_summary', r.summary)
              order by c.demo_kind, c.created_at desc), '[]')
              from public.companies c
              left join lateral (select x.action, x.summary, x.occurred_at from private.platform_audit x
                                 where x.target_type = 'company' and x.target_id = c.id::text and x.action in ('demo_refreshed', 'demo_refresh_failed')
                                 order by x.occurred_at desc limit 1) r on true
              where c.is_demo and c.active),
    'attention', v_attention,
    'activity', (select coalesce(jsonb_agg(to_jsonb(a) order by a.at desc), '[]') from (
      select * from (
        select x.occurred_at as at, 'platform' as source, x.action, x.summary, coalesce(nullif(p.full_name, ''), p.email, 'Operator') as actor,
               x.target_type as ref_type, x.target_id as ref_id
        from private.platform_audit x left join public.profiles p on p.id = x.actor_id
        order by x.occurred_at desc limit 25) pa
      union all
      select * from (
        select e.occurred_at, 'lead', e.action, l.name, coalesce(nullif(p.full_name, ''), p.email, case when e.actor_id is null then 'Website' else 'Operator' end),
               'lead', l.id::text
        from private.lead_events e join private.leads l on l.id = e.lead_id left join public.profiles p on p.id = e.actor_id
        where e.action <> 'status_consolidated'
        order by e.occurred_at desc limit 25) le
      order by 1 desc limit 25) a)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.platform_console()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_platform_admin();
  perform private.lifecycle_activate_due();
  return jsonb_build_object(
    'as_of', now(),
    'customers', (select jsonb_build_object(
        'total', count(*) filter (where c.active),
        'live', count(*) filter (where c.active and l.stage = 'live'),
        'onboarding', count(*) filter (where c.active and l.stage = 'onboarding'),
        'fee_due', count(*) filter (where c.active and l.stage = 'fee_due'),
        'no_plan', count(*) filter (where c.active and (l.company_id is null or l.plan_version_id is null)),
        'canceled', count(*) filter (where l.stage = 'canceled'),
        'go_live_14d', count(*) filter (where c.active and l.stage = 'onboarding' and l.go_live_on <= current_date + 14))
      from public.companies c left join private.company_lifecycle l on l.company_id = c.id where not c.is_demo),
    'mrr', (select jsonb_build_object(
        'cents', coalesce(sum(l.agreed_monthly_cents) filter (where l.stage = 'live'), 0),
        'live', count(*) filter (where l.stage = 'live'),
        'free', count(*) filter (where l.stage = 'live' and l.agreed_monthly_cents = 0),
        'contracted_not_live_cents', coalesce(sum(l.agreed_monthly_cents) filter (where l.stage in ('fee_due', 'onboarding')), 0))
      from private.company_lifecycle l join public.companies c on c.id = l.company_id where c.active and not c.is_demo),
    'pipeline', (select jsonb_build_object(
        'open', count(*),
        'new', count(*) filter (where status = 'new'),
        'demo_scheduled', count(*) filter (where status = 'demo_scheduled'),
        'overdue', count(*) filter (where follow_up_on < current_date))
      from private.leads where disposition <> 'spam' and status not in ('converted', 'not_proceeding')),
    'acks', (select coalesce(jsonb_object_agg(a.item_key, jsonb_build_object('at', a.acknowledged_at, 'note', a.note,
                                              'by', coalesce(nullif(p.full_name, ''), p.email, 'Operator'))), '{}')
             from private.platform_attention_acks a left join public.profiles p on p.id = a.acknowledged_by),
    'lifecycles', (select coalesce(jsonb_object_agg(l.company_id, jsonb_build_object('stage', l.stage, 'go_live_on', l.go_live_on,
                                   'agreed_monthly_cents', l.agreed_monthly_cents, 'offer', l.offer)), '{}')
                   from private.company_lifecycle l)
  );
end;
$function$;

alter table public.companies drop column if exists archived_prior_active;
alter table public.companies drop column if exists archive_reason;
alter table public.companies drop column if exists archived_by;
alter table public.companies drop column if exists archived_at;
alter table public.companies drop column if exists classification;
