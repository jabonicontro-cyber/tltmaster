-- Security overview for Taviron Admins (PC1, owner 2026-11-12). public.platform_security_overview(): counts for the
-- last 24 hours and 7 days of failed sign-ins (private.signin_failures), authenticator code attempts
-- (private.mfa_attempts), access-code attempts (private.access_attempts, by kind) and security events
-- (private.security_events, by event), plus the 25 latest security events with the person's name and whether they are
-- on the Taviron team. Never returned: login or key hashes, event details, codes, addresses or anything secret.
-- Admins only; reads only. Reversible: supabase/rollbacks/20261120020700_security_overview.down.sql.

create or replace function public.platform_security_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'as_of', now(),
    'signin_failures', (select jsonb_build_object('day', count(*) filter (where f.at > now() - interval '24 hours'), 'week', count(*),
                                                  'logins_week', count(distinct f.login_hash))
                        from private.signin_failures f where f.at > now() - interval '7 days'),
    'mfa', (select jsonb_build_object('failed_day', count(*) filter (where not m.ok and m.at > now() - interval '24 hours'),
                                      'failed_week', count(*) filter (where not m.ok), 'ok_week', count(*) filter (where m.ok),
                                      'people_failed_week', count(distinct m.user_id) filter (where not m.ok))
            from private.mfa_attempts m where m.at > now() - interval '7 days'),
    'access', coalesce((select jsonb_agg(jsonb_build_object('scope', x.scope, 'failed_day', x.failed_day, 'failed_week', x.failed_week, 'ok_week', x.ok_week) order by x.scope)
                        from (select a.scope, count(*) filter (where not a.success and a.created_at > now() - interval '24 hours') as failed_day,
                                     count(*) filter (where not a.success) as failed_week, count(*) filter (where a.success) as ok_week
                              from private.access_attempts a where a.created_at > now() - interval '7 days' group by a.scope) x), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('event', x.event, 'n', x.n) order by x.n desc, x.event)
                        from (select e.event, count(*) as n from private.security_events e where e.at > now() - interval '7 days' group by e.event) x), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(to_jsonb(x) order by x.at desc) from (
                         select e.event, e.at, coalesce(private.person_name(e.user_id), 'Unknown person') as person,
                                exists (select 1 from private.platform_admins a where a.user_id = e.user_id and a.revoked_at is null) as staff
                         from private.security_events e order by e.at desc limit 25) x), '[]'::jsonb));
end;
$$;
revoke all on function public.platform_security_overview() from public, anon;
grant execute on function public.platform_security_overview() to authenticated;
