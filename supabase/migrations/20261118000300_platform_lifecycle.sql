-- =============================================================================
-- Platform owner console: customer lifecycle (2026-10-18, master plan B53; owner directive "Platform owner console,
-- customer lifecycle & billing").
--
-- 1. private.platform_plan_versions: the plan catalog, versioned. Version 1 is the founder's tiers (master plan §5.1,
--    the same numbers as src/lib/site/pricing.ts). A price change is a new version with its own first day; versions
--    already chosen by a company never change.
-- 2. private.company_lifecycle: one row per customer company — plan version, terms (monthly / annual commitment),
--    offer (standard / founding / free beta), the agreed monthly amount, the onboarding fee (due / paid / waived) and the
--    stage: fee_due → onboarding → live (→ canceled).
--    - Go-live date: set once while onboarding, afterwards only moved EARLIER (never later), never in the past.
--    - Go Live Now: needs a password sign-in by the platform admin in the last 5 minutes (auth.users.last_sign_in_at,
--      set by the server action's re-authentication). Idempotent.
--    - Scheduled activation: private.lifecycle_activate_due() makes companies live on their go-live day (company time
--      zone). Idempotent; called by the console and by the daily cron route (service role only).
--    - Cancellation of an annual commitment states the remaining balance (full months left × agreed monthly amount);
--      the operator confirms that exact amount. Nothing is charged or invoiced here.
-- 3. private.platform_attention_acks: "acknowledged" on a needs-attention item — seen and owned, NOT resolved. An item
--    is resolved only when its cause is gone; a new occurrence after the acknowledgement shows as unacknowledged.
-- 4. public.platform_console(): the four fixed KPIs (customer companies, MRR, pipeline, onboarding) and acknowledgements.
--
-- No payment provider is connected: there is no checkout, card, invoice, webhook or charge here. Payment states
-- (grace period, restricted access) need the owner's provider decision and stay unbuilt (docs/PLATFORM_LIFECYCLE.md).
-- Founding-customer terms live only in this private platform data, never in public site code.
-- Rollback: supabase/rollbacks/20261118000300_platform_lifecycle.down.sql
-- =============================================================================

create table private.platform_plan_versions (
  id               uuid primary key default gen_random_uuid(),
  plan_key         text not null check (plan_key in ('essential', 'growth', 'professional', 'enterprise', 'custom')),
  name             text not null check (length(name) between 1 and 60),
  version          integer not null check (version > 0),
  monthly_cents    integer check (monthly_cents >= 0),
  onboarding_cents integer check (onboarding_cents >= 0),
  from_price       boolean not null default false,
  trucks           integer check (trucks > 0),
  bases            integer check (bases > 0),
  effective_from   date not null,
  note             text not null default '' check (length(note) <= 500),
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (plan_key, version),
  check (plan_key = 'custom' or (monthly_cents is not null and onboarding_cents is not null))
);
alter table private.platform_plan_versions enable row level security;

insert into private.platform_plan_versions (plan_key, name, version, monthly_cents, onboarding_cents, from_price, trucks, bases, effective_from, note) values
  ('essential', 'Essential', 1, 49900, 19900, false, 25, 1, '2026-10-11', 'Founder''s tiers, master plan §5.1'),
  ('growth', 'Growth', 1, 74900, 29900, false, 50, 2, '2026-10-11', 'Founder''s tiers, master plan §5.1'),
  ('professional', 'Professional', 1, 99900, 39900, false, 75, 3, '2026-10-11', 'Founder''s tiers, master plan §5.1'),
  ('enterprise', 'Enterprise', 1, 149900, 59900, true, 100, 5, '2026-10-11', 'Founder''s tiers, master plan §5.1 (from price)'),
  ('custom', 'Custom', 1, null, null, false, null, null, '2026-10-11', 'Quoted per company');

create table private.company_lifecycle (
  company_id            uuid primary key references public.companies (id) on delete cascade,
  stage                 text not null default 'fee_due' check (stage in ('fee_due', 'onboarding', 'live', 'canceled')),
  plan_version_id       uuid references private.platform_plan_versions (id),
  terms                 text not null default 'monthly' check (terms in ('monthly', 'annual')),
  offer                 text not null default 'standard' check (offer in ('standard', 'founding', 'free_beta')),
  agreed_monthly_cents  integer check (agreed_monthly_cents >= 0),
  onboarding_fee_cents  integer check (onboarding_fee_cents >= 0),
  onboarding_fee_status text not null default 'due' check (onboarding_fee_status in ('due', 'paid', 'waived')),
  onboarding_fee_note   text not null default '' check (length(onboarding_fee_note) <= 300),
  go_live_on            date,
  live_at               timestamptz,
  commitment_start      date,
  canceled_at           timestamptz,
  cancel_reason         text not null default '' check (length(cancel_reason) <= 500),
  cancel_balance_cents  integer,
  notes                 text not null default '' check (length(notes) <= 2000),
  updated_by            uuid references auth.users (id) on delete set null,
  updated_at            timestamptz not null default now(),
  check (stage <> 'live' or live_at is not null)
);
alter table private.company_lifecycle enable row level security;

create table private.platform_attention_acks (
  item_key        text primary key check (length(item_key) between 3 and 200),
  acknowledged_by uuid references auth.users (id) on delete set null,
  acknowledged_at timestamptz not null default clock_timestamp(),
  note            text not null default '' check (length(note) <= 300)
);
alter table private.platform_attention_acks enable row level security;

-- The company's own calendar day (go-live dates are the company's days).
create or replace function private.company_today(p_company uuid)
 returns date
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select (now() at time zone coalesce((select s.timezone from public.company_settings s where s.company_id = p_company), 'UTC'))::date;
$$;
revoke all on function private.company_today(uuid) from public, anon, authenticated;

