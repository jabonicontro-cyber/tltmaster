-- Reverses supabase/migrations/20261105000200_operational_workspaces.sql.
-- NOT a migration: run by hand, only after a backup and only if the founder asks.
-- Workspace scopes are deleted; operation conversations are converted to closed
-- groups so their messages and members stay readable.
begin;
drop trigger if exists comm_ops_assignments on public.dispatch_assignments;
drop trigger if exists comm_ops_loads on public.order_loads;
drop trigger if exists comm_ops_orders on public.orders;
drop trigger if exists comm_ops_tickets on public.delivery_tickets;
drop trigger if exists messages_operation_guard on public.messages;
drop function if exists public.comm_housekeeping();
drop function if exists private.comm_archive_finished(uuid);
drop function if exists private.comm_operation_can_archive(uuid);
drop function if exists public.comm_operation_reopen(uuid);
drop function if exists public.comm_operation_close(uuid, text);
drop function if exists public.comm_operation_resync(uuid);
drop function if exists public.comm_operation_update_scope(uuid, jsonb);
drop function if exists public.comm_create_operation(text, jsonb, uuid[]);
drop function if exists public.comm_operation_preview(jsonb);
drop function if exists private.comm_guard_operation_post();
drop function if exists private.comm_on_dispatch_change();
drop function if exists private.comm_workspaces_for_load(uuid);
drop function if exists private.comm_sync_safely(uuid, text);
drop function if exists private.comm_sync_operation(uuid, text);
drop function if exists private.comm_scope_drivers(uuid);
drop function if exists private.comm_scope_loads(uuid);
drop function if exists private.comm_scope_from(uuid, jsonb);
drop function if exists private.comm_site_key(text, text);
update public.conversations set kind = 'group', status = 'closed' where kind = 'operation';
drop table if exists public.comm_housekeeping_runs;
drop table if exists public.operation_workspaces;
commit;
