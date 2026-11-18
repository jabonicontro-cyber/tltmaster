-- Rollback of 20261120024710_invoicing_choice (INV1). Run with psql -v ON_ERROR_STOP=1 -1 -f.
--   * The earlier single Save is restored as it was; the choice and details functions and the demo trigger go.
--   * The two "chosen" columns go: a company that never chose is treated as QuickBooks again, as before.
--   * A row written for Top Line keeps QuickBooks, which is what it used before (nothing to undo).
begin;

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
  insert into public.invoicing_settings (company_id, issuer, terms_days, footer) values (v_company, p_issuer, p_terms_days, v_footer)
  on conflict (company_id) do update set issuer = excluded.issuer, terms_days = excluded.terms_days, footer = excluded.footer,
    updated_by = auth.uid(), updated_at = now();
  perform private.log_event('invoicing.settings', 'company', v_company,
    format('Invoices are issued by %s; terms %s days', case p_issuer when 'taviron' then 'Taviron' else 'QuickBooks' end, p_terms_days),
    jsonb_build_object('issuer', p_issuer, 'terms_days', p_terms_days));
end;
$$;

drop function if exists public.invoicing_choose_issuer(text);
drop function if exists public.invoicing_save_details(integer, text);
drop trigger if exists invoicing_demo_chosen on public.invoicing_settings;
drop function if exists private.invoicing_demo_chosen();
alter table public.invoicing_settings drop column if exists issuer_chosen_at, drop column if exists issuer_chosen_by;

notify pgrst, 'reload schema';

commit;
