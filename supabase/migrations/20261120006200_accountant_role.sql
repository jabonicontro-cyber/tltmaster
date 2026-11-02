-- B134 accountant view (owner 2026-11-02): an outside accountant's role. Kept in its own migration: a new enum value
-- cannot be used in the same transaction that adds it (as 20261011000100_mechanic_role).
alter type public.app_role add value if not exists 'accountant';
