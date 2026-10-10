-- Adds the mechanic role. Kept in its own migration: a new enum value cannot
-- be used in the same transaction that adds it. Mechanics get no permissions
-- until the fleet-maintenance features exist.
alter type public.app_role add value if not exists 'mechanic';