-- Remaining full months of a 12-month commitment that started on p_start, as of p_today.
create or replace function private.commitment_months_left(p_start date, p_today date)
 returns integer
 language sql
 immutable
 set search_path to ''
as $$
  select greatest(0, 12 - ((extract(year from age(p_today, p_start)) * 12 + extract(month from age(p_today, p_start)))::integer) - 1);
$$;

create or replace function private.lifecycle_json(p_company uuid)
 returns jsonb
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select case when l.company_id is null then null else jsonb_build_object(
    'stage', l.stage, 'terms', l.terms, 'offer', l.offer, 'agreed_monthly_cents', l.agreed_monthly_cents,
    'onboarding_fee_cents', l.onboarding_fee_cents, 'onboarding_fee_status', l.onboarding_fee_status, 'onboarding_fee_note', l.onboarding_fee_note,
    'go_live_on', l.go_live_on, 'live_at', l.live_at, 'commitment_start', l.commitment_start,
    'canceled_at', l.canceled_at, 'cancel_reason', l.cancel_reason, 'cancel_balance_cents', l.cancel_balance_cents,
    'notes', l.notes, 'updated_at', l.updated_at, 'today', private.company_today(p_company),
    'commitment_months_left', case when l.terms = 'annual' and l.commitment_start is not null and l.stage = 'live'
                                   then private.commitment_months_left(l.commitment_start, private.company_today(p_company)) end,
    'plan', (select jsonb_build_object('id', v.id, 'plan_key', v.plan_key, 'name', v.name, 'version', v.version, 'monthly_cents', v.monthly_cents,
                                       'onboarding_cents', v.onboarding_cents, 'from_price', v.from_price)
             from private.platform_plan_versions v where v.id = l.plan_version_id)) end
  from (select 1) x left join private.company_lifecycle l on l.company_id = p_company;
$$;
revoke all on function private.lifecycle_json(uuid) from public, anon, authenticated;

create or replace function private.lifecycle_for_update(p_company uuid)
 returns private.company_lifecycle
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v private.company_lifecycle;
begin
  if not exists (select 1 from public.companies c where c.id = p_company and not c.is_demo) then
    raise exception 'Only customer companies have a subscription lifecycle (demos do not).' using errcode = 'P0002';
  end if;
  insert into private.company_lifecycle (company_id) values (p_company) on conflict (company_id) do nothing;
  select * into v from private.company_lifecycle where company_id = p_company for update;
  return v;
