-- =============================================================================
-- Platform owner Launchpad (2026-10-18, master plan B52; owner directive "Platform owner administration center").
--
-- 1. public.platform_launchpad(): one read for the Launchpad — company counts and setup gaps, lead pipeline, imports,
--    demos with their last refresh, failed lead emails, a prioritized needs-attention list (one item per underlying
--    problem) and recent activity (platform audit + lead history). Platform admins only.
-- 2. public.platform_company_directory() and public.platform_company(id): customer companies for the directory — setup steps, members (name, role), imports,
--    the lead it came from, and platform audit entries about it. No business records (orders, tickets, money).
-- 3. public.platform_record_demo_refresh(company, ok, summary): demo refreshes are audited (success and failure), so
--    the Launchpad can show the last refresh and a failure. Demo companies only.
-- 4. public.platform_create_company: refuses a second company for the same lead, and a company whose name matches an
--    active customer company (duplicate onboarding).
-- Rollback: supabase/rollbacks/20261118000100_platform_launchpad.down.sql
-- =============================================================================

-- Setup steps of a customer company (what "onboarded" means here; a record alone is not onboarded).
create or replace function private.company_setup(p_company uuid)
 returns jsonb
 language sql
 stable
 set search_path to ''
as $$
  select jsonb_build_object(
    'owner_login', exists (select 1 from public.company_memberships m where m.company_id = p_company and m.active and m.role = 'owner'),
    'customers', (select count(*)::int from public.customers x where x.company_id = p_company and x.active),
    'trucks', (select count(*)::int from public.trucks x where x.company_id = p_company and x.active),
    'drivers', (select count(*)::int from public.drivers x where x.company_id = p_company and x.active),
    'members', (select count(*)::int from public.company_memberships m where m.company_id = p_company and m.active),
    'imports_in_review', (select count(*)::int from private.import_batches b where b.company_id = p_company and b.status = 'review'));
$$;
revoke all on function private.company_setup(uuid) from public, anon, authenticated;

create or replace function private.setup_missing(p_setup jsonb)
 returns text[]
 language sql
 immutable
 set search_path to ''
as $$
  select array_remove(array[
    case when not (p_setup ->> 'owner_login')::boolean then 'owner login' end,
    case when (p_setup ->> 'customers')::int = 0 then 'customers' end,
    case when (p_setup ->> 'trucks')::int = 0 then 'trucks' end,
    case when (p_setup ->> 'drivers')::int = 0 then 'drivers' end], null);
$$;
revoke all on function private.setup_missing(jsonb) from public, anon, authenticated;

create or replace function public.platform_launchpad()
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
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
$$;
revoke all on function public.platform_launchpad() from public, anon;
grant execute on function public.platform_launchpad() to authenticated;

-- The company directory: every customer company with its setup gaps and pending imports (no business records).
create or replace function public.platform_company_directory()
 returns table (id uuid, name text, slug text, active boolean, created_at timestamptz, members integer, customers integer,
                trucks integer, drivers integer, owner_login boolean, imports_in_review integer, missing text[])
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
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
$$;
revoke all on function public.platform_company_directory() from public, anon;
grant execute on function public.platform_company_directory() to authenticated;

create or replace function public.platform_company(p_id uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v_c public.companies%rowtype;
  v_setup jsonb;
begin
  perform private.require_platform_admin();
  select * into v_c from public.companies where id = p_id;
  if not found then
    raise exception 'Company not found.' using errcode = 'P0002';
  end if;
  v_setup := private.company_setup(p_id);
  return jsonb_build_object(
    'id', v_c.id, 'name', v_c.name, 'slug', v_c.slug, 'active', v_c.active, 'is_demo', v_c.is_demo, 'demo_kind', v_c.demo_kind,
    'created_at', v_c.created_at,
    'timezone', (select s.timezone from public.company_settings s where s.company_id = p_id),
    'setup', v_setup,
    'missing', to_jsonb(private.setup_missing(v_setup)),
    'members', (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(nullif(pr.full_name, ''), pr.email), 'email', pr.email, 'role', m.role, 'active', m.active)
                                          order by m.active desc, m.role, pr.full_name), '[]')
                from public.company_memberships m join public.profiles pr on pr.id = m.user_id where m.company_id = p_id),
    'imports', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'entity', b.entity, 'status', b.status, 'file_name', b.file_name,
                                                            'created_at', b.created_at, 'decided_at', b.decided_at, 'result', b.result,
                                                            'rows', (select count(*) from private.import_rows r where r.batch_id = b.id),
                                                            'errors', (select count(*) from private.import_rows r where r.batch_id = b.id and r.status <> 'valid'))
                                          order by b.created_at desc), '[]')
                from private.import_batches b where b.company_id = p_id),
    'lead', (select jsonb_build_object('id', l.id, 'name', l.name, 'status', l.status, 'onboarding_stage', l.onboarding_stage)
             from private.lead_events e join private.leads l on l.id = e.lead_id
             where e.action = 'company_created' and e.detail ->> 'company_id' = p_id::text
             order by e.occurred_at desc limit 1),
    'audit', (select coalesce(jsonb_agg(jsonb_build_object('at', x.occurred_at, 'action', x.action, 'summary', x.summary,
                                                          'actor', coalesce(nullif(pr.full_name, ''), pr.email, 'Operator')) order by x.occurred_at desc), '[]')
              from (select * from private.platform_audit x
                    where (x.target_type = 'company' and x.target_id = p_id::text) or x.detail ->> 'company_id' = p_id::text
                    order by x.occurred_at desc limit 50) x
              left join public.profiles pr on pr.id = x.actor_id)
  );
end;
$$;
revoke all on function public.platform_company(uuid) from public, anon;
grant execute on function public.platform_company(uuid) to authenticated;

create or replace function public.platform_record_demo_refresh(p_company uuid, p_ok boolean, p_summary text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_name text;
begin
  perform private.require_platform_admin();
  select name into v_name from public.companies where id = p_company and is_demo;
  if not found then
    raise exception 'Only a demo company''s refresh can be recorded.' using errcode = 'P0002';
  end if;
  perform private.platform_log(case when p_ok then 'demo_refreshed' else 'demo_refresh_failed' end, 'company', p_company::text,
                               left(coalesce(p_summary, ''), 300), jsonb_build_object('company_name', v_name));
end;
$$;
revoke all on function public.platform_record_demo_refresh(uuid, boolean, text) from public, anon;
grant execute on function public.platform_record_demo_refresh(uuid, boolean, text) to authenticated;

-- Duplicate onboarding: one company per lead; no second active customer company with the same name.
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
  v_existing text;
begin
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'Enter the company name (2 to 120 characters).' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_tz) then
    raise exception 'Unknown time zone.' using errcode = '22023';
  end if;
  if p_lead is not null then
    select c.name into v_existing
    from private.lead_events e join public.companies c on c.id = (e.detail ->> 'company_id')::uuid
    where e.lead_id = p_lead and e.action = 'company_created' limit 1;
    if v_existing is not null then
      raise exception 'This lead already has a company (%). Open it from Companies instead of creating another.', v_existing using errcode = 'P0001';
    end if;
  end if;
  if exists (select 1 from public.companies where active and not is_demo and lower(name) = lower(v_name)) then
    raise exception 'An active company named % already exists. Open it from Companies, or use a different name.', v_name using errcode = 'P0001';
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
