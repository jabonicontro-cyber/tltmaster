-- =============================================================================
-- PROPOSAL — NOT A MIGRATION. Kept outside supabase/migrations/ on purpose, so
-- `supabase db push` never applies it. Becomes a versioned migration (with a
-- rollback script and DB tests) only after the founder approves the model.
-- Smart Load Build increment 2 (docs/SMART_LOAD_BUILD.md §9–§10).
--
-- Dispatcher-maintained trip times, per company:
--   * sources            — quarries, plants, yards a truck loads at, with the
--                          usual loading minutes;
--   * route_times        — outbound and return minutes for one source → job
--                          site pair;
--   * site_unload_times  — usual unloading minutes at a job site.
-- Every duration carries its basis: 'dispatcher' (entered by a person),
-- 'measured' (from ticket timestamps, later) or 'estimate' (e.g. a routing
-- service, later). Nothing here assigns trucks or drivers.
--
-- Tenancy: company_id defaults to the caller's company, can never change, and
-- every reference is a (company_id, id) foreign key, so a row can only point at
-- the same company's sources and sites. RLS: read with dispatch.view, write
-- with dispatch.edit, always within the caller's company.
-- =============================================================================

create table public.sources (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null default private.current_company_id() references public.companies (id),
  name           text not null check (length(trim(name)) between 1 and 120),
  kind           text not null default 'quarry' check (kind in ('quarry', 'plant', 'yard', 'other')),
  line1          text not null default '',
  city           text not null default '',
  state          text not null default '',
  postal_code    text not null default '',
  load_minutes   integer check (load_minutes between 0 and 1440),
  load_basis     text check (load_basis in ('dispatcher', 'measured', 'estimate')),
  active         boolean not null default true,
  notes          text not null default '' check (length(notes) <= 1000),
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_by     uuid default auth.uid(),
  updated_at     timestamptz not null default now(),
  unique (company_id, id),
  -- A duration and its basis are both present or both absent: never a number of unknown origin.
  check ((load_minutes is null) = (load_basis is null))
);
create unique index sources_company_name on public.sources (company_id, lower(trim(name)));

create table public.route_times (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default private.current_company_id() references public.companies (id),
  source_id        uuid not null,
  site_id          uuid not null,
  outbound_minutes integer not null check (outbound_minutes between 0 and 1440),
  outbound_basis   text not null check (outbound_basis in ('dispatcher', 'measured', 'estimate')),
  back_minutes     integer not null check (back_minutes between 0 and 1440),
  back_basis       text not null check (back_basis in ('dispatcher', 'measured', 'estimate')),
  sample_count     integer check (sample_count >= 0), -- measured values only
  notes            text not null default '' check (length(notes) <= 1000),
  updated_by       uuid default auth.uid(),
  updated_at       timestamptz not null default now(),
  unique (company_id, source_id, site_id),
  foreign key (company_id, source_id) references public.sources (company_id, id),
  foreign key (company_id, site_id) references public.customer_sites (company_id, id)
);

create table public.site_unload_times (
  site_id        uuid primary key,
  company_id     uuid not null default private.current_company_id() references public.companies (id),
  unload_minutes integer not null check (unload_minutes between 0 and 1440),
  unload_basis   text not null check (unload_basis in ('dispatcher', 'measured', 'estimate')),
  updated_by     uuid default auth.uid(),
  updated_at     timestamptz not null default now(),
  foreign key (company_id, site_id) references public.customer_sites (company_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['sources', 'route_times', 'site_unload_times'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (company_id = (select private.current_company_id()) and private.has_permission(''dispatch.view''))', t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (company_id = (select private.current_company_id()) and private.has_permission(''dispatch.edit''))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (company_id = (select private.current_company_id()) and private.has_permission(''dispatch.edit'')) with check (company_id = (select private.current_company_id()) and private.has_permission(''dispatch.edit''))', t || '_update', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke delete, truncate on public.%I from authenticated', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('create trigger a_company_guard before update of company_id on public.%I for each row execute function private.forbid_company_change()', t);
    execute format('create trigger %I before update on public.%I for each row execute function private.touch_updated_at()', t || '_touch', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function private.audit_row_change(%L)', t || '_audit', t, t);
  end loop;
end $$;
-- No delete grant: sources are deactivated; a route or unload time is corrected by updating it (audited).
