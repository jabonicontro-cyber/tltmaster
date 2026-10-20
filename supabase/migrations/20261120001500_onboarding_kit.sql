-- =============================================================================
-- Customer Onboarding Kit (docs/ONBOARDING.md §5): the working documents of an onboarding, kept per company next to
-- the guided checklist (20261120001000), plus go-live acceptance that gates activation.
--
-- 1. public.onboarding_forms: one current version per company and form — welcome email (Taviron edits), setup
--    questionnaire, dispatch worksheet, integration checklist (shared), integration verification (Taviron), testing
--    and issues (shared), go-live acceptance (Taviron records results) and after-launch follow-up (shared). Every save
--    is versioned and kept in public.onboarding_form_versions (append-only). A save names the version it edited, so
--    two people never overwrite each other silently.
-- 2. Go-live acceptance: fixed items; CRITICAL items (tenant and permissions, data validation and customer approval,
--    dispatch testing, safety/availability/maintenance procedures) must be Passed — never Not applicable or an
--    exception. Other items are Passed, Not applicable or an accepted exception with a written reason. Any open
--    critical issue in Testing also blocks. Sign-off is recorded, not a digital signature: the company's owner and a
--    Taviron administrator each confirm with their typed name; both sign-offs refer to the acceptance version they
--    saw, and any later change to the acceptance voids them (they stay in history).
-- 3. Activation: for a company with an onboarding checklist, Go Live Now and the scheduled go-live day both require
--    both sign-offs on the current acceptance. Without them the company stays in onboarding (scheduled activation
--    simply waits and is retried daily) — onboarding tasks being done never makes a company live. Companies without an
--    onboarding checklist (before this kit) are unchanged. Billing behaviour is unchanged: going live still only sets
--    live_at and, for annual terms, the commitment start; nothing is charged (no payment provider).
-- Never stored here: passwords, API keys, card data or government identifiers (the app refuses such fields; the forms
-- have no place for them).
-- Depends on 20261120001000 (onboarding_tasks, onboarding_staff/customer) and 20261118000300 (company_lifecycle).
-- Rollback: supabase/rollbacks/20261120001500_onboarding_kit.down.sql (destructive for kit data).
-- =============================================================================

create table public.onboarding_forms (
  company_id  uuid not null references public.companies (id) on delete cascade,
  form        text not null check (form in ('welcome_email', 'questionnaire', 'dispatch_worksheet', 'integrations',
                                            'integration_checks', 'testing', 'go_live', 'post_launch')),
  data        jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 200000),
  version     integer not null default 1 check (version > 0),
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (company_id, form)
);
alter table public.onboarding_forms enable row level security;

create table public.onboarding_form_versions (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  form        text not null,
  version     integer not null,
  data        jsonb not null,
  saved_by    uuid references auth.users (id) on delete set null,
  saved_side  text not null check (saved_side in ('company', 'taviron')),
  saved_at    timestamptz not null default now(),
  unique (company_id, form, version)
);
alter table public.onboarding_form_versions enable row level security;

create table public.onboarding_signoffs (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete cascade,
  party            text not null check (party in ('company', 'taviron')),
  signer_id        uuid references auth.users (id) on delete set null,
  signer_name      text not null check (length(btrim(signer_name)) between 2 and 120),
  signer_title     text not null default '' check (length(signer_title) <= 120),
  go_live_version  integer not null,
  statement        text not null check (length(statement) between 10 and 2000),
  exceptions       jsonb not null default '[]'::jsonb,
  signed_at        timestamptz not null default now()
);
alter table public.onboarding_signoffs enable row level security;

create or replace function private.onboarding_kit_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows are kept as history and cannot be changed or deleted.', tg_table_name using errcode = '42501';
end;
$$;
create trigger onboarding_form_versions_append_only before update or delete on public.onboarding_form_versions
  for each row when (current_setting('tlt.sample_purge', true) is distinct from 'on') execute function private.onboarding_kit_append_only();
create trigger onboarding_signoffs_append_only before update or delete on public.onboarding_signoffs
  for each row when (current_setting('tlt.sample_purge', true) is distinct from 'on') execute function private.onboarding_kit_append_only();

