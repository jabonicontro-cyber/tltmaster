-- =============================================================================
-- Profile self-service: preferred display name, phone and profile photo
--
-- Every signed-in person may change exactly three things about themselves:
-- the name they are greeted and shown by (display_name, falls back to
-- full_name), a phone number, and a profile photo. Nothing else: the full
-- name an administrator entered, email, company memberships, roles,
-- permissions and employment status stay under the company's control
-- (set_user_access, Settings → Users).
--
-- Photos are small, already-resized images (the browser scales them to
-- 256 px before upload; the server re-checks type and size). They live in a
-- private table that no client can read directly; public.profile_photo()
-- returns one only to its owner or to people in the owner's *current*
-- company, so photos never cross companies. No Supabase Storage bucket is
-- needed.
--
-- Additive. Rollback: supabase/rollbacks/20261030000100_profile_self_service.down.sql
-- =============================================================================

alter table public.profiles
  add column display_name text not null default ''
    check (length(display_name) <= 60 and display_name = trim(display_name)),
  add column phone text not null default ''
    check (length(phone) <= 25 and phone ~ '^[0-9+()./ -]*$'),
  add column photo_updated_at timestamptz;

create table private.profile_photos (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  mime_type  text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  data       bytea not null check (octet_length(data) between 1 and 204800),
  updated_at timestamptz not null default now()
);
revoke all on private.profile_photos from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- The caller's own editable fields (and photo version), for the profile page
-- and the app shell.
-- -----------------------------------------------------------------------------
create or replace function public.my_profile()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', p.id, 'email', p.email, 'full_name', p.full_name,
    'display_name', p.display_name, 'phone', p.phone,
    'photo_updated_at', p.photo_updated_at)
  from public.profiles p
  where p.id = auth.uid()
$$;

/** Change the caller's own display name and phone — nothing else. */
create or replace function public.update_my_profile(p_display_name text, p_phone text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_name  text := regexp_replace(trim(coalesce(p_display_name, '')), '\s+', ' ', 'g');
  v_phone text := trim(coalesce(p_phone, ''));
begin
  if v_me is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if length(v_name) > 60 then raise exception 'Use at most 60 characters for your name.' using errcode = '22023'; end if;
  if v_name ~ '[[:cntrl:]<>]' then raise exception 'Your name contains characters that are not allowed.' using errcode = '22023'; end if;
  if length(v_phone) > 25 or v_phone !~ '^[0-9+()./ -]*$' then
    raise exception 'Enter the phone number with digits, spaces and + ( ) - . only.' using errcode = '22023';
  end if;
  update public.profiles set display_name = v_name, phone = v_phone where id = v_me;
end;
$$;

/** Set (or with null data, remove) the caller's own photo. */
create or replace function public.set_my_photo(p_mime_type text, p_data_base64 text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := auth.uid();
  v_bytes bytea;
  v_now   timestamptz := now();
begin
  if v_me is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if p_data_base64 is null or p_data_base64 = '' then
    delete from private.profile_photos where user_id = v_me;
    update public.profiles set photo_updated_at = null where id = v_me;
    return null;
  end if;
  if p_mime_type not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'Use a JPEG, PNG or WebP image.' using errcode = '22023';
  end if;
  begin
    v_bytes := decode(p_data_base64, 'base64');
  exception when others then
    raise exception 'The image could not be read.' using errcode = '22023';
  end;
  if octet_length(v_bytes) > 204800 then raise exception 'The image is too large (200 KB at most).' using errcode = '22023'; end if;
  -- The bytes must match the stated type (magic numbers), whatever the browser claimed.
  if not (
    (p_mime_type = 'image/jpeg' and substr(v_bytes, 1, 3) = '\xffd8ff'::bytea)
    or (p_mime_type = 'image/png' and substr(v_bytes, 1, 8) = '\x89504e470d0a1a0a'::bytea)
    or (p_mime_type = 'image/webp' and substr(v_bytes, 1, 4) = '\x52494646'::bytea and substr(v_bytes, 9, 4) = '\x57454250'::bytea)
  ) then
    raise exception 'The file is not a valid JPEG, PNG or WebP image.' using errcode = '22023';
  end if;
  insert into private.profile_photos (user_id, mime_type, data, updated_at)
  values (v_me, p_mime_type, v_bytes, v_now)
  on conflict (user_id) do update set mime_type = excluded.mime_type, data = excluded.data, updated_at = excluded.updated_at;
  update public.profiles set photo_updated_at = v_now where id = v_me;
  return v_now;
end;
$$;

/**
 * One person's photo, for the caller only when it is their own or the person
 * belongs to the caller's current company. Otherwise (or without a photo): no row.
 */
create or replace function public.profile_photo(p_user_id uuid)
returns table (mime_type text, data_base64 text, updated_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select ph.mime_type, translate(encode(ph.data, 'base64'), E'\n', ''), ph.updated_at
  from private.profile_photos ph
  where ph.user_id = p_user_id
    and auth.uid() is not null
    and (p_user_id = auth.uid() or private.is_company_member(p_user_id))
$$;

revoke execute on function public.my_profile(), public.update_my_profile(text, text),
  public.set_my_photo(text, text), public.profile_photo(uuid) from public, anon;
grant execute on function public.my_profile(), public.update_my_profile(text, text),
  public.set_my_photo(text, text), public.profile_photo(uuid) to authenticated;
