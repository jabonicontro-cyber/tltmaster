-- =============================================================================
-- Communications read speed (LR1 walkthrough, 2026-11-05).
--
-- 1. Alerts. The read policies of alerts, alert_recipients,
-- alert_acknowledgments and alert_events called private.alert_is_recipient(alert_id) for every row; each call looked
-- up the company and scanned alert_recipients again, so a person without comms.alerts (a driver) waited minutes for
-- Communications → Alerts once a company had a few thousand alerts. Same rule, evaluated once per query: the alert ids
-- the signed-in person is a recipient of, as an array, plus an index that finds them by person.
-- 2. Inbox. comm_inbox counted unread messages with private.comm_message_visible per message, which looks up the
--    company twice each time (about 7 s for a driver in 79 conversations). The same visibility rule is now applied
--    inline with the company, retention cut-off and legal hold read once.
-- Who can read what does not change.
-- Reversible: supabase/rollbacks/20261120007900_comm_read_speed.down.sql
-- =============================================================================

create index if not exists alert_recipients_user_idx on public.alert_recipients (user_id, company_id, alert_id);

-- The alerts the signed-in person is (or was) a recipient of in their current company.
create or replace function private.my_alert_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct r.alert_id), '{}'::uuid[])
  from public.alert_recipients r
  where r.user_id = auth.uid() and r.company_id = private.current_company_id()
$$;
revoke all on function private.my_alert_ids() from public, anon;
grant execute on function private.my_alert_ids() to authenticated;

alter policy alerts_read on public.alerts
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('comms.alerts')) or id = any ((select private.my_alert_ids())::uuid[])));
alter policy alert_recipients_read on public.alert_recipients
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('comms.alerts')) or alert_id = any ((select private.my_alert_ids())::uuid[])));
alter policy alert_acknowledgments_read on public.alert_acknowledgments
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('comms.alerts')) or alert_id = any ((select private.my_alert_ids())::uuid[])));
alter policy alert_events_read on public.alert_events
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('comms.alerts')) or alert_id = any ((select private.my_alert_ids())::uuid[])));

CREATE OR REPLACE FUNCTION public.comm_inbox()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid := private.require_company();
  -- private.comm_message_visible, evaluated once: messages newer than the retention cut-off unless a legal hold keeps
  -- them all, and only within the caller's own membership periods (pinned: while a current member).
  v_cutoff  timestamptz := case when private.comm_legal_hold(v_company) then '-infinity'::timestamptz else now() - private.comm_retention() end;
begin
  -- Receiving the list counts as delivery.
  update public.conversation_members set last_delivered_at = clock_timestamp()
  where company_id = v_company and user_id = auth.uid() and left_at is null;
  insert into public.user_presence (company_id, user_id, last_active_at) values (v_company, auth.uid(), now())
  on conflict (company_id, user_id) do update set last_active_at = now();
  return coalesce((
    select jsonb_agg(row_to_json(x)::jsonb order by x.last_activity desc nulls last)
    from (
      select c.id, c.kind, c.status, c.department,
             case when c.kind = 'direct' then (select private.comm_user_name(o.user_id) from public.conversation_members o
                                               where o.conversation_id = c.id and o.user_id <> auth.uid() order by o.joined_at limit 1)
                  when c.title_custom or c.kind = 'channel' or c.kind = 'operation' then c.title
                  else (select string_agg(private.comm_user_name(o.user_id), ', ' order by private.comm_user_name(o.user_id))
                        from (select distinct o2.user_id from public.conversation_members o2
                              where o2.conversation_id = c.id and o2.left_at is null and o2.user_id <> auth.uid()) o) end as title,
             (select o.user_id from public.conversation_members o where c.kind = 'direct' and o.conversation_id = c.id and o.user_id <> auth.uid() limit 1) as other_user_id,
             m.left_at is null as active_member,
             m.muted_until,
             greatest(c.last_message_at, c.created_at) as last_activity,
             (select count(*) from public.messages msg
              where msg.conversation_id = c.id and msg.author_id is distinct from auth.uid() and msg.deleted_at is null
                and msg.created_at > coalesce(m.last_read_at, '-infinity'::timestamptz)
                and msg.created_at > v_cutoff
                and exists (select 1 from public.conversation_members mv
                            where mv.conversation_id = c.id and mv.user_id = auth.uid() and mv.company_id = v_company
                              and ((msg.pinned and mv.left_at is null)
                                   or (mv.history_from <= msg.created_at and (mv.left_at is null or msg.created_at <= mv.left_at))))) as unread
      from public.conversations c
      join lateral (select * from public.conversation_members mm where mm.conversation_id = c.id and mm.user_id = auth.uid()
                    order by mm.left_at is null desc, mm.joined_at desc limit 1) m on true
      where c.company_id = v_company
    ) x
  ), '[]'::jsonb);
end;
$function$;
