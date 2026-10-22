-- Recreates the parts of the Supabase Postgres image this application relies
-- on, for use with a plain PostgreSQL 15+ server (CI, environments without
-- Docker). Not used with the Supabase CLI or a hosted Supabase project.
-- Passwords are local-development placeholders.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login password 'dev-authenticator' noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin login password 'dev-auth-admin' noinherit createrole;
  end if;
end
$$;

grant anon, authenticated, service_role to authenticator;

create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role, postgres;
alter role supabase_auth_admin set search_path = auth;
grant create on database postgres to supabase_auth_admin;

create schema if not exists extensions;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase grants broad default privileges on the public schema and relies
-- on RLS. Mirror that here so tests prove our explicit revokes and policies
-- are what actually protect data. Like a new hosted project, only on a schema
-- no migration has run on yet: this file also runs on every `stack.sh up`, and
-- re-granting then would undo migrations that narrow the defaults
-- (20261120002200).
do $$
begin
  if to_regclass('public.companies') is null then
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  end if;
end
$$;
