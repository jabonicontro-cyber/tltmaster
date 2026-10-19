-- =============================================================================
-- Security hardening after the 2026-10-19 review of the portal, Testing Lab, MFA and help releases
-- (docs/runbooks/2026-10-14-hosted-db.md §14; findings F1–F8 in docs/SECURITY_REVIEW_2026-10-19.md).
--
--   F1  Portal invitations: refused in demo companies and while the company's portal is not open; the invitation
--       preview says whether the company is a demo (the app then never creates an account or sends email). The app
--       no longer creates confirmed accounts from an invitation link (Supabase Auth emails the invitee instead).
--   F2  Two-step verification enforced in the database, not only in the app: a session below aal2 gets no company
--       (private.current_company_id() returns null) when the person has a verified authenticator or the company
--       requires two-step verification. mfa_policy() reads the ungated company and reports `enrolled` from
--       auth.mfa_factors (the app no longer trusts the browser's session copy for it). Changing the company policy in
--       either direction needs an aal2 session.
--   F3  platform_help_overview() goes through private.require_platform_admin() (platform MFA) like every other
--       platform function.
--   F4  Confirming a portal quote answer is refused when the quote was revised after the customer answered.
--   F5  Simultaneous identical portal quote requests or support requests: serialised per portal account, the second
--       one is refused as a duplicate. Recovery-code attempts are serialised per person (the 5-in-15-minutes limit
--       cannot be raced).
--   F6  A Testing Lab portal preview needs the same aal2 session as the rest of the platform console.
--   F7  portal_public() answers anonymous callers with the company card only when the public page is on; otherwise
--       just the name and branding the sign-in page needs.
--
-- Depends on 20261120000400 (help), 20261120000700 (portal), 20261120000800 (Testing Lab), 20261120000900 (MFA).
-- Rollback: supabase/rollbacks/20261120001100_security_hardening.down.sql (restores the earlier definitions).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- F2: database-side two-step verification
-- -----------------------------------------------------------------------------

/** The company the person is working in, before the two-step check (for mfa_policy and the check itself). */
create or replace function private.current_company_id_any()
 returns uuid
 language sql
 stable
 security definer
 set search_path to ''
as $$
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
revoke all on function private.current_company_id_any() from public, anon, authenticated;

/** Has this person a verified authenticator (Supabase Auth TOTP factor)? */
create or replace function private.mfa_enrolled()
 returns boolean
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified');
$$;
revoke all on function private.mfa_enrolled() from public, anon, authenticated;

/**
 * The caller's company — none for a session below aal2 when the person set up an authenticator or the company requires
 * two-step verification (the app sends them to /mfa first; this makes the database refuse too).
 */
create or replace function private.current_company_id()
 returns uuid
 language sql
 stable
 security definer
 set search_path to ''
as $$
  -- One query, cheapest test first: this runs inside most row-level security policies. (Same membership choice as
  -- private.current_company_id_any(), inlined rather than called: a nested definer call costs ~15% on the Command Center.)
  select case
    when x.company_id is null then null
    when coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' then x.company_id
    when exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified') then null
    when coalesce((select s.require_mfa from public.company_settings s where s.company_id = x.company_id), false) then null
    else x.company_id
  end
  from (select (
    select m.company_id
    from public.company_memberships m
    join public.companies c on c.id = m.company_id and c.active
    join public.profiles p on p.id = m.user_id
    where m.user_id = auth.uid()
      and m.active
      and m.role is not null
    order by (m.company_id = p.active_company_id) desc nulls last, m.created_at, m.company_id
    limit 1) as company_id) x
$$;

create or replace function public.mfa_policy()
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select jsonb_build_object(
    'platform', private.is_platform_admin() and private.platform_mfa_enforced(),
    'companies', coalesce((select jsonb_agg(c.name order by c.name)
                           from public.company_memberships m
                           join public.companies c on c.id = m.company_id and c.active
                           join public.company_settings s on s.company_id = c.id
                           where m.user_id = auth.uid() and m.active and s.require_mfa), '[]'::jsonb),
    'current_company', coalesce((select s.require_mfa from public.company_settings s where s.company_id = private.current_company_id_any()), false),
    'enrolled', private.mfa_enrolled(),
    'recovery_codes', (select count(*) from private.mfa_recovery_codes r where r.user_id = auth.uid() and r.used_at is null),
    'recent_failures', (select count(*) from private.mfa_attempts a where a.user_id = auth.uid() and not a.ok and a.at > now() - interval '15 minutes'),
    'aal2', private.aal2());
$$;

create or replace function public.set_company_mfa_policy(p_required boolean)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('settings.manage');
  -- Either direction: turning it on from a session without MFA would lock the person out; turning it off is a
  -- security downgrade that must not be possible with a password alone.
  if not private.aal2() then
    raise exception 'Verify with your authenticator app first (My profile → Security).' using errcode = '42501';
  end if;
  update public.company_settings set require_mfa = coalesce(p_required, false) where company_id = v_company;
  perform private.log_event('security.mfa_policy', 'company', v_company,
    case when p_required then 'Two-step verification required for everyone' else 'Two-step verification no longer required' end, '{}'::jsonb);
  perform private.security_log('mfa.company_policy', jsonb_build_object('company_id', v_company, 'required', p_required));
end;
$$;

create or replace function public.mfa_recovery_redeem(p_code text)
 returns boolean
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_code text := lower(regexp_replace(coalesce(p_code, ''), '[^0-9a-fA-F]', '', 'g'));
  v_hash text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  -- One attempt at a time per person, so parallel guesses cannot slip past the limit.
  perform pg_advisory_xact_lock(hashtextextended('mfa_recovery:' || auth.uid()::text, 0));
  if (select count(*) from private.mfa_attempts a where a.user_id = auth.uid() and not a.ok and a.at > now() - interval '15 minutes') >= 5 then
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

-- -----------------------------------------------------------------------------
-- F3: platform help overview through the platform check (with MFA)
-- -----------------------------------------------------------------------------

create or replace function public.platform_help_overview()
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
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
        order by r.created_at desc limit 50) x));