end;
$$;
revoke all on function private.lifecycle_for_update(uuid) from public, anon, authenticated;

-- Make every customer company whose go-live day has come live. Idempotent; returns the companies made live.
create or replace function private.lifecycle_activate_due()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select l.company_id, c.name from private.company_lifecycle l join public.companies c on c.id = l.company_id
    where l.stage = 'onboarding' and l.go_live_on is not null and l.onboarding_fee_status in ('paid', 'waived')
      and l.go_live_on <= private.company_today(l.company_id)
    for update of l skip locked
  loop
    update private.company_lifecycle
       set stage = 'live', live_at = now(), commitment_start = case when terms = 'annual' then go_live_on end, updated_at = now()
     where company_id = r.company_id and stage = 'onboarding';
    if found then
      n := n + 1;
      insert into private.platform_audit (actor_id, action, target_type, target_id, summary, detail)
      values (null, 'company_went_live', 'company', r.company_id::text, 'Went live on the scheduled day', jsonb_build_object('company_name', r.name, 'scheduled', true));
    end if;
  end loop;
  return n;
end;
$$;
revoke all on function private.lifecycle_activate_due() from public, anon, authenticated;

-- Cron entry point (service role only; the route checks CRON_SECRET).
create or replace function public.lifecycle_activate_due_cron()
 returns integer
 language sql
 security definer
 set search_path to ''
as $$ select private.lifecycle_activate_due(); $$;
revoke all on function public.lifecycle_activate_due_cron() from public, anon, authenticated;
grant execute on function public.lifecycle_activate_due_cron() to service_role;

-- -----------------------------------------------------------------------------
-- Platform admin functions
-- -----------------------------------------------------------------------------

create or replace function public.platform_plans()
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
begin
  perform private.require_platform_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', v.id, 'plan_key', v.plan_key, 'name', v.name, 'version', v.version, 'monthly_cents', v.monthly_cents,
            'onboarding_cents', v.onboarding_cents, 'from_price', v.from_price, 'trucks', v.trucks, 'bases', v.bases,
            'effective_from', v.effective_from, 'note', v.note, 'created_at', v.created_at,
            'companies', (select count(*) from private.company_lifecycle l where l.plan_version_id = v.id),
            'current', v.id = (select w.id from private.platform_plan_versions w where w.plan_key = v.plan_key and w.effective_from <= current_date
                               order by w.effective_from desc, w.version desc limit 1))
          order by array_position(array['essential', 'growth', 'professional', 'enterprise', 'custom'], v.plan_key), v.version desc), '[]')
          from private.platform_plan_versions v);
end;
$$;
revoke all on function public.platform_plans() from public, anon;
grant execute on function public.platform_plans() to authenticated;

-- A new price version of a plan, from a first day that is not in the past. Earlier versions stay as they are.
create or replace function public.platform_plan_version_create(p jsonb)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_key text := p ->> 'plan_key';
  v_from date;
  v_prev private.platform_plan_versions;
  v_id uuid;
  v_monthly integer;
  v_onboarding integer;
