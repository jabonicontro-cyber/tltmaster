-- B67 follow-up (owner, 2026-10-19): permanent company delete stays OFF on every database until the platform owner
-- turns it on with SQL after verifying it there ("keep permanent deletion disabled or safely blocked if its Production
-- authorization and database-role requirements have not been verified"). A separate migration because
-- 20261120000500 was already released and may be applied.
--
-- Turn on (owner only, SQL editor or psql):
--   insert into private.platform_settings (key, value) values ('company_delete_enabled', 'true')
--   on conflict (key) do update set value = excluded.value, updated_at = now();
-- Turn off: the same with 'false'.

create table if not exists private.platform_settings (
  key        text primary key check (key ~ '^[a-z_]{1,60}$'),
  value      text not null,
  updated_at timestamptz not null default now()
);
revoke all on private.platform_settings from public, anon, authenticated;

create or replace function private.company_delete_enabled()
 returns boolean
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select coalesce((select value = 'true' from private.platform_settings where key = 'company_delete_enabled'), false);
$$;
revoke all on function private.company_delete_enabled() from public, anon, authenticated;

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
    'delete_enabled', private.company_delete_enabled(),
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
  if not private.company_delete_enabled() then
    raise exception 'Permanent delete is turned off on this database until the platform owner enables it.' using errcode = '42501';
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

revoke all on function public.platform_company_delete_preview(uuid) from public, anon;
revoke all on function public.platform_company_delete(uuid, text) from public, anon;
grant execute on function public.platform_company_delete_preview(uuid) to authenticated;
grant execute on function public.platform_company_delete(uuid, text) to authenticated;