-- Direct reads: the company's settings.manage people only (Taviron reads through platform_onboarding_kit); writes go
-- through the functions below.
create policy onboarding_forms_read on public.onboarding_forms for select to authenticated
  using ((company_id = (select private.current_company_id()) and (select private.has_permission('settings.manage'))));
create policy onboarding_form_versions_read on public.onboarding_form_versions for select to authenticated
  using ((company_id = (select private.current_company_id()) and (select private.has_permission('settings.manage'))));
create policy onboarding_signoffs_read on public.onboarding_signoffs for select to authenticated
  using ((company_id = (select private.current_company_id()) and (select private.has_permission('settings.manage'))));

-- -----------------------------------------------------------------------------
-- Go-live acceptance rules
-- -----------------------------------------------------------------------------

/** The acceptance items, in order; critical ones must be Passed. */
create or replace function private.go_live_items()
returns table (key text, critical boolean)
language sql
immutable
set search_path = ''
as $$
  values ('commercial_scope', false), ('tenant_permissions', true), ('data_validation', true), ('dispatch_testing', true),
         ('safety_procedures', true), ('integrations', false), ('core_workflows', false), ('training', false),
         ('support_escalation', false), ('fallback', false), ('open_defects', false), ('launch_plan', false);
$$;

/**
 * What still blocks go-live for a company (empty = ready to sign). Reads the current acceptance and testing forms;
 * nothing here can be set by the browser (critical items and allowed states are defined above).
 */
create or replace function private.go_live_blockers(p_company uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb := coalesce((select data -> 'items' from public.onboarding_forms where company_id = p_company and form = 'go_live'), '{}'::jsonb);
  v_issues jsonb := coalesce((select data -> 'issues' from public.onboarding_forms where company_id = p_company and form = 'testing'), '[]'::jsonb);
  v_out text[] := '{}';
  r record;
  v_state text;
  v_reason text;
begin
  for r in select * from private.go_live_items() loop
    v_state := coalesce(v_items -> r.key ->> 'status', 'not_started');
    v_reason := btrim(coalesce(v_items -> r.key ->> 'note', ''));
    if r.critical and v_state <> 'passed' then
      v_out := v_out || format('%s must be Passed (it is %s).', r.key, replace(v_state, '_', ' '));
    elsif not r.critical and v_state not in ('passed', 'not_applicable', 'exception') then
      v_out := v_out || format('%s is %s.', r.key, replace(v_state, '_', ' '));
    elsif v_state in ('exception', 'not_applicable') and length(v_reason) < 5 then
      v_out := v_out || format('%s needs a written reason for %s.', r.key, replace(v_state, '_', ' '));
    end if;
  end loop;
  if jsonb_typeof(v_issues) = 'array' and exists (
    select 1 from jsonb_array_elements(v_issues) i
    where coalesce(i ->> 'status', 'open') <> 'resolved' and coalesce((i ->> 'critical')::boolean, false)) then
    v_out := v_out || 'An open critical issue in Testing must be resolved.'::text;
  end if;
  return v_out;
end;
$$;
revoke all on function private.go_live_blockers(uuid) from public, anon, authenticated;

/** Both sign-offs exist for the current acceptance version. */
create or replace function private.go_live_accepted(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.onboarding_forms f where f.company_id = p_company and f.form = 'go_live')
     and (select count(distinct s.party) from public.onboarding_signoffs s
          join public.onboarding_forms f on f.company_id = s.company_id and f.form = 'go_live' and f.version = s.go_live_version
          where s.company_id = p_company) = 2
     and cardinality(private.go_live_blockers(p_company)) = 0;
$$;
revoke all on function private.go_live_accepted(uuid) from public, anon, authenticated;

/** Does go-live of this company need the acceptance (it has an onboarding checklist)? */
create or replace function private.go_live_gated(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.onboarding_tasks t where t.company_id = p_company);
$$;
revoke all on function private.go_live_gated(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Reading and saving
-- -----------------------------------------------------------------------------

create or replace function private.onboarding_kit_json(p_company uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'forms', coalesce((select jsonb_object_agg(f.form, jsonb_build_object('data', f.data, 'version', f.version, 'updated_at', f.updated_at,
                         'updated_by', (select coalesce(nullif(p.full_name, ''), 'Someone') from public.profiles p where p.id = f.updated_by)))
                       from public.onboarding_forms f where f.company_id = p_company), '{}'::jsonb),
    'signoffs', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'party', s.party, 'signer_name', s.signer_name, 'signer_title', s.signer_title,
                         'go_live_version', s.go_live_version, 'signed_at', s.signed_at, 'exceptions', s.exceptions,
                         'current', s.go_live_version = (select f.version from public.onboarding_forms f where f.company_id = p_company and f.form = 'go_live'))
                         order by s.signed_at desc) from public.onboarding_signoffs s where s.company_id = p_company), '[]'::jsonb),
    'blockers', to_jsonb(private.go_live_blockers(p_company)),
    'accepted', private.go_live_accepted(p_company),
    'gated', private.go_live_gated(p_company),
    'lifecycle', (select jsonb_build_object('stage', l.stage, 'go_live_on', l.go_live_on, 'live_at', l.live_at)
                  from private.company_lifecycle l where l.company_id = p_company),
    'is_demo', (select c.is_demo from public.companies c where c.id = p_company));
