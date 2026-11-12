-- Console search and audit log filters (PC1, owner 2026-11-12).
--   * public.platform_search(p_q): one search box for the Taviron team. Both staff levels find companies (Support:
--     active ones only, the ones they can help) and Help support requests; Admins also find leads, outreach companies
--     and team members. At most 8 of each, names and status only. 2 to 80 characters; % and _ are matched literally.
--   * public.platform_audit_search(...): the platform audit log filtered by who, what, which company (the target, or
--     the company id recorded in the entry), and a date range (days in America/Chicago, the console's time), newest
--     first, paged by entry id beyond the first page (up to 200 a page). Admins only.
--   * public.platform_audit_facets(): the actions and people that appear in the log, for the filter lists. Admins only.
-- Reads only. Reversible: supabase/rollbacks/20261120020600_console_search_audit.down.sql.

create or replace function public.platform_search(p_q text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_level text;
  v_q text := btrim(coalesce(p_q, ''));
  v_like text;
begin
  perform private.require_platform_staff();
  select a.level into v_level from private.platform_admins a where a.user_id = auth.uid() and a.revoked_at is null;
  if length(v_q) < 2 or length(v_q) > 80 then
    raise exception 'Type 2 to 80 characters.' using errcode = '22023';
  end if;
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return jsonb_build_object(
    'companies', coalesce((select jsonb_agg(to_jsonb(x) order by x.rank, x.name) from (
        select c.id, c.name, c.is_demo, c.active, private.company_stage(c.id) as stage,
               case when c.name ilike v_q || '%' then 0 else 1 end as rank
        from public.companies c
        where c.name ilike v_like and (v_level = 'admin' or c.active)
        order by 6, c.name limit 8) x), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
        select r.id, c.name as company, r.status, left(r.message, 140) as message, r.created_at
        from public.help_support_requests r join public.companies c on c.id = r.company_id
        where r.message ilike v_like or c.name ilike v_like
        order by r.created_at desc limit 8) x), '[]'::jsonb),
    'leads', case when v_level <> 'admin' then '[]'::jsonb else coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
        select l.id, l.name, l.company_name, l.status, l.disposition, l.created_at
        from private.leads l
        where l.name ilike v_like or l.email ilike v_like or l.company_name ilike v_like
        order by l.created_at desc limit 8) x), '[]'::jsonb) end,
    'prospects', case when v_level <> 'admin' then '[]'::jsonb else coalesce((select jsonb_agg(to_jsonb(x) order by x.company_name) from (
        select o.id, o.company_name, o.city, o.state, o.status
        from private.outreach_prospects o
        where o.company_name ilike v_like or o.contact_name ilike v_like or o.email ilike v_like or o.dot_number = v_q
        order by o.company_name limit 8) x), '[]'::jsonb) end,
    'team', case when v_level <> 'admin' then '[]'::jsonb else coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from (
        select a.user_id, coalesce(private.person_name(a.user_id), '') as name, p.email, a.level
        from private.platform_admins a join public.profiles p on p.id = a.user_id
        where a.revoked_at is null and (p.full_name ilike v_like or p.display_name ilike v_like or p.email ilike v_like)
        order by 2 limit 8) x), '[]'::jsonb) end);
end;
$$;
revoke all on function public.platform_search(text) from public, anon;
grant execute on function public.platform_search(text) to authenticated;

create or replace function public.platform_audit_search(p_actor uuid, p_action text, p_company uuid, p_from date, p_to date,
                                                        p_before bigint default null, p_limit integer default 100)
returns table (id bigint, occurred_at timestamptz, actor_id uuid, actor text, action text, target_type text, target_id text,
               summary text, company_id uuid, company text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_action text := nullif(btrim(coalesce(p_action, '')), '');
begin
  perform private.require_platform_admin();
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'The first day is after the last day.' using errcode = '22023';
  end if;
  return query
    select l.id, l.occurred_at, l.actor_id, coalesce(private.person_name(l.actor_id), 'Operator'), l.action, l.target_type, l.target_id,
           l.summary, c.id, c.name
    from private.platform_audit l
    left join public.companies c on c.id = case
        when l.target_type = 'company' and l.target_id ~ '^[0-9a-f-]{36}$' then l.target_id::uuid
        when l.detail ->> 'company_id' ~ '^[0-9a-f-]{36}$' then (l.detail ->> 'company_id')::uuid end
    where (p_actor is null or l.actor_id = p_actor)
      and (v_action is null or l.action = v_action)
      and (p_company is null or (l.target_type = 'company' and l.target_id = p_company::text) or l.detail ->> 'company_id' = p_company::text)
      and (p_from is null or l.occurred_at >= (p_from::timestamp at time zone 'America/Chicago'))
      and (p_to is null or l.occurred_at < ((p_to + 1)::timestamp at time zone 'America/Chicago'))
      and (p_before is null or l.id < p_before)
    order by l.id desc
    limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;
revoke all on function public.platform_audit_search(uuid, text, uuid, date, date, bigint, integer) from public, anon;
grant execute on function public.platform_audit_search(uuid, text, uuid, date, date, bigint, integer) to authenticated;

create or replace function public.platform_audit_facets()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'actions', coalesce((select jsonb_agg(jsonb_build_object('action', x.action, 'n', x.n) order by x.action)
                         from (select l.action, count(*) as n from private.platform_audit l group by l.action) x), '[]'::jsonb),
    'actors', coalesce((select jsonb_agg(jsonb_build_object('id', x.actor_id, 'name', x.name) order by x.name)
                        from (select d.actor_id, coalesce(private.person_name(d.actor_id), 'Operator') as name
                              from (select distinct l.actor_id from private.platform_audit l where l.actor_id is not null) d) x), '[]'::jsonb));
end;
$$;
revoke all on function public.platform_audit_facets() from public, anon;
grant execute on function public.platform_audit_facets() to authenticated;
