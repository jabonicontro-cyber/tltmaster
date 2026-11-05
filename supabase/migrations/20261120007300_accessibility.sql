-- Accessibility mode (owner 2026-11-05): larger text, high contrast, reduce motion and an easier-to-read font, saved
-- with the person's account so they apply on every device. App and customer portal only (not the public website).
-- Personal, not business data (like profiles): one row per signed-in person (staff and portal accounts alike, which is
-- why it is not on profiles: portal accounts have none), readable only by that person, written only through
-- set_my_accessibility, which accepts the four known settings and nothing else.
-- Reversible: supabase/rollbacks/20261120007300_accessibility.down.sql.

create table public.user_accessibility (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  settings   jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  updated_at timestamptz not null default now()
);
alter table public.user_accessibility enable row level security;
revoke all on public.user_accessibility from anon, authenticated;
grant select on public.user_accessibility to authenticated;
create policy user_accessibility_own on public.user_accessibility for select to authenticated
  using (user_id = (select auth.uid()));

-- Save the signed-in person's settings. textSize: 100, 115 or 130 (per cent); the others true or false.
create or replace function public.set_my_accessibility(p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_size integer;
  v jsonb;
begin
  if v_user is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'Settings could not be read.' using errcode = '22023';
  end if;
  v_size := coalesce((p_settings ->> 'textSize')::integer, 100);
  if v_size not in (100, 115, 130) then
    raise exception 'Text size is 100%%, 115%% or 130%%.' using errcode = '22023';
  end if;
  v := jsonb_build_object(
    'textSize', v_size,
    'highContrast', coalesce((p_settings ->> 'highContrast')::boolean, false),
    'reduceMotion', coalesce((p_settings ->> 'reduceMotion')::boolean, false),
    'readableFont', coalesce((p_settings ->> 'readableFont')::boolean, false));
  insert into public.user_accessibility (user_id, settings, updated_at) values (v_user, v, now())
  on conflict (user_id) do update set settings = excluded.settings, updated_at = now();
  return v;
end;
$$;
revoke all on function public.set_my_accessibility(jsonb) from public, anon;
grant execute on function public.set_my_accessibility(jsonb) to authenticated;
