-- =============================================================================
-- "Who sends your invoices: Taviron or QuickBooks?" (owner decision 2026-11-14 to 11-17, master plan §12 INV1).
--
-- Until now a company that never chose was treated as QuickBooks (the column default), so a new company saw empty
-- QuickBooks screens in Billing without ever being asked. Now the choice is recorded:
--   * invoicing_settings.issuer_chosen_at / issuer_chosen_by: when and by whom the company chose. Empty = never chosen;
--     a company without a row has never chosen either. Getting started asks the question and the billing screens show
--     it until it is answered.
--   * Every existing row was saved on purpose (Settings → Invoicing) or by the demo samples: it counts as chosen, at the
--     time of that save. So companies that already chose keep their choice and are not asked.
--   * Top Line Trucking (the original company, slug top-line-trucking, not a demo) keeps its current setting: when it has
--     no row, one is written with QuickBooks (what it uses today, the default it runs on) and counted as chosen. Its
--     setting is never changed.
--   * A demo company's row counts as chosen when it is written (the demo samples choose Taviron), so demos never ask.
--   * public.invoicing_choose_issuer(issuer): records the choice (billing.manage, as the setting always needed); audited.
--   * public.invoicing_save_details(terms, footer): payment terms and footer on their own (Settings → Invoicing has one
--     Save per card); it never answers the question for the company.
--   * public.invoicing_save_settings (the earlier single Save) keeps working and counts as choosing.
-- Additive (two columns, two functions, one trigger; the earlier function keeps its signature). Works with the code
-- before it (which ignores the new columns) and after it.
-- Reversible: supabase/rollbacks/20261120024710_invoicing_choice.down.sql
-- =============================================================================

alter table public.invoicing_settings
  add column if not exists issuer_chosen_at timestamptz,
  add column if not exists issuer_chosen_by uuid references auth.users (id) on delete set null;

update public.invoicing_settings set issuer_chosen_at = updated_at, issuer_chosen_by = updated_by where issuer_chosen_at is null;

insert into public.invoicing_settings (company_id, issuer, terms_days, footer, updated_by, issuer_chosen_at)
select c.id, 'quickbooks', 30, '', null, now()
  from public.companies c
 where c.slug = 'top-line-trucking' and not c.is_demo
on conflict (company_id) do nothing;

-- A demo's invoicing row counts as chosen (the demo samples write Taviron); real companies choose themselves.
create or replace function private.invoicing_demo_chosen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.issuer_chosen_at is null and exists (select 1 from public.companies c where c.id = new.company_id and c.is_demo) then
    new.issuer_chosen_at := now();
  end if;
  return new;
end;
$$;

revoke all on function private.invoicing_demo_chosen() from public, anon, authenticated;

drop trigger if exists invoicing_demo_chosen on public.invoicing_settings;
create trigger invoicing_demo_chosen before insert on public.invoicing_settings
  for each row execute function private.invoicing_demo_chosen();

-- The answer to "Who sends your invoices?".
create or replace function public.invoicing_choose_issuer(p_issuer text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
begin
  perform private.require_permission('billing.manage');
  if p_issuer is null or p_issuer not in ('quickbooks', 'taviron') then
    raise exception 'Choose who sends your invoices: Taviron or QuickBooks.' using errcode = '22023';
  end if;
  insert into public.invoicing_settings (company_id, issuer, issuer_chosen_at, issuer_chosen_by)
  values (v_company, p_issuer, now(), auth.uid())
  on conflict (company_id) do update set issuer = excluded.issuer, issuer_chosen_at = now(), issuer_chosen_by = auth.uid(),
    updated_by = auth.uid(), updated_at = now();
  perform private.log_event('invoicing.issuer_chosen', 'company', v_company,
    format('Invoices are sent by %s', case p_issuer when 'taviron' then 'Taviron' else 'QuickBooks' end),
    jsonb_build_object('issuer', p_issuer));
end;
$$;

-- Payment terms and the invoice footer, without answering the question.
create or replace function public.invoicing_save_details(p_terms_days integer, p_footer text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_footer text := private.clean_text(p_footer, 500, 'Footer');
begin
  perform private.require_permission('billing.manage');
  if p_terms_days is null or p_terms_days not between 0 and 120 then
    raise exception 'Payment terms are 0 to 120 days.' using errcode = '22023';
  end if;
  insert into public.invoicing_settings (company_id, terms_days, footer) values (v_company, p_terms_days, v_footer)
  on conflict (company_id) do update set terms_days = excluded.terms_days, footer = excluded.footer,
    updated_by = auth.uid(), updated_at = now();
  perform private.log_event('invoicing.details', 'company', v_company, format('Invoice payment terms %s days', p_terms_days),
    jsonb_build_object('terms_days', p_terms_days));
end;
$$;

-- The earlier single Save (issuer, terms and footer together) counts as choosing.
create or replace function public.invoicing_save_settings(p_issuer text, p_terms_days integer, p_footer text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid := private.require_company();
  v_footer text := private.clean_text(p_footer, 500, 'Footer');
begin
  perform private.require_permission('billing.manage');
  if p_issuer not in ('quickbooks', 'taviron') then
    raise exception 'Choose who issues your invoices.' using errcode = '22023';
  end if;
  if p_terms_days is null or p_terms_days not between 0 and 120 then
    raise exception 'Payment terms are 0 to 120 days.' using errcode = '22023';
  end if;
  insert into public.invoicing_settings (company_id, issuer, terms_days, footer, issuer_chosen_at, issuer_chosen_by)
  values (v_company, p_issuer, p_terms_days, v_footer, now(), auth.uid())
  on conflict (company_id) do update set issuer = excluded.issuer, terms_days = excluded.terms_days, footer = excluded.footer,
    updated_by = auth.uid(), updated_at = now(),
    issuer_chosen_at = coalesce(public.invoicing_settings.issuer_chosen_at, now()),
    issuer_chosen_by = coalesce(public.invoicing_settings.issuer_chosen_by, auth.uid());
  perform private.log_event('invoicing.settings', 'company', v_company,
    format('Invoices are issued by %s; terms %s days', case p_issuer when 'taviron' then 'Taviron' else 'QuickBooks' end, p_terms_days),
    jsonb_build_object('issuer', p_issuer, 'terms_days', p_terms_days));
end;
$$;

revoke all on function public.invoicing_choose_issuer(text), public.invoicing_save_details(integer, text),
  public.invoicing_save_settings(text, integer, text) from public, anon;
grant execute on function public.invoicing_choose_issuer(text), public.invoicing_save_details(integer, text),
  public.invoicing_save_settings(text, integer, text) to authenticated;

notify pgrst, 'reload schema';

-- Verification
do $$
begin
  if exists (select 1 from public.invoicing_settings where issuer_chosen_at is null) then
    raise exception 'An existing invoicing row is not counted as chosen.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname, p.proname) in (('public', 'invoicing_choose_issuer'), ('public', 'invoicing_save_details'),
                                     ('public', 'invoicing_save_settings'), ('private', 'invoicing_demo_chosen'))
      and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']))
  then
    raise exception 'A new or changed function is not a pinned security definer function.';
  end if;
end;
$$;
