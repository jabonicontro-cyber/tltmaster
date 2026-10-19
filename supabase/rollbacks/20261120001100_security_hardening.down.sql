-- Rollback of 20261120001100_security_hardening: restores the definitions from before it (20261120000400-000900)
-- and removes the duplicate guards. Not destructive: no data is dropped. Run with psql -v ON_ERROR_STOP=1 -1 -f.
drop trigger if exists portal_quote_requests_dedupe on public.portal_quote_requests;
drop trigger if exists portal_support_requests_dedupe on public.portal_support_requests;
drop function if exists private.portal_request_dedupe();

CREATE OR REPLACE FUNCTION private.current_company_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select m.company_id
  from public.company_memberships m
  join public.companies c on c.id = m.company_id and c.active
  join public.profiles p on p.id = m.user_id
  where m.user_id = auth.uid()
    and m.active
    and m.role is not null
  order by (m.company_id = p.active_company_id) desc nulls last, m.created_at, m.company_id
  limit 1
$$;

CREATE OR REPLACE FUNCTION public.mfa_policy() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select jsonb_build_object(
    'platform', private.is_platform_admin() and private.platform_mfa_enforced(),
    'companies', coalesce((select jsonb_agg(c.name order by c.name)
                           from public.company_memberships m
                           join public.companies c on c.id = m.company_id and c.active
                           join public.company_settings s on s.company_id = c.id
                           where m.user_id = auth.uid() and m.active and s.require_mfa), '[]'::jsonb),
    'current_company', coalesce((select s.require_mfa from public.company_settings s where s.company_id = private.current_company_id()), false),
    'recovery_codes', (select count(*) from private.mfa_recovery_codes r where r.user_id = auth.uid() and r.used_at is null),
    'recent_failures', (select count(*) from private.mfa_attempts a where a.user_id = auth.uid() and not a.ok and a.at > now() - interval '15 minutes'),
    'aal2', private.aal2());
$$;

CREATE OR REPLACE FUNCTION public.set_company_mfa_policy(p_required boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('settings.manage');
  -- Turning it on from a session without MFA would lock the person out of their own change.
  if p_required and not private.aal2() then
    raise exception 'Set up two-step verification for your own account first (My profile → Security).' using errcode = '42501';
  end if;
  update public.company_settings set require_mfa = coalesce(p_required, false) where company_id = v_company;
  perform private.log_event('security.mfa_policy', 'company', v_company,
    case when p_required then 'Two-step verification required for everyone' else 'Two-step verification no longer required' end, '{}'::jsonb);
  perform private.security_log('mfa.company_policy', jsonb_build_object('company_id', v_company, 'required', p_required));
end;
$$;

CREATE OR REPLACE FUNCTION public.mfa_recovery_redeem(p_code text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_code text := lower(regexp_replace(coalesce(p_code, ''), '[^0-9a-fA-F]', '', 'g'));
  v_hash text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if (select count(*) from private.mfa_attempts a where a.user_id = auth.uid() and not a.ok and a.at > now() - interval '15 minutes') >= 5 then
    -- (Not logged: the exception rolls the statement back. The failures before it are recorded.)
    raise exception 'Too many attempts. Wait 15 minutes, or ask your administrator.' using errcode = '54000';
  end if;
  if length(v_code) = 10 then
    v_hash := encode(sha256(convert_to(substr(v_code, 1, 5) || '-' || substr(v_code, 6, 5), 'UTF8')), 'hex');
    update private.mfa_recovery_codes set used_at = now()
    where user_id = auth.uid() and code_hash = v_hash and used_at is null;
    if found then
      insert into private.mfa_attempts (user_id, ok) values (auth.uid(), true);
      perform private.security_log('mfa.recovery_used', jsonb_build_object('remaining',
        (select count(*) from private.mfa_recovery_codes r where r.user_id = auth.uid() and r.used_at is null)));
      return true;
    end if;
  end if;
  insert into private.mfa_attempts (user_id, ok) values (auth.uid(), false);
  perform private.security_log('mfa.recovery_failed', '{}'::jsonb);
  return false;
end;
$$;

CREATE OR REPLACE FUNCTION public.platform_help_overview() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select case when not private.is_platform_admin() then null else jsonb_build_object(
    'searches', (select count(*) from public.help_searches where created_at > now() - interval '90 days'),
    'no_results', (select coalesce(jsonb_agg(x), '[]') from (
        select lower(query) as query, count(*) as n from public.help_searches
        where results = 0 and created_at > now() - interval '90 days' group by lower(query) order by count(*) desc limit 20) x),
    'feedback', (select coalesce(jsonb_agg(x), '[]') from (
        select article_id, count(*) filter (where helpful) as helpful, count(*) filter (where not helpful) as not_helpful
        from public.help_feedback group by article_id order by count(*) filter (where not helpful) desc, article_id limit 50) x),
    'requests', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]') from (
        select r.id, c.name as company, c.is_demo, r.page, r.article_id, left(r.message, 600) as message, r.status, r.created_at
        from public.help_support_requests r join public.companies c on c.id = r.company_id
        order by r.created_at desc limit 50) x)
  ) end;
