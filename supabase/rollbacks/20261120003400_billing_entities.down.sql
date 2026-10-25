-- Rollback of 20261120003400_billing_entities.sql (not a migration; run by hand with a backup first; roll back
-- 20261120003500_quickbooks first). Handoff snapshots keep the business names they were stamped with.
begin;
drop trigger if exists billing_handoff_orders_stamp_entities on public.billing_handoff_orders;
drop function if exists private.billing_handoff_stamp_entities();
drop function if exists private.billing_entity_for(uuid, text);
drop function if exists public.billing_entity_rules_save(jsonb);
drop function if exists public.billing_entity_save(uuid, jsonb);
drop table if exists public.billing_entity_rules;
drop table if exists public.billing_entities;
commit;
