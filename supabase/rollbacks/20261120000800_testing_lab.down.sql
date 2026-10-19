-- Rollback of 20261120000800_testing_lab: removes portal previews and the Testing Lab checklist, and restores
-- private.portal_me to its 20261120000700 definition (real customer accounts only).
drop function if exists public.platform_testing_demo(uuid);
drop function if exists public.platform_testing_record(text, uuid, text, text);
drop function if exists public.platform_testing_checks();
drop table if exists private.testing_lab_checks;
drop function if exists public.portal_preview_state(text);
drop function if exists public.platform_portal_preview_stop();
drop function if exists public.platform_portal_preview_start(uuid, uuid);

create or replace function private.portal_me(p_slug text)
 returns public.portal_accounts
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v public.portal_accounts%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not available.' using errcode = '42501';
  end if;
  select a.* into v
  from public.portal_accounts a join public.companies c on c.id = a.company_id
  where c.slug = p_slug and a.user_id = auth.uid() and a.status = 'active'
    and exists (select 1 from public.customers cu where cu.company_id = a.company_id and cu.id = a.customer_id and cu.active);
  if not found or not private.portal_open(v.company_id) then
    raise exception 'Not available.' using errcode = '42501';
  end if;
  return v;
end;
$$;
revoke all on function private.portal_me(text) from public, anon, authenticated;

drop function if exists private.portal_preview_account(uuid, uuid);
drop table if exists private.portal_previews;
