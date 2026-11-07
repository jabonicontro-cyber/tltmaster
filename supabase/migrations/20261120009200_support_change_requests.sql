-- Support change requests (SA2, owner 2026-11-07 "yeah sure" to: let Taviron support handle people changes through a
-- separate approval the owner gives, request by request).
--   * During a support visit, staff still cannot change who can sign in or what they may do (20261120008900 §6, H1).
--     Instead, the same screens record the change as a request: what it is, in plain words, and the exact form it
--     would submit. Nothing changes.
--   * An owner of the company (a real member, never a visiting staff member) sees the request in Settings, Taviron
--     support, and approves or declines it. Approving runs that exact change as the owner, with the owner's own
--     permissions checked again at that moment; a one-time password or link it produces is shown to the owner only.
--   * Each request runs at most once (claimed pending -> running, then done or failed), expires after 3 days, and can
--     be withdrawn by the staff member who asked. Every step is in the company's audit log and the platform log.
--   * The stored form is never shown to anyone and never read back except by the approving owner's own run.
-- No emails. Reversible: supabase/rollbacks/20261120009200_support_change_requests.down.sql.

create table private.support_change_requests (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  session_id   uuid references private.support_sessions (id) on delete set null,
  requested_by uuid references auth.users (id) on delete set null,
  kind         text not null check (kind ~ '^[a-z][a-z0-9_.]{2,60}$'),
  payload      jsonb not null default '[]'::jsonb check (pg_column_size(payload) <= 16384),
  summary      text not null check (length(summary) between 3 and 300),
  details      jsonb not null default '[]'::jsonb check (jsonb_typeof(details) = 'array' and jsonb_array_length(details) <= 20 and pg_column_size(details) <= 8192),
  note         text not null default '' check (length(note) <= 300),
  status       text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'declined', 'withdrawn')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '3 days',
  decided_by   uuid references auth.users (id) on delete set null,
  decided_at   timestamptz,
  result       text not null default '' check (length(result) <= 500)
);
create index support_change_requests_company on private.support_change_requests (company_id, created_at desc);
create index support_change_requests_pending on private.support_change_requests (company_id) where status = 'pending';
alter table private.support_change_requests enable row level security;

-- A real, active owner of the current company (never a support visit).
create or replace function private.is_real_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.support_company() is null
     and exists (select 1 from public.company_memberships m
                 where m.company_id = private.current_company_id() and m.user_id = auth.uid() and m.active and m.role = 'owner')
$$;
revoke all on function private.is_real_owner() from public, anon, authenticated;

