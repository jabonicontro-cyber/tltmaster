-- Rollback for 20261120004500_parts_inventory.sql: functions, the movement ledger and the parts list. Part cost lines
-- already added to work orders stay (they are ordinary work order costs).
drop function if exists public.demo_parts_samples();
drop function if exists public.part_costs();
drop function if exists public.part_use(uuid, uuid, numeric);
drop function if exists public.part_count(uuid, numeric, text);
drop function if exists public.part_receive(uuid, numeric, bigint, text);
drop function if exists public.part_save(uuid, jsonb);
drop function if exists private.part_for_change(uuid);
drop table if exists public.part_movements;
drop table if exists public.parts;