begin
  perform private.require_platform_admin();
  select * into v_prev from private.platform_plan_versions where plan_key = v_key order by version desc limit 1;
  if not found then
    raise exception 'Unknown plan.' using errcode = '22023';
  end if;
  begin
    v_from := (p ->> 'effective_from')::date;
    v_monthly := nullif(p ->> 'monthly_cents', '')::integer;
    v_onboarding := nullif(p ->> 'onboarding_cents', '')::integer;
  exception when others then
    raise exception 'Enter whole-cent prices and a valid first day.' using errcode = '22023';
  end;
  if v_from is null or v_from < current_date then
    raise exception 'A new price starts today or later; past prices are never changed.' using errcode = '22023';
  end if;
  if v_key <> 'custom' and (v_monthly is null or v_onboarding is null or v_monthly < 0 or v_onboarding < 0) then
    raise exception 'Enter the monthly price and the onboarding fee.' using errcode = '22023';
  end if;
  insert into private.platform_plan_versions (plan_key, name, version, monthly_cents, onboarding_cents, from_price, trucks, bases, effective_from, note, created_by)
  values (v_key, v_prev.name, v_prev.version + 1, v_monthly, v_onboarding, v_prev.from_price, v_prev.trucks, v_prev.bases, v_from,
          left(coalesce(p ->> 'note', ''), 500), auth.uid())
  returning id into v_id;
  perform private.platform_log('plan_version_created', 'plan', v_key, v_prev.name || ' version ' || (v_prev.version + 1),
                               jsonb_build_object('monthly_cents', v_monthly, 'onboarding_cents', v_onboarding, 'effective_from', v_from,
                                                  'previous_monthly_cents', v_prev.monthly_cents, 'previous_onboarding_cents', v_prev.onboarding_cents));
  return v_id;
end;
$$;
revoke all on function public.platform_plan_version_create(jsonb) from public, anon;
grant execute on function public.platform_plan_version_create(jsonb) to authenticated;

