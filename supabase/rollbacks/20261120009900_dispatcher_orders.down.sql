-- Rollback of 20261120009900_dispatcher_orders: dispatchers no longer create or edit orders by default. This also takes
-- orders.edit from dispatchers in companies that granted it by hand after the migration (it cannot tell them apart).
begin;
delete from public.role_permissions where role = 'dispatcher' and permission = 'orders.edit';
delete from public.role_permission_defaults where role = 'dispatcher' and permission = 'orders.edit';
commit;
