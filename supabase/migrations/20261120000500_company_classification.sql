-- =============================================================================
-- Company classification, archive and safe deletion of practice companies (2026-10-20, master plan B67).
--
-- Owner's rule: nothing is classified automatically and no existing company is archived or deleted by this change;
-- the platform owner decides company by company once the controls exist.
-- 1. companies.classification: 'production' (default: every existing company stays a real customer) or 'practice'
--    (a practice/test company the platform owner marked). Managed demos stay identified by is_demo.
-- 2. Archive (reversible): hides the company from the default directory and from customer counts, onboarding metrics
--    and MRR; members cannot open it (active = false); the reason and who did it are kept; Restore puts back the
--    previous active state. Records are untouched.
-- 3. Permanent delete: only an archived company classified 'practice' (never a demo, never production), with its exact
--    name typed. The record counts are written to the immutable platform audit first; then every row with this
--    company's id in every table and its stored files are removed in one transaction, and the function verifies none
--    are left (otherwise everything is rolled back). Sign-in accounts are kept (a person may belong to other
--    companies); they simply lose this membership. Running it again for a deleted company reports it as done.
-- 4. Customer counts, MRR and launchpad attention exclude practice and archived companies.
-- Rollback: supabase/rollbacks/20261120000500_company_classification.down.sql
-- =============================================================================

alter table public.companies add column classification text not null default 'production' check (classification in ('production', 'practice'));
alter table public.companies add column archived_at timestamptz;
alter table public.companies add column archived_by uuid references auth.users (id) on delete set null;
alter table public.companies add column archive_reason text not null default '' check (length(archive_reason) <= 500);
alter table public.companies add column archived_prior_active boolean;

-- Directory rows carry classification and archive state.
drop function if exists public.platform_company_directory();
create function public.platform_company_directory()
 returns table (id uuid, name text, slug text, active boolean, created_at timestamptz, members integer, customers integer,
                trucks integer, drivers integer, owner_login boolean, imports_in_review integer, missing text[],
                classification text, archived_at timestamptz, archive_reason text)
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
           (x.s ->> 'imports_in_review')::int, private.setup_missing(x.s), c.classification, c.archived_at, c.archive_reason
    from public.companies c cross join lateral (select private.company_setup(c.id) as s) x
    where not c.is_demo
    order by c.active desc, c.created_at desc;
end;
$$;
revoke all on function public.platform_company_directory() from public, anon;
grant execute on function public.platform_company_directory() to authenticated;

