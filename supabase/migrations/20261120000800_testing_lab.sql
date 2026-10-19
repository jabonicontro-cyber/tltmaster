-- =============================================================================
-- Testing Lab (B66): the platform owner previews and checks real experiences in demo companies.
--
--   * Customer portal preview: a platform admin may view a DEMO company's portal as one of its demo customers, for one
--     hour, without signing in as anyone else. The database allows it only when the company is a demo, the caller is a
--     platform admin and the preview was started (and audited) through platform_portal_preview_start. Real companies
--     can never be previewed this way: the check is here, not in the app.
--   * A checklist of experiences and their verification status, recorded by a person (never set by a page load).
-- Rollback: supabase/rollbacks/20261120000800_testing_lab.down.sql
-- =============================================================================

create table private.portal_previews (
  admin_id    uuid primary key references auth.users (id) on delete cascade,
  company_id  uuid not null references public.companies (id) on delete cascade,
  customer_id uuid not null,
  started_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
revoke all on private.portal_previews from public, anon, authenticated;

-- The demo customer's preview account (created when a preview starts; never has a sign-in of its own).
create or replace function private.portal_preview_account(p_company uuid, p_customer uuid)
 returns public.portal_accounts
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype;
  v_email text := format('preview-%s@portal-preview.invalid', left(replace(p_customer::text, '-', ''), 12));
begin
  select * into v from public.portal_accounts where company_id = p_company and customer_id = p_customer and lower(email) = v_email and status = 'active';
  if not found then
    insert into public.portal_accounts (company_id, customer_id, email, status, accepted_at)
    values (p_company, p_customer, v_email, 'active', now()) returning * into v;
  end if;
  return v;
end;
$$;
revoke all on function private.portal_preview_account(uuid, uuid) from public, anon, authenticated;

-- portal_me: a real customer account first; otherwise a platform admin's live preview of a demo company.
create or replace function private.portal_me(p_slug text)
 returns public.portal_accounts
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype;
  p private.portal_previews%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not available.' using errcode = '42501';
  end if;
  select a.* into v
  from public.portal_accounts a join public.companies c on c.id = a.company_id
  where c.slug = p_slug and a.user_id = auth.uid() and a.status = 'active'
    and exists (select 1 from public.customers cu where cu.company_id = a.company_id and cu.id = a.customer_id and cu.active);
  if found and private.portal_open(v.company_id) then
    return v;
  end if;
  select pv.* into p from private.portal_previews pv join public.companies c on c.id = pv.company_id
  where pv.admin_id = auth.uid() and c.slug = p_slug and c.is_demo and pv.expires_at > now();
  if found and private.is_platform_admin() and private.portal_open(p.company_id)
     and exists (select 1 from public.customers cu where cu.company_id = p.company_id and cu.id = p.customer_id and cu.active) then
    select a.* into v from public.portal_accounts a
    where a.company_id = p.company_id and a.customer_id = p.customer_id and a.status = 'active' and a.user_id is null
      and lower(a.email) like 'preview-%@portal-preview.invalid'
    limit 1;
    if found then
      return v;
    end if;
  end if;
  raise exception 'Not available.' using errcode = '42501';
end;
$$;
revoke all on function private.portal_me(text) from public, anon, authenticated;

create or replace function public.platform_portal_preview_start(p_company uuid, p_customer uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_slug text;
begin
  perform private.require_platform_admin();
  select slug into v_slug from public.companies where id = p_company and is_demo;
  if v_slug is null then
    raise exception 'Previews are only for demo companies.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.customers where company_id = p_company and id = p_customer and active) then
    raise exception 'Customer not found in this demo.' using errcode = 'P0002';
  end if;
  if not private.portal_open(p_company) then
    raise exception 'The demo''s customer portal is off. Refresh the demo data or turn it on in its Customer Portal settings.' using errcode = '22023';
  end if;
  perform private.portal_preview_account(p_company, p_customer);
  insert into private.portal_previews (admin_id, company_id, customer_id, expires_at)
  values (auth.uid(), p_company, p_customer, now() + interval '1 hour')
  on conflict (admin_id) do update set company_id = excluded.company_id, customer_id = excluded.customer_id, started_at = now(), expires_at = excluded.expires_at;
  perform private.platform_log('testing_lab.portal_preview', 'company', p_company::text, 'Customer portal preview started (1 hour)', jsonb_build_object('customer_id', p_customer));
  return jsonb_build_object('slug', v_slug, 'expires_at', now() + interval '1 hour');
end;
$$;

create or replace function public.platform_portal_preview_stop()
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  perform private.require_platform_admin();
  delete from private.portal_previews where admin_id = auth.uid();
end;
$$;

-- Am I previewing this portal? (For the preview banner; reveals nothing to anyone else.)
create or replace function public.portal_preview_state(p_slug text)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select jsonb_build_object('customer', cu.name, 'expires_at', pv.expires_at)
  from private.portal_previews pv
  join public.companies c on c.id = pv.company_id
  join public.customers cu on cu.company_id = pv.company_id and cu.id = pv.customer_id
  where pv.admin_id = auth.uid() and c.slug = p_slug and c.is_demo and pv.expires_at > now()
    and not exists (select 1 from public.portal_accounts a where a.company_id = c.id and a.user_id = auth.uid() and a.status = 'active');
$$;

-- Checklist ------------------------------------------------------------------------------------------------------------
create table private.testing_lab_checks (
  view_key   text not null check (view_key ~ '^[a-z0-9_.-]{1,80}$'),
  company_id uuid references public.companies (id) on delete cascade,
  status     text not null check (status in ('tested', 'failing', 'needs_config', 'blocked')),
  note       text not null default '' check (length(note) <= 1000),
  checked_by uuid references auth.users (id) on delete set null,
  checked_at timestamptz not null default now()
);
create unique index testing_lab_checks_key on private.testing_lab_checks (view_key, coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid));
revoke all on private.testing_lab_checks from public, anon, authenticated;

create or replace function public.platform_testing_checks()
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
begin
  perform private.require_platform_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object('view_key', t.view_key, 'company_id', t.company_id, 'status', t.status, 'note', t.note,
            'checked_at', t.checked_at, 'checked_by', (select p.full_name from public.profiles p where p.id = t.checked_by)) order by t.checked_at desc), '[]'::jsonb)
          from private.testing_lab_checks t);