end;
$$;

-- -----------------------------------------------------------------------------
-- F1: portal invitations
-- -----------------------------------------------------------------------------

create or replace function public.portal_invite(p_customer uuid, p_contact uuid, p_email text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_existing public.portal_accounts%rowtype;
  v_token text := private.portal_token();
  v_id uuid;
begin
  perform private.require_permission('customers.edit');
  if exists (select 1 from public.companies where id = v_company and is_demo) then
    raise exception 'Demo companies do not invite customers: preview the portal from the Testing Lab instead.' using errcode = '42501';
  end if;
  if not private.portal_open(v_company) then
    raise exception 'Turn the customer portal on before inviting customers.' using errcode = 'P0001';
  end if;
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
$$;

create or replace function public.portal_invite_peek(p_token text)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select jsonb_build_object('email', a.email, 'slug', c.slug,
    'company', coalesce(nullif(s.display_name, ''), nullif(cs.company_name, ''), c.name),
    'customer', cu.name, 'expired', a.invite_expires_at < now(), 'open', private.portal_open(c.id), 'demo', c.is_demo)
  from public.portal_accounts a
  join public.companies c on c.id = a.company_id
  join public.customers cu on cu.company_id = a.company_id and cu.id = a.customer_id
  left join public.portal_settings s on s.company_id = c.id
  left join public.company_settings cs on cs.company_id = c.id
  where length(coalesce(p_token, '')) = 64 and a.invite_hash = private.portal_hash(p_token) and a.status = 'invited';
$$;

-- -----------------------------------------------------------------------------
-- F7: anonymous company card only with a public page
-- -----------------------------------------------------------------------------

create or replace function public.portal_public(p_slug text)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select case when s.public_page
    then private.portal_company_card(c.id) || jsonb_build_object('public_page', true)
    else (select jsonb_build_object('name', card ->> 'name', 'slug', card ->> 'slug', 'logo', card ->> 'logo', 'color', card ->> 'color',
                                    'timezone', card ->> 'timezone', 'is_demo', (card ->> 'is_demo')::boolean,
                                    'public_page', false)
          from (select private.portal_company_card(c.id) as card) x)
  end
  from public.companies c join public.portal_settings s on s.company_id = c.id
  where c.slug = p_slug and private.portal_open(c.id);
$$;

-- -----------------------------------------------------------------------------
-- F6: Testing Lab preview needs the platform's aal2 session
-- -----------------------------------------------------------------------------

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
  if found and private.is_platform_admin() and (private.aal2() or not private.platform_mfa_enforced()) and private.portal_open(p.company_id)
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

-- -----------------------------------------------------------------------------
-- F4: a quote answer applies only to the version the customer saw
-- -----------------------------------------------------------------------------

create or replace function public.portal_quote_response_handle(p_response uuid, p_confirm boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_company uuid := private.require_company();
  r public.portal_quote_responses%rowtype;
  v_current uuid;
  v_result jsonb := '{}'::jsonb;
begin
  perform private.require_permission('quotes.status');
  select * into r from public.portal_quote_responses where id = p_response and company_id = v_company and status = 'pending' for update;
  if not found then
    raise exception 'Response not found or already handled.' using errcode = 'P0002';
  end if;
  if p_confirm then
    select current_version_id into v_current from public.quotes where company_id = v_company and id = r.quote_id for update;
    if r.version_id is not null and v_current is distinct from r.version_id then
      raise exception 'The quote was revised after the customer answered. Dismiss this answer and send the new version.' using errcode = 'P0001';
    end if;
    v_result := public.set_quote_status(r.quote_id, case when r.response = 'accept' then 'accepted' else 'declined' end::public.quote_status,
      left(format('Customer %s in the portal (%s)%s', case when r.response = 'accept' then 'accepted' else 'declined' end, r.signer_name,
                  case when r.note <> '' then ': ' || r.note else '' end), 500));
  end if;
  update public.portal_quote_responses set status = case when p_confirm then 'confirmed' else 'dismissed' end, handled_by = auth.uid(), handled_at = now()
  where id = r.id;
  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- F5: no duplicate from two simultaneous identical requests
-- -----------------------------------------------------------------------------

create or replace function private.portal_request_dedupe()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('portal_request:' || new.account_id::text, 0));
  if tg_table_name = 'portal_quote_requests' then
    if exists (select 1 from public.portal_quote_requests r
               where r.company_id = new.company_id and r.customer_id = new.customer_id and r.status in ('new', 'reviewing')
                 and lower(r.material) = lower(new.material) and r.quantity is not distinct from new.quantity
                 and r.requested_date is not distinct from new.requested_date and r.created_at > now() - interval '7 days') then
      raise exception 'We already have this request.' using errcode = '23505';
    end if;
  elsif exists (select 1 from public.portal_support_requests r
                where r.company_id = new.company_id and r.account_id = new.account_id and r.status <> 'closed'
                  and lower(r.subject) = lower(new.subject) and r.created_at > now() - interval '10 minutes') then
    raise exception 'We already have this request.' using errcode = '23505';
  end if;
  return new;
end;
$$;
revoke all on function private.portal_request_dedupe() from public, anon, authenticated;

drop trigger if exists portal_quote_requests_dedupe on public.portal_quote_requests;
create trigger portal_quote_requests_dedupe before insert on public.portal_quote_requests
  for each row execute function private.portal_request_dedupe();
drop trigger if exists portal_support_requests_dedupe on public.portal_support_requests;
create trigger portal_support_requests_dedupe before insert on public.portal_support_requests
  for each row execute function private.portal_request_dedupe();