$$;

CREATE OR REPLACE FUNCTION public.portal_invite(p_customer uuid, p_contact uuid, p_email text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  v_company uuid := private.require_company();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_existing public.portal_accounts%rowtype;
  v_token text := private.portal_token();
  v_id uuid;
begin
  perform private.require_permission('customers.edit');
  if not exists (select 1 from public.customers where company_id = v_company and id = p_customer and active) then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  if p_contact is not null and not exists (select 1 from public.customer_contacts where company_id = v_company and id = p_contact and customer_id = p_customer) then
    raise exception 'Contact not found for this customer.' using errcode = 'P0002';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then
    raise exception 'Enter a valid email address.' using errcode = '22023';
  end if;
  select * into v_existing from public.portal_accounts where company_id = v_company and lower(email) = v_email and status <> 'revoked' for update;
  if found then
    if v_existing.customer_id <> p_customer then
      raise exception 'This email already has portal access for another customer.' using errcode = '23505';
    end if;
    if v_existing.status = 'active' then
      raise exception 'This email already has portal access.' using errcode = '23505';
    end if;
    update public.portal_accounts set invite_hash = private.portal_hash(v_token), invite_expires_at = now() + interval '7 days',
      invited_by = auth.uid(), invited_at = now(), contact_id = coalesce(p_contact, contact_id)
    where id = v_existing.id;
    v_id := v_existing.id;
  else
    insert into public.portal_accounts (company_id, customer_id, contact_id, email, invite_hash, invite_expires_at, invited_by)
    values (v_company, p_customer, p_contact, v_email, private.portal_hash(v_token), now() + interval '7 days', auth.uid())
    returning id into v_id;
  end if;
  perform private.log_event('portal.invited', 'portal_account', v_id, format('Portal invitation for %s', v_email), jsonb_build_object('customer_id', p_customer));
  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', now() + interval '7 days',
    'slug', (select slug from public.companies where id = v_company));
end;
$_$;

CREATE OR REPLACE FUNCTION public.portal_invite_peek(p_token text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select jsonb_build_object('email', a.email, 'slug', c.slug,
    'company', coalesce(nullif(s.display_name, ''), nullif(cs.company_name, ''), c.name),
    'customer', cu.name, 'expired', a.invite_expires_at < now(), 'open', private.portal_open(c.id))
  from public.portal_accounts a
  join public.companies c on c.id = a.company_id
  join public.customers cu on cu.company_id = a.company_id and cu.id = a.customer_id
  left join public.portal_settings s on s.company_id = c.id
  left join public.company_settings cs on cs.company_id = c.id
  where length(coalesce(p_token, '')) = 64 and a.invite_hash = private.portal_hash(p_token) and a.status = 'invited';
$$;

CREATE OR REPLACE FUNCTION public.portal_public(p_slug text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select private.portal_company_card(c.id) || jsonb_build_object('public_page', s.public_page)
  from public.companies c join public.portal_settings s on s.company_id = c.id
  where c.slug = p_slug and private.portal_open(c.id);
$$;

CREATE OR REPLACE FUNCTION private.portal_me(p_slug text) RETURNS public.portal_accounts
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE OR REPLACE FUNCTION public.portal_quote_response_handle(p_response uuid, p_confirm boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_company uuid := private.require_company();
  r public.portal_quote_responses%rowtype;
  v_result jsonb := '{}'::jsonb;
begin
  perform private.require_permission('quotes.status');
  select * into r from public.portal_quote_responses where id = p_response and company_id = v_company and status = 'pending' for update;
  if not found then
    raise exception 'Response not found or already handled.' using errcode = 'P0002';
  end if;
  if p_confirm then
    v_result := public.set_quote_status(r.quote_id, case when r.response = 'accept' then 'accepted' else 'declined' end::public.quote_status,
      left(format('Customer %s in the portal (%s)%s', case when r.response = 'accept' then 'accepted' else 'declined' end, r.signer_name,
                  case when r.note <> '' then ': ' || r.note else '' end), 500));
  end if;
  update public.portal_quote_responses set status = case when p_confirm then 'confirmed' else 'dismissed' end, handled_by = auth.uid(), handled_at = now()
  where id = r.id;
  return v_result;
end;
$$;

drop function if exists private.mfa_enrolled();
drop function if exists private.current_company_id_any();
