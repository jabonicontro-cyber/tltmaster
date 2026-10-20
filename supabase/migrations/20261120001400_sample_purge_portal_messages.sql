-- =============================================================================
-- Remove sample data after the customer portal was used (fixes an interaction found by the DB suite, 2026-10-20).
--
-- public.remove_sample_data deletes sample customers; their customer-portal support threads go with them, but
-- portal_messages is append-only (20261120000700), so the removal failed. Like the other append-only histories, the
-- messages may now be deleted only while sample removal runs (tlt.sample_purge = on, set by remove_sample_data for
-- sample records only). Everything else is unchanged: outside sample removal they are still never changed or deleted.
-- Rollback: supabase/rollbacks/20261120001400_sample_purge_portal_messages.down.sql
-- =============================================================================

CREATE OR REPLACE FUNCTION private.prevent_modification()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE'
     and current_setting('tlt.sample_purge', true) = 'on'
     and tg_table_name in ('quote_status_events', 'email_deliveries', 'documents', 'order_status_events',
                           'delivery_ticket_events', 'billing_reviews', 'portal_messages') then
    return old;
  end if;
  raise exception '% rows are append-only and cannot be changed or deleted.', tg_table_name
    using errcode = '42501';
end;
$function$;
