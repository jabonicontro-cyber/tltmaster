-- =============================================================================
-- Ask for the PO when a quote is accepted for a customer marked "PO required" (owner decision 2026-11-14 to 11-17,
-- master plan §12 BL1). A warning, never a block: the quote can be accepted without one.
--
-- public.quote_accept(quote, note, customer_po) accepts the quote exactly as set_quote_status does (quotes.status, the
-- same transitions, history and audit) and, when a PO is given and the accepted revision has none yet, first records it
-- on that revision. The order made on acceptance (Orders on) copies the revision's PO as it always has; with Orders off
-- (Quotes only) the won quote keeps it on its accepted revision, where the quote page shows it.
--
-- An issued revision cannot change (private.guard_locked_version). It now lets exactly one change through: an empty
-- customer PO filled in, nothing else, and only inside quote_accept, which marks that one revision for the transaction.
-- The PO is the customer's reference number, not a price; the change is recorded in the history.
--
-- Additive (one function; the guard gains one narrow case). Works with the code before and after it.
-- Reversible: supabase/rollbacks/20261120024730_quote_accept_po.down.sql
-- =============================================================================

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

  -- The customer's PO, given when the quote is accepted (owner decision 2026-11-17, BL1): only inside public.quote_accept
  -- (which sets this mark for this version alone), only when the version had none, and nothing else changes.
  if old.customer_po = '' and new.customer_po <> ''
     and coalesce(current_setting('taviron.quote_accept_po', true), '') = old.id::text
     and (to_jsonb(new) - 'customer_po' - 'updated_at') = (to_jsonb(old) - 'customer_po' - 'updated_at') then
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

create or replace function public.quote_accept(p_quote_id uuid, p_note text, p_customer_po text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po text := private.clean_text(coalesce(p_customer_po, ''), 100, 'PO number');
  v_quote public.quotes%rowtype;
  v_version public.quote_versions%rowtype;
begin
  perform private.require_permission('quotes.status');
  select * into v_quote from public.quotes where id = p_quote_id and company_id = private.require_company() for update;
  if not found then raise exception 'Quote not found.'; end if;
  if length(v_po) > 0 and v_quote.status <> 'accepted' then
    select * into v_version from public.quote_versions where id = v_quote.current_version_id and company_id = v_quote.company_id for update;
    if found and v_version.customer_po = '' then
      perform set_config('taviron.quote_accept_po', v_version.id::text, true);
      update public.quote_versions set customer_po = v_po where id = v_version.id;
      perform set_config('taviron.quote_accept_po', '', true);
      perform private.log_event('quote.po_added', 'quote', v_quote.id,
        format('%s: customer PO %s given on acceptance', v_quote.quote_number, v_po), jsonb_build_object('version_id', v_version.id, 'customer_po', v_po));
    end if;
  end if;
  return public.set_quote_status(p_quote_id, 'accepted', p_note);
end;
$$;

revoke all on function public.quote_accept(uuid, text, text) from public, anon;
grant execute on function public.quote_accept(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';

-- Verification
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'quote_accept' and p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']) then
    raise exception 'quote_accept is not a pinned security definer function.';
  end if;
  if (select prosrc from pg_proc where oid = 'private.guard_locked_version()'::regprocedure) not like '%taviron.quote_accept_po%' then
    raise exception 'The issued-revision guard was not updated.';
  end if;
end;
$$;
