-- Rollback of 20261120024730_quote_accept_po (BL1). Run with psql -v ON_ERROR_STOP=1 -1 -f.
--   * The issued-revision guard is restored as it was (no change to an issued revision at all).
--   * public.quote_accept goes; the app then accepts quotes with set_quote_status and asks for no PO.
--   * POs already recorded on acceptance stay on their revisions (they are the customer's numbers).
begin;

CREATE OR REPLACE FUNCTION private.guard_locked_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_old jsonb;
  v_new jsonb;
  v_allowed constant text[] := array['sent_at', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    -- tlt.sample_purge is only set inside public.remove_sample_data(), which
    -- deletes nothing but sample quotes.
    if old.locked_at is not null and current_setting('tlt.sample_purge', true) is distinct from 'on' then
      raise exception 'Quote % version % has been issued and cannot be deleted.', old.quote_id, old.version_no
        using errcode = '42501';
    end if;
    return old;
  end if;

  if old.locked_at is null then
    return new;
  end if;

  if new.locked_at is null and current_setting('tlt.allow_version_unlock', true) = 'on' and old.sent_at is null then
    return new;
  end if;

  if new.locked_at is not null and private.demo_timing_allowed(old.company_id)
     and (to_jsonb(new) - 'sent_at' - 'locked_at' - 'updated_at') = (to_jsonb(old) - 'sent_at' - 'locked_at' - 'updated_at') then
    return new;
  end if;

  v_old := to_jsonb(old) - v_allowed;
  v_new := to_jsonb(new) - v_allowed;
  if v_old <> v_new then
    raise exception 'This quote version has been issued and cannot be changed. Create a revision instead.'
      using errcode = '42501';
  end if;
  if old.sent_at is not null and new.sent_at is distinct from old.sent_at then
    raise exception 'The sent time of an issued version cannot be changed.' using errcode = '42501';
  end if;
  return new;
end;
$function$;

drop function if exists public.quote_accept(uuid, text, text);

notify pgrst, 'reload schema';

commit;