$$;
revoke all on function private.onboarding_kit_json(uuid) from public, anon, authenticated;

/** Save one form (both sides; the side decides which forms it may write). Optimistic: p_version is what was edited. */
create or replace function private.onboarding_form_save(p_company uuid, p_form text, p_data jsonb, p_version integer, p_staff boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current public.onboarding_forms%rowtype;
  v_version integer;
  v_text text := lower(coalesce(p_data::text, ''));
begin
  if p_form not in ('welcome_email', 'questionnaire', 'dispatch_worksheet', 'integrations', 'integration_checks', 'testing', 'go_live', 'post_launch') then
    raise exception 'Unknown form.' using errcode = '22023';
  end if;
  if not p_staff and p_form in ('welcome_email', 'integration_checks', 'go_live') then
    raise exception 'Taviron completes this part. Add your notes to the questionnaire or the testing list.' using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'Nothing to save.' using errcode = '22023'; end if;
  -- No secrets: these forms record people, decisions and status, never credentials.
  if v_text ~ '"(password|passwd|secret|api_?key|token|card_?number|cvv|ssn|social_security)"\s*:' then
    raise exception 'Passwords, keys, card numbers and government identifiers are never stored in onboarding forms.' using errcode = '22023';
  end if;
  if p_form = 'go_live' and exists (select 1 from jsonb_each(coalesce(p_data -> 'items', '{}'::jsonb)) e
                                    where coalesce(e.value ->> 'status', 'not_started') not in ('not_started', 'in_progress', 'passed', 'failed', 'not_applicable', 'exception')
                                       or e.key not in (select key from private.go_live_items())) then
    raise exception 'Unknown acceptance item or state.' using errcode = '22023';
  end if;
  if p_form = 'go_live' and exists (select 1 from private.go_live_items() i
                                    where i.critical and coalesce(p_data -> 'items' -> i.key ->> 'status', '') in ('not_applicable', 'exception')) then
    raise exception 'Critical items (security, tenant isolation, data integrity, dispatch, safety) must pass; they cannot be waived.' using errcode = '22023';
  end if;
  select * into v_current from public.onboarding_forms where company_id = p_company and form = p_form for update;
  if found and p_version is distinct from v_current.version then
    raise exception 'Someone else saved this form (version %). Reload to see their changes; nothing was overwritten.', v_current.version using errcode = '40001';
  end if;
  if not found and coalesce(p_version, 0) <> 0 then
    raise exception 'This form changed. Reload and try again.' using errcode = '40001';
  end if;
  if found and v_current.data = p_data then
    return jsonb_build_object('version', v_current.version, 'unchanged', true);
  end if;
  v_version := coalesce(v_current.version, 0) + 1;
  insert into public.onboarding_forms (company_id, form, data, version, updated_by, updated_at)
  values (p_company, p_form, p_data, v_version, auth.uid(), now())
  on conflict (company_id, form) do update set data = excluded.data, version = excluded.version, updated_by = excluded.updated_by, updated_at = now();
  insert into public.onboarding_form_versions (company_id, form, version, data, saved_by, saved_side)
  values (p_company, p_form, v_version, p_data, auth.uid(), case when p_staff then 'taviron' else 'company' end);
  if p_form = 'go_live' and exists (select 1 from public.onboarding_signoffs s where s.company_id = p_company and s.go_live_version = v_version - 1) then
    perform private.platform_log('go_live_signoff_voided', 'company', p_company::text, 'Go-live acceptance changed after sign-off',
                                 jsonb_build_object('company_id', p_company, 'version', v_version));
  end if;
  return jsonb_build_object('version', v_version, 'unchanged', false);
end;
$$;
revoke all on function private.onboarding_form_save(uuid, text, jsonb, integer, boolean) from public, anon, authenticated;

/** Record a sign-off on the current acceptance (company: its owner; Taviron: a platform administrator). */
create or replace function private.onboarding_signoff(p_company uuid, p_party text, p_name text, p_title text, p_version integer, p_statement text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_form public.onboarding_forms%rowtype;
  v_blockers text[];
  v_exceptions jsonb;
begin
  select * into v_form from public.onboarding_forms where company_id = p_company and form = 'go_live' for update;
  if not found then raise exception 'The go-live acceptance has not been prepared yet.' using errcode = 'P0001'; end if;
  if p_version is distinct from v_form.version then
    raise exception 'The acceptance changed since you opened it. Review the current version before signing.' using errcode = '40001';
  end if;
  v_blockers := private.go_live_blockers(p_company);
  if cardinality(v_blockers) > 0 then
    raise exception 'Go-live cannot be signed yet: %', array_to_string(v_blockers, ' ') using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then raise exception 'Type your full name to sign.' using errcode = '22023'; end if;
  if exists (select 1 from public.onboarding_signoffs where company_id = p_company and party = p_party and go_live_version = v_form.version) then
    return private.onboarding_kit_json(p_company);  -- already signed this version (a retry)
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('item', e.key, 'status', e.value ->> 'status', 'reason', e.value ->> 'note')), '[]'::jsonb)
    into v_exceptions from jsonb_each(coalesce(v_form.data -> 'items', '{}'::jsonb)) e where e.value ->> 'status' in ('exception', 'not_applicable');
  insert into public.onboarding_signoffs (company_id, party, signer_id, signer_name, signer_title, go_live_version, statement, exceptions)
  values (p_company, p_party, auth.uid(), btrim(p_name), btrim(coalesce(p_title, '')), v_form.version, p_statement, v_exceptions);
  perform private.platform_log('go_live_signed', 'company', p_company::text,
    format('Go-live acceptance signed by %s (%s)', btrim(p_name), p_party),
    jsonb_build_object('company_id', p_company, 'party', p_party, 'version', v_form.version, 'exceptions', jsonb_array_length(v_exceptions)));
  return private.onboarding_kit_json(p_company);
