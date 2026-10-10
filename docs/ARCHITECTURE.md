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
| Delivery records are never overwritten | Tickets are revisions: a correction inserts revision n+1 and supersedes the old row; voids keep the row with a reason; a trigger blocks any other change or delete. Snapshots keep truck/driver/material identity when dispatch changes later. |
| No unit conversions | Ticket quantities keep the unit entered; a unit different from the order line is flagged for review, never converted. Whole-number units mirrored in `src/lib/tickets/rules.ts` (parity-tested). |
| Photos cannot leak across companies | Storage policies + attachment records decide every upload and read; tests try invented paths, other companies' folders, other drivers, anonymous calls, wrong types, oversized files, expired and altered signed links, and mechanics/drivers/other companies reading. |
| Drivers see and touch only their own work | Drivers have no table grants; every portal function resolves the driver from the session (`auth.uid()` + current company → linked, active driver record) and accepts an assignment id only if it is that driver's active assignment. Driver, truck and trailer of a ticket come from the assignment. Tests try other drivers' assignments, another company, stolen submission keys and office functions. |
| One ticket path | Office and driver tickets share `private.create_ticket` (numbering, validation, duplicate confirmation, idempotency, review flags, events, audit); drivers never accept, correct or void. |
| Command center never hides a problem | Exceptions are derived on every load from the module records (no stored status, no dismissal); an item disappears only when its record changes. Assignments only name a person, end when replaced, and stop showing once the exception is gone. Each kind is gated by the permission of its source module inside the definer function, which resolves the company itself. |
| Billing readiness cannot drift | Readiness is derived by views (`billing_order_status` and friends) from loads, assignments, order lines and current ticket revisions on every read; the only stored items are office decisions. An acknowledgment is bound to a fingerprint of the exceptions it covered and stops counting when they change. |
| No double billing handoff | Partial unique index: an order is in at most one active handoff; `hand_off_orders` locks orders, loads and tickets, re-checks readiness and refuses an order already handed off (`PT409`); per-form idempotency key; undo keeps the row with a reason. Tested with two concurrent connections. |
| Billing never changes prices | Handoff and acknowledgment write only billing tables; order pricing triggers are untouched; tests compare the order and its lines before and after. |
| No accidental duplicate tickets | Unique per-form submission key; explicit confirmation for a second ticket on a load or a reused paper number; ticket numbers from the row-locked sequence (tested with concurrent submissions). |
| No hard deletes of business records | Customers, contacts, sites, materials, charges, price lists are archived/deactivated. Only mistaken rate entries can be deleted. |

## Companies (tenant isolation)

The application serves several independent companies from one database. The seeded
sample company "Top Line Trucking" is company #1 (`00000000-0000-4000-8000-000000000001`);
it is development data and no shared code refers to it. New companies start with their own
name, empty address, their chosen time zone and no records.

- **Ownership**: every business table has `company_id uuid not null` (audit events
  may be null, then visible to nobody). Global tables: `companies`, `profiles`
  (personal data), `permissions`, `role_permission_defaults`.
- **Current company**: `private.current_company_id()` resolves it from the
  signed-in user's active membership (`company_memberships`, active, with a role,
  in an active company; `profiles.active_company_id` picks one if there are
  several). It is **never** taken from the request. `my_access()` returns it to
  the app, and the header shows it. People with several companies change it in the
  account menu: `switch_company(id)` sets `active_company_id` only to a company where
  they have an active membership with a role (otherwise 42501), and every query
  follows it in the database.
- **RLS**: every policy is `company_id = (select private.current_company_id()) and
  (select private.has_permission('…'))`. The `(select …)` form evaluates each
  helper once per statement. `has_permission` reads the caller's role in the
  current company and that company's `role_permissions`.
- **Elevated functions**: all 115 `SECURITY DEFINER` functions were reviewed (35 with
  company separation, 7 with order management, 4 with the fleet registry, 10 with
  dispatch, 4 with delivery tickets, 5 with billing readiness, 7 with the command
  center, 8 with the driver portal, 6 with ticket photos, 15 with company onboarding, 9 with
  workflow coordination, 2 with ticket processing, 3 with the early-access gate).
  Each public one resolves the company itself (`private.require_company()`), looks up
  every referenced row with `and company_id = v_company`, and writes the verified
  company id. None accepts a company id from the caller, except `switch_company`,
  which only accepts the caller's own active memberships (a reviewed exception the
  tenancy test names). Internal helpers
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
  for the Auth admin API (invitation emails, creating an unconfirmed account at
  early-access sign-up) and the service-role-only early-access functions;
  memberships are created by `add_existing_member()` / `add_company_member()`
  running as the inviting user, and companies by `complete_company_onboarding()`
  running as the verified new owner.
- **Storage**: Supabase Storage, private bucket `ticket-photos`. Object paths start
  with `company_id` and are chosen by the database; storage RLS calls SECURITY DEFINER
  helpers that check the caller's company, permission and the attachment record, so a
  changed path or record id is refused by the storage server itself. Uploads pass
  through the app server first (size, magic bytes vs declared type, same-origin) and
  are confirmed against `storage.objects`; downloads use 60-second signed URLs created
  with the viewer's token. No public URLs, no update/delete for app users. Verified
  against the real storage server (`tests/storage`).
- **Background jobs**: none run inside the app. The abandoned-upload cleanup is an
  operator script with the service role (`scripts/cleanup-ticket-photos.mjs`).
- **Creating a company**: with an early-access code (below), or by an operator:
  `select private.create_company('Name', 'slug');` then
  `scripts/create-owner.mjs owner@x.com "Name" slug`. There is no subscription billing.

