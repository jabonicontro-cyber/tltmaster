-- =============================================================================
-- Employee avatars: an employee record may show one of Taviron's illustrated
-- avatars (public/avatars/avatar-01 … avatar-20, trucking and aggregate-hauling
-- professionals). Useful for people without a Taviron login, who cannot upload
-- a photo themselves. A person's own uploaded or chosen photo (profile) still
-- takes precedence where they have a login. Set by employees.edit (existing
-- update policy). Additive.
-- Rollback: supabase/rollbacks/20261031000300_employee_avatars.down.sql
-- =============================================================================
alter table public.employees
  add column avatar_key text not null default ''
    check (avatar_key = '' or avatar_key ~ '^avatar-[0-9]{2}$');