end;
$$;
revoke all on function private.onboarding_signoff(uuid, text, text, text, integer, text) from public, anon, authenticated;

-- Company side (settings.manage in their current company; signing needs the owner role).
create or replace function public.onboarding_kit()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('settings.manage');
  return private.onboarding_kit_json(v_company);
end;
$$;

create or replace function public.onboarding_form_save(p_form text, p_data jsonb, p_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('settings.manage');
  return private.onboarding_form_save(v_company, p_form, p_data, p_version, false);
end;
$$;

create or replace function public.onboarding_go_live_sign(p_name text, p_title text, p_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('settings.manage');
  if private.current_app_role() is distinct from 'owner' then
    raise exception 'Only an owner of the company can sign the go-live acceptance.' using errcode = '42501';
  end if;
  if exists (select 1 from public.companies where id = v_company and is_demo) then
    raise exception 'Demo companies do not sign a real go-live.' using errcode = '42501';
  end if;
  return private.onboarding_signoff(v_company, 'company', p_name, p_title, p_version,
    'We reviewed the go-live acceptance, its evidence and any listed exceptions, and accept going live on these terms.');
end;
$$;

-- Taviron side (platform administrators with their second factor, like the rest of onboarding).
create or replace function public.platform_onboarding_kit(p_company uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return private.onboarding_kit_json(p_company);
end;
$$;

create or replace function public.platform_onboarding_form_save(p_company uuid, p_form text, p_data jsonb, p_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  if not exists (select 1 from public.companies where id = p_company) then raise exception 'Company not found.' using errcode = 'P0002'; end if;
  return private.onboarding_form_save(p_company, p_form, p_data, p_version, true);
end;
$$;

create or replace function public.platform_onboarding_go_live_sign(p_company uuid, p_name text, p_title text, p_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return private.onboarding_signoff(p_company, 'taviron', p_name, p_title, p_version,
    'Taviron verified the evidence for each acceptance item and agrees the company is ready to go live.');
end;
$$;

-- -----------------------------------------------------------------------------
-- Activation gate (redefines the two go-live paths of 20261118000300; everything else unchanged)
-- -----------------------------------------------------------------------------

create or replace function private.lifecycle_activate_due()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select l.company_id, c.name from private.company_lifecycle l join public.companies c on c.id = l.company_id
    where l.stage = 'onboarding' and l.go_live_on is not null and l.onboarding_fee_status in ('paid', 'waived')
      and l.go_live_on <= private.company_today(l.company_id)
    for update of l skip locked
  loop
    -- A company with an onboarding checklist waits for both go-live sign-offs (retried every day; never live by itself).
    if private.go_live_gated(r.company_id) and not private.go_live_accepted(r.company_id) then
      continue;
    end if;
    update private.company_lifecycle
       set stage = 'live', live_at = now(), commitment_start = case when terms = 'annual' then go_live_on end, updated_at = now()
     where company_id = r.company_id and stage = 'onboarding';
    if found then
      n := n + 1;
      insert into private.platform_audit (actor_id, action, target_type, target_id, summary, detail)
      values (null, 'company_went_live', 'company', r.company_id::text, 'Went live on the scheduled day', jsonb_build_object('company_name', r.name, 'scheduled', true));
    end if;
  end loop;
  return n;
end;
$$;
revoke all on function private.lifecycle_activate_due() from public, anon, authenticated;

create or replace function public.platform_lifecycle_go_live_now(p_company uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v private.company_lifecycle;
  v_admin uuid;
  v_signed timestamptz;
begin
  v_admin := private.require_platform_admin();
  v := private.lifecycle_for_update(p_company);
  if v.stage = 'live' then
    return private.lifecycle_json(p_company) || jsonb_build_object('already_live', true);
  end if;
  if v.stage <> 'onboarding' then
    raise exception 'A company goes live from onboarding, after the onboarding fee is received or waived.' using errcode = 'P0001';
  end if;
  if private.go_live_gated(p_company) and not private.go_live_accepted(p_company) then
    raise exception 'Go-live needs the signed go-live acceptance from the company owner and Taviron (Onboarding → Go-live).' using errcode = 'P0001';
  end if;
  select u.last_sign_in_at into v_signed from auth.users u where u.id = v_admin;
  if v_signed is null or v_signed < now() - interval '5 minutes' then
    raise exception 'Enter your password again to go live now.' using errcode = '42501';
  end if;
  update private.company_lifecycle
     set stage = 'live', live_at = now(), go_live_on = private.company_today(p_company),
         commitment_start = case when terms = 'annual' then private.company_today(p_company) end, updated_by = v_admin, updated_at = now()
   where company_id = p_company;
  perform private.platform_log('company_went_live', 'company', p_company::text, 'Went live now (password confirmed)',
                               jsonb_build_object('company_id', p_company, 'scheduled', false, 'previous_go_live_on', v.go_live_on));
  return private.lifecycle_json(p_company);
end;
$$;
revoke all on function public.platform_lifecycle_go_live_now(uuid) from public, anon;
grant execute on function public.platform_lifecycle_go_live_now(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

revoke all on function public.onboarding_kit(), public.onboarding_form_save(text, jsonb, integer), public.onboarding_go_live_sign(text, text, integer),
  public.platform_onboarding_kit(uuid), public.platform_onboarding_form_save(uuid, text, jsonb, integer),
  public.platform_onboarding_go_live_sign(uuid, text, text, integer) from public, anon;
grant execute on function public.onboarding_kit(), public.onboarding_form_save(text, jsonb, integer), public.onboarding_go_live_sign(text, text, integer),
  public.platform_onboarding_kit(uuid), public.platform_onboarding_form_save(uuid, text, jsonb, integer),
  public.platform_onboarding_go_live_sign(uuid, text, text, integer) to authenticated;
revoke all on function private.go_live_items() from public, anon;
grant select on public.onboarding_forms, public.onboarding_form_versions, public.onboarding_signoffs to authenticated;
