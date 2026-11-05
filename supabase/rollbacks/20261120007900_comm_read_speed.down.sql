-- Rollback of 20261120007900_comm_read_speed.sql: the per-row checks come back (same access, slower).
alter policy alerts_read on public.alerts
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('comms.alerts')) or private.alert_is_recipient(id)));
alter policy alert_recipients_read on public.alert_recipients
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('comms.alerts')) or private.alert_is_recipient(alert_id)));
alter policy alert_acknowledgments_read on public.alert_acknowledgments
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('comms.alerts')) or private.alert_is_recipient(alert_id)));
alter policy alert_events_read on public.alert_events
  using (company_id = (select private.current_company_id())
         and ((select private.has_permission('comms.alerts')) or private.alert_is_recipient(alert_id)));
drop function if exists private.my_alert_ids();
drop index if exists public.alert_recipients_user_idx;

-- The inbox as it was (20261105000100).
CREATE OR REPLACE FUNCTION public.comm_inbox()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_company uuid := private.require_company();
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
                and private.comm_message_visible(c.id, msg.created_at, msg.pinned)) as unread
      from public.conversations c
      join lateral (select * from public.conversation_members mm where mm.conversation_id = c.id and mm.user_id = auth.uid()
                    order by mm.left_at is null desc, mm.joined_at desc limit 1) m on true
      where c.company_id = v_company
    ) x
  ), '[]'::jsonb);
end;
$function$;
