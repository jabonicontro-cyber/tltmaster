# Architecture

## Request flow

```
Browser
  │  (session cookie set by Supabase Auth via @supabase/ssr)
  ▼
src/proxy.ts ── refreshes the session; anonymous → /login
  ▼
Server Component page ──► requirePagePermission()  (src/server/auth.ts)
  │                         loads role + permissions via my_access() RPC
  ▼
src/server/data/*  ── Supabase client bound to the user's JWT ──► PostgREST ──► PostgreSQL
                                                                     RLS on every table

Client form ──► Server Action (src/app/(app)/*/actions.ts)
                 1. assertPermission()          (server, from the database)
                 2. zod validation               (src/lib/schemas)
                 3. table write (RLS) or RPC     (SECURITY DEFINER function that
                                                  re-checks permission, validates,
                                                  computes totals, writes audit log)
                 4. ActionResult {ok | error + fieldErrors} → form keeps the user's input
```

Every permission is enforced three times for writes: the page/action guard,
the database function or RLS policy, and (for quotes) table grants that allow
no direct writes at all.

## Code layout

| Path | Purpose |
| --- | --- |
| `src/lib/` | Pure, framework-free logic: money/quantity parsing, quote calculation, status rules, document model, zod schemas. Unit-tested. |
| `src/server/` | `server-only` code: env validation, Supabase clients, auth guards, data access, email provider, PDF rendering. |
| `src/components/ui/` | Design-system primitives (Button, Field, Table, Badge, Dialog, ConfirmDialog, Combobox, states, toasts). |
| `src/components/<module>/` | Module UI (customer panels, catalog tables, quote editor/actions/document, settings). |
| `src/app/(auth)/` | Sign-in, password reset. |
| `src/app/(app)/` | Authenticated app; layout renders the sidebar shell after `requireAccess()`. |
| `supabase/migrations/` | Schema, RLS, functions — the source of truth for business rules that must not be bypassed. |

## Key rules and where they live

| Rule | Enforced in |
| --- | --- |
| Quote totals | `public.save_quote_draft` (database). `src/lib/quotes/calc.ts` mirrors it for live preview; `tests/db/quote-calc-parity.test.ts` proves they agree on 40 random quotes. |
| Money never uses floating point | Cents as `bigint`; quantities `numeric(12,3)`; TS parses strings to integers and multiplies with `BigInt`, rounding half away from zero (same as PostgreSQL `round(numeric)`). |
| Sent quotes never change | `private.guard_locked_version` / `guard_locked_lines` triggers block updates and deletes of issued revisions, even by the database owner. |
| Revisions | `public.revise_quote` copies the issued revision into a new draft revision. |
| Price overrides & discounts need permission | `save_quote_draft` compares each rate with the configured price (customer list → standard list) and requires `pricing.override`. |
| Catalog price changes never alter quotes | Each quote line stores its own description, unit, rate, catalog rate at the time, and price source. |
| Sequential numbers, concurrency-safe | `private.next_document_number` row-locks `document_sequences`. Tested with two concurrent transactions. |
| Status transitions | `private.quote_transition_allowed` (DB) mirrored by `src/lib/quotes/status.ts`. |
| Email honesty | `sendQuoteEmail` marks a quote sent only after the provider accepts; all attempts recorded in `email_deliveries`. |
| Audit trail | Row triggers on customers, catalog, prices, settings, users, permissions; explicit events in quote functions. `audit_events` is append-only. |
| One order per accepted quote | `public.convert_quote_to_order` locks the quote, returns the existing order on repeat calls; unique `orders.source_quote_id`. Tested with two concurrent transactions. |
| Orders keep the accepted prices | Order lines are copied from the accepted revision's snapshots; no client write access to order tables; triggers `orders_guard_pricing` / `order_lines_guard` refuse any change to lines, totals, tax, terms or customer unless the order is a direct order in Draft — even for the database owner. |
| Direct orders use the quote pricing rules | `public.save_order_draft` uses the same price resolution and `pricing.override` check as `save_quote_draft`; parity with the TypeScript calculator is tested. |
| Order status transitions | `private.order_transition_allowed` + `order_transition_permission` (DB) mirrored by `src/lib/orders/status.ts`; parity-tested. |
| Order edits never lose work silently | `orders.edit_seq` optimistic concurrency on every order function; field-level audit diffs shown in the order timeline. |
| Capacities and qualifications are never assumed | Unknown = `NULL`, shown as "Unknown"; verification stamped by the database (who/when); eligibility treats missing, expired, unverified or undated qualifications as blockers. |
| Equipment service status has history | Status columns have no client grants; `set_equipment_service_status` requires `fleet.service` and a reason, writes `equipment_status_events` (append-only). |
| Dispatch readiness | `public.check_assignment_eligibility` (DB) mirrored by `src/lib/fleet/eligibility.ts`; parity-tested. |
| No double-booking of trucks, trailers or drivers | Exclusion constraints on `dispatch_assignments` (half-open time ranges, active rows); `assign_load` pre-checks to name the conflict and maps a concurrent loss to a clear "reload" message. Tested with two concurrent transactions. |
| Dispatch uses the fleet rules | `assign_load` calls `private.assignment_eligibility` (the body of `check_assignment_eligibility`); error texts mirror `ELIGIBILITY_MESSAGES` (parity-tested). |
| Assignment history | Reassignment cancels and inserts; rows are immutable except cancellation and never deleted; every change is audited on the order. |
| No hard deletes of business records | Customers, contacts, sites, materials, charges, price lists are archived/deactivated. Only mistaken rate entries can be deleted. |