create or replace function public.platform_company_classify(p_company uuid, p_class text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v public.companies%rowtype;
begin
  perform private.require_platform_admin();
  select * into v from public.companies where id = p_company for update;
  if not found then
    raise exception 'Company not found.' using errcode = 'P0002';
  end if;
  if v.is_demo then
    raise exception 'Demo companies are managed in Demo Management, not classified here.' using errcode = '22023';
  end if;
  if p_class not in ('production', 'practice') then
    raise exception 'Choose Production customer or Practice / test.' using errcode = '22023';
  end if;
  if v.classification = p_class then
    return;
  end if;
  update public.companies set classification = p_class where id = p_company;
  perform private.platform_log('company_classified', 'company', p_company::text,
    v.name || ': ' || case p_class when 'practice' then 'Practice / test' else 'Production customer' end,
    jsonb_build_object('from', v.classification, 'to', p_class));
end;
$$;

create or replace function public.platform_company_archive(p_company uuid, p_reason text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v public.companies%rowtype;
  v_reason text := left(btrim(coalesce(p_reason, '')), 500);
begin
  perform private.require_platform_admin();
  select * into v from public.companies where id = p_company for update;
  if not found then
    raise exception 'Company not found.' using errcode = 'P0002';
  end if;
  if v.archived_at is not null then
    return; -- already archived
  end if;
  if v_reason = '' then
    raise exception 'Say why the company is archived.' using errcode = '22023';
  end if;
  update public.companies set archived_at = now(), archived_by = auth.uid(), archive_reason = v_reason, archived_prior_active = active, active = false
  where id = p_company;
  perform private.platform_log('company_archived', 'company', p_company::text, v.name || ' archived', jsonb_build_object('reason', v_reason, 'was_active', v.active));
end;
$$;

create or replace function public.platform_company_restore(p_company uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v public.companies%rowtype;
begin
  perform private.require_platform_admin();
  select * into v from public.companies where id = p_company for update;
  if not found then
    raise exception 'Company not found.' using errcode = 'P0002';
  end if;
  if v.archived_at is null then
    return;
  end if;
  update public.companies set active = coalesce(v.archived_prior_active, true), archived_at = null, archived_by = null, archive_reason = '', archived_prior_active = null
  where id = p_company;
  perform private.platform_log('company_restored', 'company', p_company::text, v.name || ' restored', '{}');
end;
$$;

-- Every table (public and private) with a company_id column: what deletion would remove.
create or replace function private.company_record_counts(p_company uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  r record;
  v_n bigint;
  v_out jsonb := '{}';
begin
  for r in
    select c.table_schema, c.table_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.column_name = 'company_id' and c.table_schema in ('public', 'private')
    order by 1, 2
  loop
    execute format('select count(*) from %I.%I where company_id = $1', r.table_schema, r.table_name) into v_n using p_company;
    if v_n > 0 then
      v_out := v_out || jsonb_build_object(r.table_name, v_n);
    end if;
  end loop;
  select count(*) into v_n from storage.objects o where split_part(o.name, '/', 1) = p_company::text;
  if v_n > 0 then
    v_out := v_out || jsonb_build_object('stored files', v_n);
  end if;
  return v_out;
end;
$$;
revoke all on function private.company_record_counts(uuid) from public, anon, authenticated;

create or replace function public.platform_company_delete_preview(p_company uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v public.companies%rowtype;
  v_blockers text[] := '{}';
begin
  perform private.require_platform_admin();
  select * into v from public.companies where id = p_company;
  if not found then
    raise exception 'Company not found.' using errcode = 'P0002';
  end if;
  if v.is_demo then v_blockers := array_append(v_blockers, 'It is a demo company (retire demos in Demo Management).'); end if;
  if v.classification <> 'practice' then v_blockers := array_append(v_blockers, 'It is not classified as Practice / test.'); end if;
  if v.archived_at is null then v_blockers := array_append(v_blockers, 'Archive it first.'); end if;
  return jsonb_build_object('name', v.name, 'classification', v.classification, 'archived_at', v.archived_at, 'archive_reason', v.archive_reason,
    'eligible', cardinality(v_blockers) = 0, 'blockers', to_jsonb(v_blockers),
    'counts', private.company_record_counts(p_company),
    'members', (select count(*) from public.company_memberships m where m.company_id = p_company));
end;
$$;

create or replace function public.platform_company_delete(p_company uuid, p_confirm_name text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v public.companies%rowtype;
  v_counts jsonb;
  r record;
  v_left bigint := 0;
  v_n bigint;
begin
  perform private.require_platform_admin();
  select * into v from public.companies where id = p_company for update;
  if not found then
    if exists (select 1 from private.platform_audit a where a.action = 'company_deleted' and a.target_id = p_company::text) then
      return jsonb_build_object('already_deleted', true);
    end if;
    raise exception 'Company not found.' using errcode = 'P0002';
  end if;
  if v.is_demo or v.classification <> 'practice' or v.archived_at is null then
    raise exception 'Only an archived company classified as Practice / test can be deleted.' using errcode = '42501';
  end if;
  if p_confirm_name is distinct from v.name then
    raise exception 'Type the company name exactly to confirm.' using errcode = '22023';
  end if;
  v_counts := private.company_record_counts(p_company);
  -- The record of the deletion is written first and outlives the company (the platform audit is not company data).
  perform private.platform_log('company_deleted', 'company', p_company::text, v.name || ' permanently deleted',
    jsonb_build_object('counts', v_counts, 'reason', v.archive_reason, 'slug', v.slug));

  -- Guards that keep business records append-only must not stop removing the whole tenant: within this transaction
  -- only, triggers and foreign-key triggers are not fired; completeness is verified below instead.
  set local session_replication_role = replica;
  for r in
    select c.table_schema, c.table_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.column_name = 'company_id' and c.table_schema in ('public', 'private') and not (c.table_schema = 'private' and c.table_name = 'platform_audit')
  loop
    execute format('delete from %I.%I where company_id = $1', r.table_schema, r.table_name) using p_company;
  end loop;
  delete from storage.objects o where split_part(o.name, '/', 1) = p_company::text;
  delete from public.companies where id = p_company;
  set local session_replication_role = origin;

  -- Verify: nothing anywhere still points at the company.
  for r in
    select c.table_schema, c.table_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.column_name = 'company_id' and c.table_schema in ('public', 'private') and not (c.table_schema = 'private' and c.table_name = 'platform_audit')
  loop
    execute format('select count(*) from %I.%I where company_id = $1', r.table_schema, r.table_name) into v_n using p_company;
    v_left := v_left + v_n;
  end loop;
  if v_left > 0 or exists (select 1 from public.companies where id = p_company) then
    raise exception 'Deletion incomplete (% records left); nothing was deleted.', v_left using errcode = 'P0001';
  end if;
  return jsonb_build_object('deleted', true, 'counts', v_counts);
end;
$$;

revoke all on function public.platform_company_classify(uuid, text) from public, anon;
revoke all on function public.platform_company_archive(uuid, text) from public, anon;
revoke all on function public.platform_company_restore(uuid) from public, anon;
revoke all on function public.platform_company_delete_preview(uuid) from public, anon;
revoke all on function public.platform_company_delete(uuid, text) from public, anon;
grant execute on function public.platform_company_classify(uuid, text) to authenticated;
grant execute on function public.platform_company_archive(uuid, text) to authenticated;
grant execute on function public.platform_company_restore(uuid) to authenticated;
grant execute on function public.platform_company_delete_preview(uuid) to authenticated;
grant execute on function public.platform_company_delete(uuid, text) to authenticated;

-- Customer counts, MRR and launchpad attention: real (production, not archived) companies only.
create or replace function public.platform_launchpad()
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
    from public.companies c where not c.is_demo and c.classification = 'production' and c.archived_at is null
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
    where c.active and not c.is_demo and c.classification = 'production' and c.archived_at is null and cardinality(private.setup_missing(private.company_setup(c.id))) > 0
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

create or replace function public.platform_console()
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
      from public.companies c left join private.company_lifecycle l on l.company_id = c.id where not c.is_demo and c.classification = 'production' and c.archived_at is null),
    'mrr', (select jsonb_build_object(
        'cents', coalesce(sum(l.agreed_monthly_cents) filter (where l.stage = 'live'), 0),
        'live', count(*) filter (where l.stage = 'live'),
        'free', count(*) filter (where l.stage = 'live' and l.agreed_monthly_cents = 0),
        'contracted_not_live_cents', coalesce(sum(l.agreed_monthly_cents) filter (where l.stage in ('fee_due', 'onboarding')), 0))
      from private.company_lifecycle l join public.companies c on c.id = l.company_id where c.active and not c.is_demo and c.classification = 'production' and c.archived_at is null),
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
