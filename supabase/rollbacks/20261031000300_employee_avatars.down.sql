-- Reverses supabase/migrations/20261031000300_employee_avatars.sql (chosen avatars are lost).
-- NOT a migration: run by hand, only after a backup and only if the founder asks.
alter table public.employees drop column if exists avatar_key;