## Companies (tenant isolation)

The application serves several independent companies from one database. Top Line
Trucking is company #1 (`00000000-0000-4000-8000-000000000001`).

- **Ownership**: every business table has `company_id uuid not null` (audit events
  may be null, then visible to nobody). Global tables: `companies`, `profiles`
  (personal data), `permissions`, `role_permission_defaults`.
- **Current company**: `private.current_company_id()` resolves it from the
  signed-in user's active membership (`company_memberships`, active, with a role,
  in an active company; `profiles.active_company_id` picks one if there are
  several). It is **never** taken from the request. `my_access()` returns it to
  the app, and the header shows it.
- **RLS**: every policy is `company_id = (select private.current_company_id()) and
  (select private.has_permission('…'))`. The `(select …)` form evaluates each
  helper once per statement. `has_permission` reads the caller's role in the
  current company and that company's `role_permissions`.
- **Elevated functions**: all 56 `SECURITY DEFINER` functions were reviewed (35 with
  company separation, 7 with order management, 4 with the fleet registry, 10 with
  dispatch). Each
  public one resolves the company itself (`private.require_company()`), looks up
  every referenced row with `and company_id = v_company`, and writes the verified
  company id. None accepts a company id from the caller. Internal helpers
  (`next_document_number`, `create_company`, `resolve_price`, …) are not
  executable by app users. A database test fails if a new definer function
  appears without being added to the reviewed list.
- **Same-company references**: composite foreign keys `(company_id, x_id) →
  parent (company_id, id)` on every business relation, so even the database owner
  cannot link a quote to another company's customer, material, unit, contact or
  site. `company_id` can never change (`a_company_guard` triggers).
- **Per company**: settings, document numbering (`C-00001`, `Q-2026-0001` restart
  per company), role grants, units, standard price list, and uniqueness of
  names/codes/numbers.
- **Server code**: pages, server actions and the PDF route use the user-bound
  Supabase client, so RLS applies everywhere. The service-role key is used only
  to send an invitation email; the membership is then created by
  `add_company_member()` running as the inviting owner.
- **Storage / background jobs**: none exist yet. When added, object paths must
  start with `company_id` and policies must use the same membership check; jobs
  must run per company.
- **Creating a company** (operator only): `select private.create_company('Name', 'slug');`
  then `scripts/create-owner.mjs owner@x.com "Name" slug`. There is no self-serve
  sign-up or billing.

## Security model

- **Roles** (per company membership): owner, office, dispatcher (views orders, schedules them and moves them through delivery, plans loads and assigns trucks and drivers; cannot create, price, confirm or cancel orders), mechanic (views the fleet and takes equipment in and out of service), driver (future). A new account has no membership and sees nothing until an owner adds it.
- **Permissions** (`public.permissions`, per-company `public.role_permissions`, defaults in `role_permission_defaults`): editable by owners in Settings → Permissions; owner permissions are fixed so an owner cannot lock themselves out. At least one active owner per company must always exist.
- **Staff directory**: `user_directory()` lists people in the caller's company only; email addresses only for users with `users.manage`.
- **RLS**: enabled on every table. `anon` has no grants. Quote and order tables are read-only to clients; all writes go through `SECURITY DEFINER` functions with `search_path = ''`.
- **Secrets**: the service-role key is only read in `src/server/supabase/admin.ts` (server-only) for invitations, after the caller's `users.manage` permission has been checked.
- **Indexing**: `X-Robots-Tag: noindex`, `robots.txt` disallow, and `robots` metadata.
- **Input**: all server actions validate with zod; database functions validate again.

## Rendering choices

`cacheComponents` is disabled: every page is private, per-user and must show
current data, so pages render on each request. Server Components fetch data;
Client Components are used only for interactive pieces (forms, dialogs,
the quote editor).

## Extension points for later phases

- **Orders**: conversion, direct orders, detail edits, scheduling and status transitions are done. Next: loads per order and assignments (dispatch), then deriving status from dispatch and tickets where possible.
- **Routing**: implement a `RoutingProvider` interface (geocode, matrix, route) with a "not configured" implementation; no fabricated results.
- **QuickBooks**: export approved billing records first; store external IDs and sync status per record to prevent duplicates.