-- Staff during a visit: record a change for the owner to approve. Returns the request id.
create or replace function public.support_change_request(p_kind text, p_payload jsonb, p_summary text, p_details jsonb, p_note text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := private.support_company();
  v_session uuid;
  v_id uuid;
  v_summary text := left(trim(coalesce(p_summary, '')), 300);
begin
  if v_company is null then
    raise exception 'Only Taviron support, during a visit, asks an owner to approve a change.' using errcode = '42501';
  end if;
  if (select count(*) from private.support_change_requests r
      where r.company_id = v_company and r.status = 'pending' and r.expires_at > now()) >= 25 then
    raise exception 'There are already 25 changes waiting for the owner. Ask them to review those first.' using errcode = 'P0001';
  end if;
  select s.id into v_session from private.support_sessions s
   where s.user_id = auth.uid() and s.company_id = v_company and s.ended_at is null order by s.started_at desc limit 1;
  insert into private.support_change_requests (company_id, session_id, requested_by, kind, payload, summary, details, note)
  values (v_company, v_session, auth.uid(), p_kind, coalesce(p_payload, '[]'::jsonb), v_summary, coalesce(p_details, '[]'::jsonb), left(trim(coalesce(p_note, '')), 300))
  returning id into v_id;
  perform private.support_audit(v_company, 'support_request.created',
    format('%s (Taviron support) asked an owner to approve: %s', private.staff_name(auth.uid()), v_summary), jsonb_build_object('request', v_id, 'kind', p_kind));
  perform private.platform_log('support_request', 'company', v_company::text, format('Asked for approval: %s', v_summary), jsonb_build_object('request', v_id, 'kind', p_kind));
  return v_id;
end;
$$;
revoke all on function public.support_change_request(text, jsonb, text, jsonb, text) from public, anon;
grant execute on function public.support_change_request(text, jsonb, text, jsonb, text) to authenticated;

-- Owners and visiting staff: the company's requests (newest first, last 40). Never the stored form.
create or replace function public.support_change_requests()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_company uuid := private.require_company();
begin
  if private.current_app_role() is distinct from 'owner' then
    raise exception 'Only an owner can see changes Taviron support asked for.' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(x order by x->>'created_at' desc) from (
    select jsonb_build_object(
      'id', r.id, 'kind', r.kind, 'summary', r.summary, 'details', r.details, 'note', r.note,
      'status', case when r.status = 'pending' and r.expires_at <= now() then 'expired'
                     when r.status = 'running' and r.decided_at < now() - interval '15 minutes' then 'failed'
                     else r.status end,
      'result', case when r.status = 'running' and r.decided_at < now() - interval '15 minutes' then 'It did not finish. Check the change, then ask again if it is still needed.' else r.result end,
      'requested_by', private.staff_name(r.requested_by) || ' (Taviron support)',
      'mine', r.requested_by = auth.uid(),
      'created_at', r.created_at, 'expires_at', r.expires_at,
      'decided_by', case when r.decided_by is not null then private.staff_name(r.decided_by) end, 'decided_at', r.decided_at) as x
    from private.support_change_requests r
    where r.company_id = v_company
    order by r.created_at desc limit 40) v), '[]'::jsonb);
end;
$$;
revoke all on function public.support_change_requests() from public, anon;
grant execute on function public.support_change_requests() to authenticated;

