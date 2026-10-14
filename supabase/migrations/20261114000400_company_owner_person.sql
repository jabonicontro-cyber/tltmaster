-- Every sign-in is a person (owner 2026-10-14): the customer who creates a company in onboarding also gets their own
-- person record in it (name and email from the profile; username sign-in addresses are not contact addresses).
-- Same function, same arguments and result; only the person record is added when the company was created.

create or replace function public.create_company_with_access_code(p_code_hash text, p_company_name text, p_request_key uuid, p_timezone text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_tz      text := private.valid_timezone(p_timezone);
  v_result  jsonb := public.create_company_with_access_code(p_code_hash, p_company_name, p_request_key);
  v_company uuid;
begin
  if coalesce((v_result ->> 'created')::boolean, false) then
    v_company := (v_result ->> 'company_id')::uuid;
    update public.company_settings set timezone = v_tz where company_id = v_company;
    insert into public.employees (company_id, user_id, full_name, department, status, work_email)
    select v_company, p.id,
           left(coalesce(nullif(trim(p.full_name), ''), nullif(split_part(p.email, '@', 1), ''), 'Owner'), 120),
           'management', 'active',
           case when lower(p.email) like '%@users.mytaviron.com' then '' else left(coalesce(p.email, ''), 200) end
    from public.profiles p
    where p.id = auth.uid()
      and exists (select 1 from public.company_memberships m where m.company_id = v_company and m.user_id = p.id)
      and not exists (select 1 from public.employees e where e.company_id = v_company and e.user_id = p.id);
  end if;
  return v_result;
end;
$function$;
