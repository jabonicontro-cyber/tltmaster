-- Rollback of 20261114000400_company_owner_person.sql (not a migration). Restores the previous wrapper; person
-- records already created stay.
begin;
CREATE OR REPLACE FUNCTION public.create_company_with_access_code(p_code_hash text, p_company_name text, p_request_key uuid, p_timezone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tz     text := private.valid_timezone(p_timezone);
  v_result jsonb := public.create_company_with_access_code(p_code_hash, p_company_name, p_request_key);
begin
  if coalesce((v_result ->> 'created')::boolean, false) then
    update public.company_settings set timezone = v_tz where company_id = (v_result ->> 'company_id')::uuid;
  end if;
  return v_result;
end;
$function$

;
commit;