-- Owner: approve. Claims the request exactly once and hands its form to the owner's own run.
create or replace function public.support_change_claim(p_request uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := private.require_company();
  r private.support_change_requests;
begin
  if not private.is_real_owner() then
    raise exception 'Only an owner of the company can approve a change Taviron support asked for.' using errcode = '42501';
  end if;
  update private.support_change_requests set status = 'running', decided_by = auth.uid(), decided_at = now()
   where id = p_request and company_id = v_company and status = 'pending' and expires_at > now()
  returning * into r;
  if r.id is null then
    raise exception 'This request is no longer waiting (approved, declined, withdrawn or expired).' using errcode = 'P0001';
  end if;
  perform private.support_audit(v_company, 'support_request.approved', format('Approved a change Taviron support asked for: %s', r.summary), jsonb_build_object('request', r.id, 'kind', r.kind));
  return jsonb_build_object('kind', r.kind, 'payload', r.payload, 'summary', r.summary, 'details', r.details);
end;
$$;
revoke all on function public.support_change_claim(uuid) from public, anon;
grant execute on function public.support_change_claim(uuid) to authenticated;

-- The approving owner: record how the run ended (only the result message; never a password or link).
create or replace function public.support_change_finish(p_request uuid, p_ok boolean, p_result text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := private.require_company();
  r private.support_change_requests;
begin
  update private.support_change_requests set status = case when p_ok then 'done' else 'failed' end, result = left(coalesce(p_result, ''), 500)
   where id = p_request and company_id = v_company and status = 'running' and decided_by = auth.uid()
  returning * into r;
  if r.id is null then return; end if;
  if not p_ok then
    perform private.support_audit(v_company, 'support_request.failed', format('A change Taviron support asked for did not go through: %s', r.summary),
                                  jsonb_build_object('request', r.id, 'result', left(coalesce(p_result, ''), 500)));
  end if;
end;
$$;
revoke all on function public.support_change_finish(uuid, boolean, text) from public, anon;
grant execute on function public.support_change_finish(uuid, boolean, text) to authenticated;

-- Owner: decline. Nothing changes.
create or replace function public.support_change_decline(p_request uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := private.require_company();
  r private.support_change_requests;
begin
  if not private.is_real_owner() then
    raise exception 'Only an owner of the company can decline a change Taviron support asked for.' using errcode = '42501';
  end if;
  update private.support_change_requests set status = 'declined', decided_by = auth.uid(), decided_at = now()
   where id = p_request and company_id = v_company and status = 'pending'
  returning * into r;
  if r.id is null then raise exception 'This request is no longer waiting.' using errcode = 'P0001'; end if;
  perform private.support_audit(v_company, 'support_request.declined', format('Declined a change Taviron support asked for: %s', r.summary), jsonb_build_object('request', r.id));
end;
$$;
revoke all on function public.support_change_decline(uuid) from public, anon;
grant execute on function public.support_change_decline(uuid) to authenticated;

-- The staff member who asked, during a visit to that company: withdraw it.
create or replace function public.support_change_withdraw(p_request uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r private.support_change_requests;
begin
  update private.support_change_requests set status = 'withdrawn', decided_at = now()
   where id = p_request and company_id = private.support_company() and requested_by = auth.uid() and status = 'pending'
  returning * into r;
  if r.id is null then raise exception 'This request is no longer waiting.' using errcode = 'P0001'; end if;
  perform private.support_audit(r.company_id, 'support_request.withdrawn', format('%s (Taviron support) withdrew: %s', private.staff_name(auth.uid()), r.summary), jsonb_build_object('request', r.id));
end;
$$;
revoke all on function public.support_change_withdraw(uuid) from public, anon;
grant execute on function public.support_change_withdraw(uuid) to authenticated;

-- my_access: as 20261120008900, plus 'support_requests' (changes waiting for an owner) for owners and visiting staff.
create or replace function public.my_access()
returns jsonb language sql stable security definer set search_path = '' as $$
  with cur as (select private.current_company_id() as company_id, private.support_company() as support_company),
  m as (
    -- The current company's membership, or (for users waiting for access) any membership.
    select m.*
    from public.company_memberships m, cur
    where m.user_id = auth.uid()
    order by (m.company_id = cur.company_id) desc nulls last, m.created_at
    limit 1
  ),
  visit as (
    select s.ends_at, s.started_at from private.support_sessions s, cur
    where cur.support_company is not null and s.user_id = auth.uid() and s.company_id = cur.support_company and s.ended_at is null
    order by s.started_at desc limit 1
  )
  select jsonb_build_object(
    'user_id', p.id,
    'email', p.email,
    'full_name', p.full_name,
    'company_id', cur.company_id,
    'company_name', (select c.name from public.companies c where c.id = cur.company_id),
    'role', case when cur.support_company is not null then 'owner'::public.app_role when cur.company_id is not null then m.role end,
    'active', case when cur.support_company is not null then true
                   else coalesce(m.active, true) and (m.company_id is null or exists (select 1 from public.companies c where c.id = m.company_id and c.active)) end,
    'membership_count', (select count(*) from public.company_memberships x where x.user_id = p.id and x.active and x.role is not null),
    'permissions', coalesce(
      (select jsonb_agg(rp.permission order by rp.permission)
       from public.role_permissions rp
       where cur.company_id is not null and rp.company_id = cur.company_id
         and ((cur.support_company is not null and rp.role = 'owner')
              or (cur.support_company is null and rp.role = m.role and m.active))),
      '[]'::jsonb),
    'support', (select jsonb_build_object('ends_at', v.ends_at, 'started_at', v.started_at) from visit v),
    'support_inside', coalesce(cur.support_company is null and cur.company_id is not null and m.role = 'owner'
      and exists (select 1 from private.support_sessions s where s.company_id = cur.company_id and s.ended_at is null and s.ends_at > now()), false),
    'support_requests', case when cur.company_id is not null and (cur.support_company is not null or (m.role = 'owner' and m.active))
      then (select count(*) from private.support_change_requests r where r.company_id = cur.company_id and r.status = 'pending' and r.expires_at > now())
      else 0 end
  )
  from public.profiles p
  cross join cur
  left join m on true
  where p.id = auth.uid()
$$;
