-- Names of staff accounts, so history and audit views can show who did what
-- without granting read access to the full profiles table.
create or replace function public.user_directory()
returns table (id uuid, full_name text, email text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.full_name, p.email
  from public.profiles p
  where private.current_app_role() is not null
$$;

revoke execute on function public.user_directory() from public, anon;
grant execute on function public.user_directory() to authenticated;
