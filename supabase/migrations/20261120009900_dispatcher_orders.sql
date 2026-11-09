-- =============================================================================
-- Dispatchers create orders (owner decision 2026-11-09, after a first-day dispatcher walkthrough could not enter an
-- urgent phoned-in order). `orders.edit` joins the dispatcher defaults for new companies and is granted to the
-- dispatcher role of every existing company. Owners can still take it away in Settings → Roles. Price overrides and
-- discounts stay behind `pricing.override`. Reversible: supabase/rollbacks/20261120009900_dispatcher_orders.down.sql
-- =============================================================================

insert into public.role_permission_defaults (role, permission) values ('dispatcher', 'orders.edit')
on conflict do nothing;

insert into public.role_permissions (company_id, role, permission)
select c.id, 'dispatcher', 'orders.edit' from public.companies c
on conflict do nothing;