create or replace function public.platform_lifecycle(p_company uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
begin
  perform private.require_platform_admin();
  if not exists (select 1 from public.companies c where c.id = p_company) then
    raise exception 'Company not found.' using errcode = 'P0002';
  end if;
  return private.lifecycle_json(p_company);
end;
$$;
revoke all on function public.platform_lifecycle(uuid) from public, anon;
grant execute on function public.platform_lifecycle(uuid) to authenticated;

-- Plan, terms and offer. The agreed monthly amount is what the customer signed; Taviron suggests it only where the rule
-- is unambiguous (standard, founding 20% off, annual 10% off, free beta $0) and asks for it otherwise.
create or replace function public.platform_lifecycle_terms(p_company uuid, p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v private.company_lifecycle;
  v_plan private.platform_plan_versions;
  v_terms text := coalesce(nullif(p ->> 'terms', ''), 'monthly');
  v_offer text := coalesce(nullif(p ->> 'offer', ''), 'standard');
  v_agreed integer;
  v_fee integer;
  v_suggested integer;
begin
  perform private.require_platform_admin();
  v := private.lifecycle_for_update(p_company);
  if v.stage = 'canceled' then
    raise exception 'This subscription is canceled.' using errcode = 'P0001';
  end if;
  select * into v_plan from private.platform_plan_versions where id = nullif(p ->> 'plan_version_id', '')::uuid;
  if not found then
    raise exception 'Choose a plan.' using errcode = '22023';
  end if;
  if v_terms not in ('monthly', 'annual') or v_offer not in ('standard', 'founding', 'free_beta') then
    raise exception 'Invalid terms or offer.' using errcode = '22023';
  end if;
  begin
    v_agreed := nullif(p ->> 'agreed_monthly_cents', '')::integer;
  exception when others then
    raise exception 'Enter the agreed monthly amount in dollars and cents.' using errcode = '22023';
  end;
  v_suggested := case
    when v_offer = 'free_beta' then 0
    when v_plan.monthly_cents is null or v_plan.from_price then null
    when v_offer = 'founding' and v_terms = 'annual' then null -- whether the two combine is the owner's decision (§9)
    when v_offer = 'founding' then round(v_plan.monthly_cents * 0.8)::integer
    when v_terms = 'annual' then round(v_plan.monthly_cents * 0.9)::integer
    else v_plan.monthly_cents end;
  if v_offer = 'free_beta' then
    v_agreed := 0;
  end if;
  v_agreed := coalesce(v_agreed, v_suggested);
  if v_agreed is null or v_agreed < 0 then
    raise exception 'Enter the agreed monthly amount: Taviron does not guess it for this plan and offer.' using errcode = '22023';
  end if;
  v_fee := case when v_offer = 'free_beta' then 0 else v_plan.onboarding_cents end;
  if v.stage = 'live' and v.terms <> v_terms then
    raise exception 'Terms cannot change after go-live; cancel and start a new subscription.' using errcode = 'P0001';
  end if;
  update private.company_lifecycle
     set plan_version_id = v_plan.id, terms = v_terms, offer = v_offer, agreed_monthly_cents = v_agreed,
         onboarding_fee_cents = case when onboarding_fee_status = 'due' then v_fee else onboarding_fee_cents end,
         onboarding_fee_status = case when v_offer = 'free_beta' and onboarding_fee_status = 'due' then 'waived' else onboarding_fee_status end,
         onboarding_fee_note = case when v_offer = 'free_beta' and onboarding_fee_status = 'due' then 'Waived: free beta' else onboarding_fee_note end,
         stage = case when stage = 'fee_due' and v_offer = 'free_beta' then 'onboarding' else stage end,
         notes = left(coalesce(p ->> 'notes', notes), 2000),
         updated_by = auth.uid(), updated_at = now()
   where company_id = p_company;
  perform private.platform_log('lifecycle_terms_set', 'company', p_company::text,
                               v_plan.name || ' v' || v_plan.version || ', ' || v_terms || ', ' || v_offer,
                               jsonb_build_object('company_id', p_company, 'plan_version_id', v_plan.id, 'terms', v_terms, 'offer', v_offer,
                                                  'agreed_monthly_cents', v_agreed, 'previous_agreed_monthly_cents', v.agreed_monthly_cents));
  return private.lifecycle_json(p_company);
end;
$$;
revoke all on function public.platform_lifecycle_terms(uuid, jsonb) from public, anon;
grant execute on function public.platform_lifecycle_terms(uuid, jsonb) to authenticated;

-- The onboarding fee was received outside Taviron (recorded, with a reference) or waived (with a reason).
create or replace function public.platform_lifecycle_fee(p_company uuid, p_status text, p_note text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v private.company_lifecycle;
  v_note text := btrim(coalesce(p_note, ''));
begin
  perform private.require_platform_admin();
  v := private.lifecycle_for_update(p_company);
  if p_status not in ('paid', 'waived') then
    raise exception 'Choose received or waived.' using errcode = '22023';
  end if;
  if v.plan_version_id is null then
    raise exception 'Choose the plan first.' using errcode = 'P0001';
  end if;
  if v.onboarding_fee_status <> 'due' then
    raise exception 'The onboarding fee is already recorded as %.', v.onboarding_fee_status using errcode = 'P0001';
  end if;
  if length(v_note) < 3 then
    raise exception 'Enter the payment reference or the reason for the waiver.' using errcode = '22023';
  end if;
  update private.company_lifecycle
     set onboarding_fee_status = p_status, onboarding_fee_note = left(v_note, 300),
         stage = case when stage = 'fee_due' then 'onboarding' else stage end, updated_by = auth.uid(), updated_at = now()
   where company_id = p_company;
  perform private.platform_log('onboarding_fee_' || p_status, 'company', p_company::text, left(v_note, 300),
                               jsonb_build_object('company_id', p_company, 'amount_cents', v.onboarding_fee_cents));
  return private.lifecycle_json(p_company);
end;
$$;
revoke all on function public.platform_lifecycle_fee(uuid, text, text) from public, anon;
grant execute on function public.platform_lifecycle_fee(uuid, text, text) to authenticated;

-- The go-live date: first set while onboarding; afterwards only earlier, never in the past (company time zone).
create or replace function public.platform_lifecycle_go_live_on(p_company uuid, p_date date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v private.company_lifecycle;
  v_today date;
begin
  perform private.require_platform_admin();
  v := private.lifecycle_for_update(p_company);
  v_today := private.company_today(p_company);
  if v.stage <> 'onboarding' then
    raise exception 'A go-live date is set while onboarding (after the onboarding fee is received or waived).' using errcode = 'P0001';
  end if;
  if p_date is null or p_date < v_today then
    raise exception 'The go-live date cannot be in the past.' using errcode = '22023';
  end if;
  if v.go_live_on is not null and p_date >= v.go_live_on then
    raise exception 'The go-live date can only move earlier (currently %).', to_char(v.go_live_on, 'Mon FMDD, YYYY') using errcode = 'P0001';
  end if;
  update private.company_lifecycle set go_live_on = p_date, updated_by = auth.uid(), updated_at = now() where company_id = p_company;
  perform private.platform_log('go_live_scheduled', 'company', p_company::text, 'Go-live ' || to_char(p_date, 'Mon FMDD, YYYY'),
                               jsonb_build_object('company_id', p_company, 'go_live_on', p_date, 'previous', v.go_live_on));
  perform private.lifecycle_activate_due();
  return private.lifecycle_json(p_company);
end;
$$;
revoke all on function public.platform_lifecycle_go_live_on(uuid, date) from public, anon;
grant execute on function public.platform_lifecycle_go_live_on(uuid, date) to authenticated;

-- Go Live Now: the platform admin re-entered their password in the last 5 minutes. Idempotent.
create or replace function public.platform_lifecycle_go_live_now(p_company uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v private.company_lifecycle;
  v_admin uuid;
  v_signed timestamptz;
begin
  v_admin := private.require_platform_admin();
  v := private.lifecycle_for_update(p_company);
  if v.stage = 'live' then
    return private.lifecycle_json(p_company) || jsonb_build_object('already_live', true);
  end if;
  if v.stage <> 'onboarding' then
    raise exception 'A company goes live from onboarding, after the onboarding fee is received or waived.' using errcode = 'P0001';
  end if;
  select u.last_sign_in_at into v_signed from auth.users u where u.id = v_admin;
  if v_signed is null or v_signed < now() - interval '5 minutes' then
    raise exception 'Enter your password again to go live now.' using errcode = '42501';
  end if;
  update private.company_lifecycle
     set stage = 'live', live_at = now(), go_live_on = private.company_today(p_company),
         commitment_start = case when terms = 'annual' then private.company_today(p_company) end, updated_by = v_admin, updated_at = now()
   where company_id = p_company;
  perform private.platform_log('company_went_live', 'company', p_company::text, 'Went live now (password confirmed)',
                               jsonb_build_object('company_id', p_company, 'scheduled', false, 'previous_go_live_on', v.go_live_on));
  return private.lifecycle_json(p_company);
end;
$$;
revoke all on function public.platform_lifecycle_go_live_now(uuid) from public, anon;
grant execute on function public.platform_lifecycle_go_live_now(uuid) to authenticated;

-- Cancel. An annual commitment states its remaining balance; the operator confirms that exact amount.
create or replace function public.platform_lifecycle_cancel(p_company uuid, p_reason text, p_confirm_balance_cents integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v private.company_lifecycle;
  v_balance integer := 0;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_platform_admin();
  v := private.lifecycle_for_update(p_company);
  if v.stage = 'canceled' then
    return private.lifecycle_json(p_company);
  end if;
  if length(v_reason) < 3 then
    raise exception 'Enter the reason for the cancellation.' using errcode = '22023';
  end if;
  if v.stage = 'live' and v.terms = 'annual' and v.commitment_start is not null then
    v_balance := private.commitment_months_left(v.commitment_start, private.company_today(p_company)) * coalesce(v.agreed_monthly_cents, 0);
  end if;
  if p_confirm_balance_cents is distinct from v_balance then
    raise exception 'The remaining commitment balance is % cents; confirm that amount to cancel.', v_balance using errcode = 'P0001';
  end if;
  update private.company_lifecycle
     set stage = 'canceled', canceled_at = now(), cancel_reason = left(v_reason, 500), cancel_balance_cents = v_balance,
         updated_by = auth.uid(), updated_at = now()
   where company_id = p_company;
  perform private.platform_log('subscription_canceled', 'company', p_company::text, left(v_reason, 300),
                               jsonb_build_object('company_id', p_company, 'balance_cents', v_balance, 'previous_stage', v.stage));
  return private.lifecycle_json(p_company);
end;
$$;
revoke all on function public.platform_lifecycle_cancel(uuid, text, integer) from public, anon;
grant execute on function public.platform_lifecycle_cancel(uuid, text, integer) to authenticated;

-- Acknowledge a needs-attention item (seen and owned; it stays until its cause is resolved).
create or replace function public.platform_attention_ack(p_key text, p_note text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  perform private.require_platform_admin();
  if p_key is null or p_key !~ '^[a-z_]{3,40}:[A-Za-z0-9-]{1,80}$' then
    raise exception 'Invalid item.' using errcode = '22023';
  end if;
  insert into private.platform_attention_acks (item_key, acknowledged_by, acknowledged_at, note)
  values (p_key, auth.uid(), clock_timestamp(), left(coalesce(p_note, ''), 300))
  on conflict (item_key) do update set acknowledged_by = excluded.acknowledged_by, acknowledged_at = excluded.acknowledged_at, note = excluded.note;
  perform private.platform_log('attention_acknowledged', split_part(p_key, ':', 1), split_part(p_key, ':', 2), left(coalesce(p_note, ''), 300));
end;
$$;
revoke all on function public.platform_attention_ack(text, text) from public, anon;
grant execute on function public.platform_attention_ack(text, text) to authenticated;

-- The console's four fixed KPIs and the acknowledgements. Activates due go-lives first (idempotent).
create or replace function public.platform_console()
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  perform private.require_platform_admin();
  perform private.lifecycle_activate_due();
  return jsonb_build_object(
    'as_of', now(),
    'customers', (select jsonb_build_object(
        'total', count(*) filter (where c.active),
        'live', count(*) filter (where c.active and l.stage = 'live'),
        'onboarding', count(*) filter (where c.active and l.stage = 'onboarding'),
        'fee_due', count(*) filter (where c.active and l.stage = 'fee_due'),
        'no_plan', count(*) filter (where c.active and (l.company_id is null or l.plan_version_id is null)),
        'canceled', count(*) filter (where l.stage = 'canceled'),
        'go_live_14d', count(*) filter (where c.active and l.stage = 'onboarding' and l.go_live_on <= current_date + 14))
      from public.companies c left join private.company_lifecycle l on l.company_id = c.id where not c.is_demo),
    'mrr', (select jsonb_build_object(
        'cents', coalesce(sum(l.agreed_monthly_cents) filter (where l.stage = 'live'), 0),
        'live', count(*) filter (where l.stage = 'live'),
        'free', count(*) filter (where l.stage = 'live' and l.agreed_monthly_cents = 0),
        'contracted_not_live_cents', coalesce(sum(l.agreed_monthly_cents) filter (where l.stage in ('fee_due', 'onboarding')), 0))
      from private.company_lifecycle l join public.companies c on c.id = l.company_id where c.active and not c.is_demo),
    'pipeline', (select jsonb_build_object(
        'open', count(*),
        'new', count(*) filter (where status = 'new'),
        'demo_scheduled', count(*) filter (where status = 'demo_scheduled'),
        'overdue', count(*) filter (where follow_up_on < current_date))
      from private.leads where disposition <> 'spam' and status not in ('converted', 'not_proceeding')),
    'acks', (select coalesce(jsonb_object_agg(a.item_key, jsonb_build_object('at', a.acknowledged_at, 'note', a.note,
                                              'by', coalesce(nullif(p.full_name, ''), p.email, 'Operator'))), '{}')
             from private.platform_attention_acks a left join public.profiles p on p.id = a.acknowledged_by),
    'lifecycles', (select coalesce(jsonb_object_agg(l.company_id, jsonb_build_object('stage', l.stage, 'go_live_on', l.go_live_on,
                                   'agreed_monthly_cents', l.agreed_monthly_cents, 'offer', l.offer)), '{}')
                   from private.company_lifecycle l)
  );
end;
$$;
revoke all on function public.platform_console() from public, anon;
grant execute on function public.platform_console() to authenticated;