end;
$$;

create or replace function public.platform_testing_record(p_view text, p_company uuid, p_status text, p_note text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  perform private.require_platform_admin();
  if p_view !~ '^[a-z0-9_.-]{1,80}$' or p_status not in ('tested', 'failing', 'needs_config', 'blocked', 'clear') then
    raise exception 'Unknown view or status.' using errcode = '22023';
  end if;
  if p_company is not null and not exists (select 1 from public.companies where id = p_company and is_demo) then
    raise exception 'Checks are recorded against demo companies only.' using errcode = '22023';
  end if;
  delete from private.testing_lab_checks where view_key = p_view and company_id is not distinct from p_company;
  if p_status <> 'clear' then
    insert into private.testing_lab_checks (view_key, company_id, status, note, checked_by)
    values (p_view, p_company, p_status, left(coalesce(p_note, ''), 1000), auth.uid());
  end if;
  perform private.platform_log('testing_lab.check', 'testing_lab', p_view, format('%s marked %s', p_view, p_status), jsonb_build_object('company_id', p_company, 'note', p_note));
end;
$$;

-- One demo company's facts for the Testing Lab: plan, bases, portal state and its (fictional) customers.
create or replace function public.platform_testing_demo(p_company uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  c public.companies%rowtype;
begin
  perform private.require_platform_admin();
  select * into c from public.companies where id = p_company and is_demo;
  if not found then
    raise exception 'Not a demo company.' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'id', c.id, 'name', c.name, 'slug', c.slug, 'kind', c.demo_kind, 'plan', c.demo_plan, 'active', c.active,
    'member', exists (select 1 from public.company_memberships m where m.company_id = c.id and m.user_id = auth.uid() and m.active),
    'bases', (select count(*) from public.dispatch_bases b where b.company_id = c.id and b.active),
    'portal', jsonb_build_object('entitled', private.portal_entitled(c.id), 'open', private.portal_open(c.id),
                                 'public_page', coalesce((select s.public_page from public.portal_settings s where s.company_id = c.id), false),
                                 'accounts', (select count(*) from public.portal_accounts a where a.company_id = c.id and a.status = 'active' and a.user_id is not null)),
    'customers', (select coalesce(jsonb_agg(jsonb_build_object('id', cu.id, 'name', cu.name,
                     'orders', (select count(*) from public.orders o where o.company_id = c.id and o.customer_id = cu.id and o.status <> 'draft'))
                   order by cu.name), '[]'::jsonb)
                  from public.customers cu where cu.company_id = c.id and cu.active and cu.relationship is distinct from 'prospect'));
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['public.platform_portal_preview_start(uuid,uuid)', 'public.platform_portal_preview_stop()', 'public.portal_preview_state(text)',
                           'public.platform_testing_checks()', 'public.platform_testing_record(text,uuid,text,text)', 'public.platform_testing_demo(uuid)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