## Early access gate (in front of everything)

Four separate questions, answered by four separate mechanisms:

1. **May this browser reach the app at all?** — the early-access gate: a site-access code
   (`private.early_access_codes`, purpose `site_access`) redeemed on the server for a device
   grant (`private.site_access_grants`), carried in a signed HttpOnly cookie and re-checked
   with the database every 5 minutes. Enforced in `src/proxy.ts` for every route; sign-in,
   reset and sign-up actions re-check it. Signed-in users pass (they already have an
   account). Configuration: `EARLY_ACCESS_GATE`, `SITE_ACCESS_SECRET` (fails closed).
2. **Who is this?** — Supabase Auth (password, email links). Unchanged.
3. **Which companies?** — `company_memberships` + `active_company_id`. Unchanged.
4. **What may they do?** — role permissions and RLS. Unchanged.

Passing (1) never creates an account, a company, a membership or a permission.

## Early access and company onboarding

Supabase Auth does the authentication (passwords, email verification, sessions);
public Auth sign-up stays **disabled**. The early-access gate is a separate
component in the `private` schema, reachable only through service-role functions:

1. `/signup` (server action): `early_access_check` (code hash + rate limits per IP
   and email; keys are HMACs, the code itself is never stored) → Auth admin API
   creates the account **unconfirmed** (an existing email is told to sign in
   instead, so a code is never attached to someone else's account) →
   `early_access_reserve` takes one use for that account under a row lock (undone if
   it fails) → Auth sends the verification email. A per-form request key makes
   retries return the same result.
2. The email link (`/auth/confirm`) signs the person in and opens `/onboarding`.
3. `complete_company_onboarding()` (as the user, verified email required) creates the
   company, its settings, numbering, permissions, units and price list, the owner
   membership and active company, and completes the reservation, in one transaction.
   Running it again returns the same company. A revoked code stops it.

Signed-in users with a verified email create another company with a new code
(`create_company_with_access_code`, on `/onboarding`; the account menu links to it
for owners, `/no-access` for people without a company). Operators issue, list and revoke codes with
`scripts/early-access.mjs`. Codes: 20 random characters (100 bits), shown once,
stored as SHA-256, with label, maximum uses, expiry and revocation.

## Command Center and workflow coordination

- **One home page** (`/command-center`; `/dashboard` redirects). Every figure and queue item
  comes from the database for the caller's company and permissions
  (`command_center_summary`, `command_center_exceptions` over
  `private.operational_exceptions`); nothing is stored as a count. A section that cannot load
  says so — it never shows zero instead.
- **Responsibilities vs permissions**: sections appear by permission (operations, quotes, a
  linked driver record for "Your loads today"). Arranging, collapsing or hiding never changes
  what the database returns. Owners hold `driver.portal`, but the portal still requires a
  linked, active driver record.
- **Personal state**: `user_preferences` (layout only) and `exception_dismissals` (hide a
  non-urgent item for yourself, time-limited; urgent items cannot be hidden; hidden items
  stay counted). Both are per user and per company.
- **Urgent orders**: `order_urgencies` + append-only `order_urgency_events`; the office
  flags (orders.edit), dispatch acknowledges and moves states (dispatch.edit); "truck
  assigned" requires a real assignment; completion or cancellation closes the flag. Optional
  escalation time per company (`company_settings.urgent_ack_minutes`). No notifications.
- **Continuity**: queue links carry a validated `back` parameter
  (`src/lib/safe-redirect.ts` → `returnTarget` accepts only known list pages); the ticket
  review queue offers position and "Accept and next"; the order page shows progress across
  dispatch, tickets and billing from the same records (`src/lib/orders/progress.ts`).

## Delivery tickets: from paper to verified

- **One chain of records**: order → load → dispatch assignment → ticket (revisions) →
  billing views. A ticket is *received* (`submitted`), *flagged* (`needs_review`, with
  reasons computed by the database) or *verified* (`accepted` by `tickets.review`); a
  correction is a new revision that must be verified again; nothing completes an order or
  changes an assignment automatically.
- **Evidence**: driver photos and office scans share one private bucket; the database
  reserves each path for one user in one company, storage policies accept only that path,
  and the database confirms size and type before attaching; images are never replaced or
  deleted and stay with the ticket number.
- **Downstream**: billing readiness is a view over the same tickets, so a correction or
  verification re-evaluates it at once; `verified_delivery_inputs` names the facts future
  payroll will use (no money; billing amounts are never driver pay).

## Security model

- **Roles** (per company membership; only owners can grant or remove Owner): owner, office, dispatcher (views orders, schedules them and moves them through delivery, plans loads and assigns trucks and drivers; cannot create, price, confirm or cancel orders), mechanic (views the fleet and takes equipment in and out of service), driver (future). A new account has no membership and sees nothing until an owner adds it.
- **Permissions** (`public.permissions`, per-company `public.role_permissions`, defaults in `role_permission_defaults`): editable by owners in Settings → Permissions; owner permissions are fixed so an owner cannot lock themselves out. At least one active owner per company must always exist.
- **Staff directory**: `user_directory()` lists people in the caller's company only; email addresses only for users with `users.manage`.
- **RLS**: enabled on every table. `anon` has no grants. Quote and order tables are read-only to clients; all writes go through `SECURITY DEFINER` functions with `search_path = ''`.
- **Secrets**: the service-role key is only read in `src/server/supabase/admin.ts` (server-only) for invitations (after the caller's `users.manage` permission has been checked) and early-access sign-up (after the code and rate limits have been checked).
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
