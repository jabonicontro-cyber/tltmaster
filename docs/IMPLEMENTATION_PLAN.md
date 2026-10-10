# Top Line Trucking Manager → Hauling Operating System — Implementation Plan

Top Line Trucking is the first customer. The long-term goal is a hauling
operating system that other trucking and hauling companies could also use.
This plan is grounded in an audit of the code as it exists (commit `a2a5f0b`,
audited 2026-10-10), updated after the tenant foundation (B1), order management (N1 + N2), the fleet registry (N3), dispatch assignments (N4) and delivery tickets (N5). The code, migrations and tests are the source of truth;
where this document and the code disagree, the code wins and this document
should be fixed.

---

## 1. Audit summary (verified)

How this was verified: the live schema was inspected in the migrated local
database (tables, RLS flags, policies, grants, `SECURITY DEFINER` functions,
unique keys). The code, the tests and the docs were read. Lint, typecheck and
105 unit + database tests were re-run, and all passed. GitHub Actions CI passed
on all three pushes so far (lint, typecheck, unit tests, build, database tests).
The 10 browser tests pass locally but **are not run in CI**.

**Solid foundation.** Authentication works. Server-side permission checks back
every page and action. RLS is enabled on all 23 tables, `anon` has no table
grants and cannot execute any function, and all 30 `SECURITY DEFINER` functions
pin `search_path`. Money calculations are decimal-safe and computed by the
database. Issued quote revisions are immutable at the database level. Numbering
is safe under concurrency. Audit and status history are append-only. Quote →
order conversion is idempotent.

**Biggest structural gap (resolved by B1, see §5): the system was single-company.** No table has a
company/tenant column. `company_settings` is a one-row table (`id boolean check
(id)`). `document_sequences`, `role_permissions` and `units_of_measure` are
global. Uniqueness is global too: quote/order/customer numbers, material and
charge names, price-list names, and "one standard price list". All 30
`SECURITY DEFINER` functions look rows up by id with RLS bypassed. Adding more
tables first would multiply the cost of fixing this later.

### Feature status matrix

Legend: ✅ complete and tested · 🟡 partial · 🧱 placeholder UI only · ❌ missing

| Area | State | Where it lives | Notes / gaps |
| --- | --- | --- | --- |
| Auth: sign-in, sign-out, reset, invite, no-access | ✅ (reset/invite email 🟡) | `src/app/(auth)`, `src/proxy.ts`, `src/server/auth.ts`, `scripts/create-owner.mjs` | Reset and invitation emails have never been delivered: they need a hosted Supabase project with SMTP. |
| Roles and permissions | ✅ per company | `company_memberships`, `role_permissions` (per company), `role_permission_defaults`, Settings → Permissions | Roles: owner, office, dispatcher, mechanic (fleet view + service status), driver (no permissions yet). A user can belong to several companies; one is active at a time (no switcher UI yet). |
| Customers, contacts, job sites | ✅ | `customers`, `customer_contacts`, `customer_sites`; `src/app/(app)/customers` | Saved site instructions exist (`customer_sites.directions`). There is no customer portal. |
| Materials, charges, units, price lists | ✅ | `materials`, `charge_items`, `units_of_measure`, `price_lists`, `price_list_entries` | Customer price lists have dated history. **No supplier costs** anywhere. |
| Quotes: editor, revisions, status, history | ✅ | `quotes`, `quote_versions`, `quote_lines`, `save_quote_draft` and related functions | Quote lines snapshot **prices, not costs**. There is no quote duplication and no automatic expiry (by design). |
| Quote PDF and print preview | ✅ | `src/server/pdf/quote-pdf.tsx`, `src/lib/quotes/document.ts` | PDFs for sample quotes carry **no SAMPLE watermark**. |
| Quote email | 🟡 | `src/server/email/provider.ts`, `sendQuoteEmail` | Preview and test modes are tested. Real Resend delivery has never been exercised. |
| Quote → order conversion | ✅ | `orders`, `order_lines`, `convert_quote_to_order` | — |
| Order management | ✅ (N1 + N2, see §5a) | `src/app/(app)/orders`, `src/components/orders`, `src/lib/orders`, migration `20261012000100_order_management.sql` | Status transitions, detail edits, scheduling (date range + time window), direct orders, history. **Loads per order, trucks and drivers** come with dispatch (N4). No order PDF / confirmation email yet. |
| Scheduling and dispatch | ✅ day board (N4, see §5c) | `src/app/(app)/dispatch`, `src/components/dispatch`, `src/lib/dispatch`, migration `20261014000100_dispatch_assignments.sql` | Loads per order with explicit times, assignments with eligibility and database-enforced no double-booking, history. No week view, notifications or derived order status. |
| Trucks, trailers, drivers, qualifications | ✅ (N3, see §5b) | `src/app/(app)/fleet`, `src/components/fleet`, `src/lib/fleet`, migration `20261013000100_fleet_registry.sql` | Registry, service status with history, qualifications with expiry, dispatch-readiness rules. No maintenance, odometer, documents/photos or PTO yet. |
| Delivery tickets and documents | ✅ office entry (N5, see §5d) | `src/app/(app)/tickets`, `src/components/tickets`, `src/lib/tickets`, migration `20261015000100_delivery_tickets.sql` | Numbered tickets with revisions, review and void history. **No file storage**, photos, signatures, printing or driver entry. |
| Reconciliation and billing-ready records | ✅ first version (N6, see §5e) | `src/app/(app)/billing`, `src/components/billing`, `src/lib/billing`, migration `20261016000100_billing_readiness.sql` | Derived readiness, exception acknowledgments, handoff batches with a CSV file. **No invoices, payments, tax, AR or QuickBooks sync**; the CSV is not a QuickBooks import format. No quantity tolerance setting yet (exact match). |
| Reports and management dashboard | 🟡 / 🧱 | `src/app/(app)/dashboard`, `src/app/(app)/reports` | The dashboard shows real quote figures and the real "orders scheduled today" count; the other operations cards are placeholders. Reports is a placeholder. |
| Route planner / map | 🧱 | `src/app/(app)/route-planner/page.tsx` | No provider has been selected. `customer_sites` has latitude/longitude columns that are never filled. |
| Fleet maintenance | ❌ | — | — |
| Employee / driver portal, qualifications, PTO, announcements, incidents | ❌ | — | The `driver` role exists but has no permissions. |
| Supplier price imports and price history | ❌ | — | — |
| Operational exceptions queue | ❌ | — | The dashboard flags overdue and follow-up quotes only. |
| AI assistant / smart dispatch | ❌ | — | — |
| Multi-tenant isolation | ✅ (B1, 2026-10-11) | `companies`, `company_memberships`, `company_id` on 22 tables, migration `20261011000200_company_separation.sql`, `tests/db/tenancy.test.ts`, `tests/e2e/tenancy.spec.ts` | No self-serve sign-up, company switcher, per-company branding (sidebar logo is still Top Line's) or billing. |
| Audit log | ✅ per company | `audit_events.company_id`, Settings → Audit log | — |
| Sample data handling | ✅ | `is_sample`, `remove_sample_data()` | — |
| Local dev stack | 🟡 | `scripts/dev-stack` | No Supabase Storage. The `supabase start` path (Docker) has never been run. |
| Hosted deployment | ❌ unverified | `docs/SETUP.md` | `supabase db push` to a real project has never been run. Backup and restore have never been tested. |

---

## 2. Security and data-integrity findings

Fix these before building broad new features. Severity reflects the multi-tenant
SaaS goal.

| # | Severity | Finding | Evidence | Action |
| --- | --- | --- | --- | --- |
| S1 | ✅ Resolved (B1) | No tenant boundary. | — | `company_id` on every business table; per-company settings, numbering, grants, units and uniqueness; RLS rewritten. Proven by `tests/db/tenancy.test.ts`. |
| S2 | ✅ Resolved (B1) | `SECURITY DEFINER` functions bypassed RLS and looked rows up by id only. | 35 definer functions after B1. | Every public definer function resolves the company itself and filters every lookup by it; none accepts a company id; internal helpers are not executable by app users. Each public RPC is tested with another company's ids. A test fails if an unreviewed definer function is added. |
| S3 | ✅ Resolved (B1) | Single-column foreign keys allowed cross-company links. | — | Composite `(company_id, …)` FKs on all business relations; tested even as the database owner. |
| S4 | ✅ Resolved (B1) | Staff directory exposed every email. | — | `user_directory()` lists only the caller's company; emails only with `users.manage`. |
| S5 | ✅ Resolved (B1) | RLS helpers evaluated per row. | — | All policies use `(select private.current_company_id())` / `(select private.has_permission(…))`. |
| S6 | ✅ Partly (B1) | Fixed role enum, no mechanic. | — | `mechanic` added (no permissions yet). Per-company custom roles remain a Phase 6 decision. |
| S7 | Medium | No file storage exists, and the local dev stack has no Storage service. Maintenance photos, ticket scans and onboarding documents all need it. | `storage` schema absent; no storage calls in `src`. | Before the first upload feature: create tenant-scoped buckets (paths prefixed by `company_id`) with Storage RLS. Run Supabase Storage in the dev stack or switch tests to the Supabase CLI. |
| S8 | Medium | The browser tests are not in CI, and the hosted-Supabase path is unverified (`db push`, auth email templates, SMTP). | `.github/workflows/ci.yml`; docs/SETUP.md "not yet verified". | Add an e2e job to CI. Do a one-time staging deployment before real data is entered. |
| S9 | Low | PDFs for sample quotes look like real quotes when printed. | `src/lib/quotes/document.ts` has no `is_sample` input. | Add a "SAMPLE — not a real quote" watermark. |
| S10 | Low | No application-level rate limiting on expensive actions (email send, PDF render). Supabase rate-limits sign-in only. | `sendQuoteEmail`, PDF route. | Add a simple per-user limit before external customers. |
| S11 | Process | Backup and restore are documented but have never been tested. | `docs/BACKUP_RESTORE.md`. | Test a restore once a staging project exists. |

What is already in good shape and should not change: deny-by-default grants;
writes through validated database functions; immutable issued revisions and
append-only history tables; idempotent conversion; server-side checks plus RLS;
service-role use limited to invitations (`src/app/(app)/settings/actions.ts`).

---

## 3. Architecture decisions

### Existing decisions (kept)

| Topic | Decision |
| --- | --- |
| Stack | One Next.js (App Router, TypeScript strict) app + Supabase (PostgreSQL, Auth). No microservices. `cacheComponents` off; every operational page renders per request. |
| Authorization | Permission checked in the page/action (`src/server/auth.ts`), again in RLS / definer functions, and quote/order tables have no client write grants. One permission catalog drives RLS, functions and UI. |
| Money | Integer cents; quantities `numeric(12,3)`; database-authoritative totals with a TypeScript mirror proven equal by tests. |
| Quote versions | Header → revisions → lines with pricing snapshots; issued revisions immutable; revising creates a new revision. |
| Orders | Copy the accepted revision; one order per quote; initial status **Confirmed**; converted quotes' status frozen. |
| Pricing authority | Rate overrides and discounts require `pricing.override` (owner only — confirmed). Applies to quotes now and to order edits when they exist. |
| Numbering | Row-locked `document_sequences`, configurable format. |
| PDF / email | PDFs rendered from stored revision data. Email has preview / test / live modes and never claims a send that did not happen. |
| Timezone | `timestamptz`, displayed in the business timezone (default America/Chicago). |
| Sample data | `is_sample` + SAMPLE badge + owner removal. |
| Maps / routing / AI | Provider interfaces only; never show fabricated routes, times or AI results as real. |

### New decisions for the expanded vision

| Topic | Decision |
| --- | --- |
| Tenancy model | Shared database, shared schema, `company_id uuid not null` on every business table. Isolation is enforced in RLS **and** in every definer function, with composite FKs for core relations. Top Line becomes company #1 via backfill migration. No subscription billing or self-serve onboarding yet. |
| Memberships | New `companies` and `company_memberships (company_id, user_id, role, active)`. `profiles` keeps personal fields only. A user's active company is resolved server-side; a user with one membership needs no switcher. |
| Global vs company data | Global: the permission catalog and default role grants. Per company: settings, numbering, role grants, units (seeded from a global default set), all business data, audit events, files. |
| Files | Supabase Storage with object paths `<company_id>/<area>/<record_id>/…`, private buckets, signed URLs, policies keyed on membership. |
| Deterministic rules vs AI | Eligibility and feasibility checks (driver qualified, truck in service, PTO, capacity, time windows) are plain SQL/TypeScript rules with tests. AI may only *suggest*; every consequential change goes through the same permission-checked functions with human approval and audit. |
| Availability vocabulary | **Available** = no PTO and not out of service. **Eligible** = also meets the job's requirements (qualification, equipment type, capacity). **Feasible** = also fits the schedule, travel and loading time. The UI and the rules use these three words consistently. |
| Cost snapshots | Quote lines will snapshot cost assumptions next to prices, so later supplier price changes never alter prepared quotes or accepted orders. |
| Exceptions | One `operational_exceptions` table (type, severity, status, owner, due date, source record, `confirmed` vs `potential`). Generated by deterministic checks, never invented. |

### Assumptions that affect the data model (updated)

1. ~~One company.~~ **Multiple companies, strictly isolated** (Top Line first).
2. A quote belongs to one customer for its life; contact, site, lines and terms may change between revisions.
3. USD in cents; unit rates in whole cents.
4. One configurable sales-tax rate per quote; customers can be tax-exempt.
5. Percent lines are calculated on the sum of non-discount per-unit lines.
6. Prices are optional. A rate that differs from a configured price is an override and needs `pricing.override` (owner only), as do discounts.
7. Overdue quotes are flagged, not expired automatically.
8. Default business timezone America/Chicago (configurable per company).
9. QuickBooks remains the accounting system of record; Desktop vs Online is still to be confirmed.

---

## 4. Roadmap

### 4.1 Immediate blockers (Phase 1 — stabilize the foundation)

| Order | Task | Concrete steps | Done when |
| --- | --- | --- | --- |
| ~~B1~~ | ✅ **Tenant foundation — done** (§5) | Migrations `20261011000100_mechanic_role.sql`, `20261011000200_company_separation.sql`. | 17 database isolation tests + 1 browser isolation test pass; all previous tests pass. |
| ~~B2~~ | ✅ Done inside B1 | S4–S6. | Covered by B1 tests. |
| B3 | Staging deployment | Create a Supabase staging project; `supabase db push`; configure auth URLs, email templates and SMTP; deploy the app; send a real reset email and a real test quote email (test mode). | SETUP.md steps verified and corrected; S8 hosted part closed. |
| B4 | CI completeness | Add an e2e job (dev stack + `next build && next start` + Playwright). | e2e green in CI. |
| B5 | Backup / restore drill | Follow docs/BACKUP_RESTORE.md against staging. | Restore time recorded. |
| B6 | Sample PDF watermark (S9) | Pass `is_sample` into `buildQuoteDocument`; watermark in the HTML preview and the PDF. | Unit test. |

### 4.2 Next features (Phase 2 — essential end-to-end workflow)

These build on B1 and are listed in dependency order.

| # | Feature | Current state | Builds on | Concrete next steps | Risks |
| --- | --- | --- | --- | --- | --- |
| N1 ✅ | Order lifecycle | Done (§5a) — loads per order move to N4 | `orders`, `order_status_events` | `set_order_status()` with a transition table (Confirmed → Scheduled → Dispatched → In progress → Partially completed / Completed; On hold; Canceled), reasons, history; delivery window / requested dates; loads planned per order. | Keep status in sync with assignments and tickets (derive where possible). |
| N2 ✅ | Direct orders | Done (§5a) | Quote editor + `save_quote_draft` pricing rules | `save_order_draft()` reusing the price resolution and override checks; editor component shared with quotes. | Do not fork the pricing rules — reuse them. |
| N3 ✅ | Fleet registry (minimal) | Done (§5b) | — | `trucks`, `trailers`, `drivers` (linked to memberships), equipment type, verified capacity, `service_status` (in service / out of service with reason). | Never assume capacities; leave them blank until verified. |
| N4 ✅ | Dispatch assignments | Done (§5c) — day board | N1, N3 | `dispatch_assignments (order, date, load #, truck, trailer, driver, planned qty/unit, status)`; a day/week board; conflict rules: double-booking, out-of-service equipment, driver unavailable; keyboard-accessible editing. | Concurrency: use DB exclusion/uniqueness to prevent double-booking. |
| N5 ✅ | Delivery tickets | Done (§5d) — office entry from paper; storage, printing and signatures later | N4, storage (S7) | `delivery_tickets` numbered via `document_sequences('ticket')`, revisions, print layouts (full and half page), planned vs actual quantity, signature/photo upload, printed status. | Ticket immutability once reviewed, like quote revisions. |
| N6 ✅ | Reconciliation and billing-ready records | Done (§5e) — derived readiness, acknowledgments, handoff batches + CSV | N5 | Review queue: awaiting data / awaiting review / missing info / ready for billing; price-change flags vs order; billing export (CSV) with idempotent export batches. | No invoices or QuickBooks posting until an integration is approved. |
| N7 | Operations dashboard | Placeholder cards | N1–N6 | Replace the placeholder cards with real counts as each module lands. | — |

### 4.3 Phase 3 — fleet and employee operations

| Feature | First steps | Dependencies |
| --- | --- | --- |
| Maintenance requests (driver-submitted, photos) | `maintenance_requests` + storage; driver portal form | B1, S7, N3 |
| Work orders, parts, labor, history | `work_orders`, `work_order_lines`; mechanic role | Maintenance requests |
| Service schedules and reminders (date / mileage / engine hours) | `service_schedules`, odometer and hour readings; nightly reminder job | N3; background job runner (none exists — choose Supabase cron / pg_cron or a scheduled route) |
| Out-of-service enforcement and clearance | ✅ status changes only through `set_equipment_service_status()` (`fleet.service`), reason required, append-only history; eligibility refuses out-of-service equipment. Remaining: dispatch must call the rule (N4). | N3, N4 |
| Driver qualifications, licenses, training, expirations | ✅ CDL / medical card / hazmat / TWIC / other with expiry and verification; eligibility rule ready for dispatch. Remaining: training records, document uploads, reminder notifications. | N3 |
| PTO and availability | `time_off_requests` (request → approve), availability calendar feeding dispatch "available" | N4 |
| Announcements, directory, onboarding documents, safety and incident reports | Tables + storage; employee portal pages | B1, S7 |
| Responsive driver portal | Role-specific layout: today's assignments, submit ticket, report delay/breakdown, upload documents | N4, N5 |

### 4.4 Future opportunities (Phases 4–6)

- **Phase 4 — supplier pricing and profitability.** Suppliers and supplier price lists with history. CSV/Excel import that is staged, diffed and reviewed before it is applied. Cost snapshot columns on quote and order lines (add the columns early, ideally with N2, so history starts accumulating). Flag unsent quotes affected by cost changes. An `operational_exceptions` queue covering missing tickets, unbilled work, duplicate-ticket candidates, overdue maintenance, expiring qualifications, dispatch conflicts and cost changes. Estimated vs actual margins once tickets carry actuals.
- **Phase 5 — smarter dispatch and AI.** Routing provider evaluation (heavy-truck routing, pricing, terms). A map planner. A deterministic eligibility/feasibility engine with explanations. Recommendation runs logged with inputs and approvals. An AI assistant answering from permission-scoped queries, with citations to records, that proposes actions but never executes them without approval. Recurring orders. A customer portal.
- **Phase 6 — commercial SaaS.** Company onboarding, branding per company, per-company custom roles, usage limits and rate limiting, data export / deletion per company, subscription billing — only after validation with real customers.

---

## 5. Tenant foundation (B1) — completed 2026-10-11

**What changed**
- `companies`, `company_memberships` (role + active per company; replaces
  `profiles.role/active`), `profiles.active_company_id`, `role_permission_defaults`.
- `company_id` on 22 tables (21 existing business tables + memberships); existing
  rows assigned to Top Line Trucking (`00000000-0000-4000-8000-000000000001`) by a
  constant column default (no row triggers fired, no row rewritten by UPDATE).
- Per company: settings (`company_settings` PK `company_id`), numbering
  (`document_sequences` PK `(company_id, key)`), role grants, units (PK
  `(company_id, code)`), one standard price list, and uniqueness of
  customer/quote/order numbers and material/charge/price-list names and codes.
- Composite same-company foreign keys on every business relation; `company_id`
  immutable (`a_company_guard` trigger on 22 tables).
- All 42 RLS policies replaced by company-scoped policies (now 45 across all 26
  tables) using the once-per-statement `(select …)` form.
- All 30 pre-existing `SECURITY DEFINER` functions reviewed; 25 rewritten to resolve
  and verify the company; 5 unchanged because they only act on rows already
  verified by their caller or on the triggering row (`issue_quote_version`
  wrapper around the verified `issue_current_version`, `recompute_quote_totals`,
  `stamp_updated_by`, `require_permission`, `handle_new_auth_user`). 5 new definer
  functions (`current_company_id`, `require_company`, `is_company_member`,
  `create_company`, `add_company_member`) — 35 in total.
- `mechanic` role; staff directory limited to the company, emails only for user managers.
- App: `getAccess()` carries the company (shown in the header); settings save,
  user list and invitations scoped to the company; `create-owner.mjs` takes a
  company slug; seed data names Top Line explicitly.
- Safety: one transaction; a verification block compares row counts, ownership
  and quote totals and aborts on any mismatch. Applied to the existing dev
  database without reset (pre-migration counts: 4 customers, 3 quotes, 3 versions,
  7 lines, 1 order, 66 audit events, 2 profiles — identical afterwards, all owned
  by Top Line). The migrated database's schema is identical to a fresh build from
  the migration files.

**Tests**: `tests/db/tenancy.test.ts` (17 tests) — schema guards (RLS on every
table, `company_id` on every business table, reviewed list of definer
functions, no caller-supplied company ids, internal functions not callable);
reads across all 22 tables and both views in both directions; refused inserts,
updates, deletes and company moves; cross-company references refused by RLS and by
composite FKs even for the database owner; every public quote/order RPC called
with another company's ids; user/permission administration; per-company sample
data, settings, numbering and name reuse; inactive memberships/companies,
pending users and users in two companies; per-company audit. Browser:
`tests/e2e/tenancy.spec.ts` — a second company's owner sees no Top Line
customers, quotes, materials or users, and gets "Not found" / HTTP 404 for Top
Line customer, quote and PDF URLs.

**Remaining risks and limits**
- Not yet applied to a hosted Supabase project (B3). The migration needs Postgres
  15+ (`ON DELETE SET NULL (column)`); Supabase provides 15/17.
- The app version and the migration must be deployed together (the old app reads
  `profiles.role`).
- `add_company_member()` lets a company's owner add any existing account id to
  their own company. That grants the account access to that company only — never
  another company's data, and it cannot rename them — but ids should still be
  treated as non-public.
- No company switcher UI for people in several companies (selection is
  `profiles.active_company_id`, set by an operator).
- Branding: the sidebar logo is still Top Line's for every company.
- No Storage or background jobs exist yet; their tenant rules are documented
  (ARCHITECTURE.md → Companies) and must be implemented with the first feature
  that needs them.

## 5a. Order management (N1 + N2) — completed

Migration `20261012000100_order_management.sql` (additive; existing orders are
backfilled, nothing is deleted; a verification block aborts if any quote-linked
order's totals differ from its accepted revision).

**Status rules** (`private.order_transition_allowed`, mirrored in
`src/lib/orders/status.ts`, parity-tested over all 81 pairs):

| From | To | Permission | Requirement |
| --- | --- | --- | --- |
| Draft | Confirmed | `orders.edit` | at least one line |
| Draft | Canceled | `orders.edit` | reason |
| Confirmed | Scheduled · On hold · Canceled | `orders.schedule` (cancel: `orders.edit`) | Scheduled needs a scheduled date; hold/cancel need a reason |
| Scheduled | Dispatched · In progress · Confirmed (unschedule) · On hold · Canceled | `orders.schedule` (cancel: `orders.edit`) | — |
| Dispatched | In progress · Scheduled (recall) · On hold · Canceled | `orders.schedule` (cancel: `orders.edit`) | — |
| In progress | Completed · Partially completed · On hold | `orders.schedule` | — |
| Partially completed | Completed · In progress · On hold | `orders.schedule` | — |
| On hold | Confirmed · Scheduled · Canceled | `orders.schedule` (cancel: `orders.edit`) | — |
| Completed, Canceled | — (final) | | |

**What changed**
- New permission `orders.schedule` (owner, office, dispatcher). Dispatchers can
  schedule and move work along; they cannot create, edit, confirm or cancel.
- `orders`: `contact_id`, `order_date`, `requested_date`, `scheduled_start` /
  `scheduled_end`, `window_start` / `window_end`, `scheduling_notes`, `edit_seq`
  (optimistic concurrency), `confirmed_at`, `completed_at`, `canceled_at`,
  `updated_by`.
- `save_order_draft()` — direct orders priced with exactly the quote rules
  (customer list → standard list → manual; overrides and discounts need
  `pricing.override`) on the order date. Editable only while Draft.
- `update_order_details()` (contact, job site, project, PO, instructions, notes,
  requested date) for any open order; `update_order_schedule()`;
  `set_order_status()`. All resolve the caller's company and verify every
  referenced customer, contact, site, material, charge and unit belongs to it.
- Pricing protection by triggers (holds even for the database owner): lines,
  prices, totals, tax, terms and customer of an order change only while it is a
  **direct order in Draft**; order number and source quote never change.
  Quote-linked orders keep the accepted prices forever.
- `convert_quote_to_order()` keeps its lock + unique-index idempotency; it now also
  records the contact, order date and confirmation time.
- History: every edit is audited with a field-by-field diff; status events as
  before. People with `orders.view` can read the audit entries **of orders only**
  (new policy `audit_read_orders`); the full log still needs `audit.view`.
- `effective_prices()` is also available to `orders.edit` (direct-order editor).
- `remove_sample_data()` also removes direct orders of sample customers.
- UI: order list with search (incl. contact and material), quick filters (open,
  scheduled today, next 7 days, not scheduled, drafts, on hold), status/source/
  schedule filters, delivery column with "requested date passed" flags; `/orders/new`
  (the quote editor in order mode); `/orders/[id]/edit` (full editor for drafts,
  details form otherwise); detail page with status actions, schedule dialog,
  source quote, timeline; dashboard "Orders scheduled today" is real.

**Tests**: `tests/db/order-management.test.ts` (18): status parity; direct-order
pricing parity with the TypeScript calculator; override/discount refusal;
invalid data; draft edits vs locked lines (also for the database owner);
quote-linked edits leaving quote and prices untouched; idempotent conversion;
the full lifecycle with timestamps, events and audit diffs; transition
requirements and conflicts; dispatcher / mechanic / driver / pending
permissions; order-history visibility; a second company refused for every
reference and every order function. `tests/unit/order-rules.test.ts` (11).
Browser: `tests/e2e/orders.spec.ts` (direct order → confirm → schedule →
dispatch → start → complete; dispatcher cannot create) and the quote-conversion
flow now edits the converted order's details.

**Remaining limits**
- No loads, trucks or drivers per order (N4). Status is set by people; once
  dispatch and tickets exist, derive it from them where possible.
- No order confirmation PDF or email; no order duplication.
- Direct orders start with empty terms (the default quote terms mention a quote
  expiration). A per-company default for order terms is a small follow-up.
- An order's customer cannot change after confirmation; cancel and re-create.

## 5b. Fleet registry (N3) — completed

Migration `20261013000100_fleet_registry.sql` (additive: new types, tables,
functions, policies and permissions only; no existing row is changed).

**What was added**
- Permissions `fleet.view` (owner, office, dispatcher, mechanic), `fleet.edit`
  (owner, office), `fleet.service` (owner, office, mechanic).
- `trucks` and `trailers`: unit number unique per company (case- and
  space-insensitive), type, make/model/year, VIN (validated), plate, weight
  capacity with an explicit unit (tons or pounds) and body volume in cubic yards
  — each `NULL` = unknown — capacity source, `capacity_verified_at/by` stamped by
  the database, active flag, service status. Trailers add compatible truck types
  (empty = not recorded), compatibility notes and the usual truck (same company,
  composite FK); a trailer's status is independent of its truck.
- `equipment_status_events` (append-only). Service columns cannot be written by
  clients (column grants); `set_equipment_service_status()` requires
  `fleet.service`, a reason to go out of service, and records the history.
- `drivers` linked optionally to a company member (`company_memberships`, composite
  FK — no duplicate identity; the name comes from the account), or with their own
  name; employee number unique per company. `driver_list` view (name resolved by
  `private.member_summary`, which only answers for the caller's own company).
- `driver_qualifications`: CDL (class A/B/C, endorsements), DOT medical card,
  hazmat, TWIC, other; issuing state, issue and expiry dates (`NULL` = unknown),
  verification stamped by the database and cleared when the document details
  change. License numbers are deliberately not stored.
- Audit triggers on all fleet tables; people with `fleet.view` can read fleet
  audit entries (policy `audit_read_fleet`), as with orders.

**Dispatch readiness** (`public.check_assignment_eligibility`, mirrored by
`src/lib/fleet/eligibility.ts`, parity-tested on 20 scenarios):
- *active* = not deactivated; *available* = active and (equipment) in service;
  *eligible* = available, trailer compatible with the truck type, and the driver
  has a **verified, unexpired** CDL of the required class (A with a trailer,
  otherwise B or A) and a **verified, unexpired** medical card on the date.
- Missing, expired, unverified or undated qualifications block; unknown
  capacity, unverified capacity, unrecorded compatibility and expiries within 30
  days are warnings.

**UI**: Fleet area with Overview (counts, out-of-service list, drivers needing
attention, expiring qualifications, a "check a combination" tool), Trucks,
Trailers and Drivers lists with search, status/type filters and empty states;
detail pages with status, capacity (explicit Unknown / Not verified), history;
create/edit forms; out-of-service dialog with reason; qualification editor. The
dashboard's fleet card is real.

**Tests**: `tests/db/fleet.test.ts` (9): CRUD and audit, unit-number uniqueness,
capacity units and validation, verification stamping, service-status rules and
history, trailer independence, driver identity linking, qualification rules,
role permissions (office, dispatcher, mechanic, driver, pending, anonymous),
eligibility parity, company isolation (reads, writes, cross-company references,
functions). `tests/unit/fleet-rules.test.ts` (10). Browser:
`tests/e2e/fleet.spec.ts` (3). Tenancy guards updated (27 business tables, 46
reviewed definer functions).

**Remaining limits**
- The CDL class rule (B for a truck, A with a trailer) is a conservative default,
  not configured per truck; a per-truck "CDL class required" setting may be
  needed (e.g. non-CDL single-axle trucks).
- No maintenance/work orders, odometer or engine hours, inspection records,
  document or photo uploads (needs Storage, S7), driver availability/PTO, or
  expiry notifications (needs a background job runner).
- No truck–trailer pairing history; "usually paired with" is a single link.
- Eligibility is checked on demand; dispatch (N4) must call it when assigning.

## 5c. Dispatch assignments (N4) — completed

### Data model decision

**What existed** (inspected before building): orders have a scheduled *date
range* (`scheduled_start`/`scheduled_end`) and an optional *daily time window*
(`window_start`/`window_end`, times without a date or timezone). Order lines
carry priced quantities ("22.5 tons", "4 loads" as a pricing unit), but there was
**no load or trip entity** and no per-truck start/end time, so neither "loads per
order" nor overlapping bookings could be expressed.

**Smallest sound extension** (migration `20261014000100_dispatch_assignments.sql`):

- `order_loads` — a planned trip for an order on one day: `load_number` (1, 2, 3…
  per order), `load_date`, `start_time`, `end_time` (local business time; the
  database derives `starts_at`/`ends_at` in the company's timezone), optional
  planned quantity + unit (company units; never derived or assumed), notes,
  status `planned` / `canceled`. A load must fall within the order's scheduled
  date range, and the order must be Scheduled, Dispatched, In progress or
  Partially completed. Times default to the order's window in the UI.
  Same-day only (end after start).
- `dispatch_assignments` — one truck, optional trailer, and one driver for one
  load, with the load's interval copied in. `active` or `canceled`; rows are
  never deleted or rewritten. Reassigning cancels the active row ("Reassigned")
  and inserts a new one linked by `replaces_assignment_id`. At most one active
  assignment per load.
- **Overlap** = half-open intervals `[starts_at, ends_at)` intersect for the same
  truck, trailer or driver among active assignments (back-to-back is allowed).
  Enforced by `EXCLUDE USING gist` constraints, so concurrent requests cannot
  double-book; the functions also pre-check to name the conflicting load.
- **Eligibility** reuses the fleet rules (`private.assignment_eligibility`, the
  body of `check_assignment_eligibility`) on the load's date. A tractor requires
  a trailer. Blockers refuse the assignment; warnings are stored on it.
- Order changes: when an order is canceled, put on hold or moved back to
  Confirmed, its active assignments that have not ended are canceled
  automatically (and loads canceled with the order); history is kept.
- Permissions: `dispatch.view`, `dispatch.edit` (owner, office, dispatcher).

### What was built (N4)

- Migration `20261014000100_dispatch_assignments.sql` (additive; enables the
  `btree_gist` extension in the `extensions` schema; no existing row changed).
  Reversal: drop `dispatch_assignments`, `order_loads`, their types, the
  functions and the `orders_release_assignments` trigger added there, and the
  `dispatch.*` permissions.
- Functions: `save_order_load`, `cancel_order_load`, `assign_load` (assign or
  reassign; optimistic check on the current assignment), `cancel_assignment`.
  `check_assignment_eligibility` now delegates to `private.assignment_eligibility`
  (same rules, shared by dispatch). Eligibility failures raise "Not eligible on
  …: <reasons>"; conflicts raise "Truck 101 is already assigned to O-… load 2 from
  7:00 AM to 9:00 AM."; a booking lost to a concurrent request raises a PT409
  "was just assigned … Reload the board".
- Audit: every plan/change/cancel/assign/reassign/unassign/release is logged on
  the order, so it appears in the order's history. Assignment rows are immutable
  except for cancellation (trigger), and are never deleted.
- UI: `/dispatch` day board (previous / today / next / date picker; counts),
  order cards with customer, site, window, PO, materials, loads and their
  assignments, inline history of earlier assignments; add / edit / cancel load,
  assign / reassign / remove with reason; resource panel of trucks and drivers
  for the day. The assign dialog groups each list into *Available*, *Already
  assigned at this time* and *Unavailable* and previews the server's verdict.
  The order page shows its loads; the dashboard shows loads needing a truck.
- Tests: `tests/db/dispatch.test.ts` (9, incl. a two-connection concurrent
  double-booking test and SQL/TS message parity), `tests/unit/dispatch-board.test.ts`
  (6), `tests/e2e/dispatch.spec.ts` (2); tenancy guards updated (29 business
  tables, 56 reviewed definer functions).

### Remaining limits (N4)

- Day view only (no week view or drag-and-drop); loads are same-day (no
  overnight work); no multi-load "repeat N times" shortcut.
- Planned quantity per load is informational; it is not checked against truck
  capacity or the order's line quantities (capacities are often unknown).
- Order status is not derived from assignments (marking Dispatched / In
  progress stays manual); assignments do not notify drivers.
- Changing an order's dates does not move its loads; loads outside the new
  dates are flagged on the board.
- Driver availability/PTO does not exist yet, so "available" means eligible and
  not booked.

## 5d. Delivery tickets (N5) — completed

### Plan (written before building)

**Inspected first.** Loads (`order_loads`) carry an optional planned quantity +
unit; assignments are immutable rows (reassign = cancel + insert). Order lines
store `quantity numeric(12,3)` with a company `unit_code` (`ton`, `load`,
`cu_yd`, `hour`, `mile`, `day`, `each`); materials have a default unit. No unit
conversions exist anywhere and none are added. A per-company `ticket` document
sequence (`T-2026-00001`) already exists and is allocated under a row lock.

**Model** (migration `20261015000100_delivery_tickets.sql`, additive):

- `delivery_tickets`: one row per *revision*. `ticket_number` is stable across
  revisions; a correction inserts revision n+1 (`supersedes_id`) and marks the
  previous row `superseded` — nothing is overwritten. Exactly one current
  (non-superseded) revision per number (partial unique index).
- References (all composite, same company): order, load, the assignment active
  at submission, the order line delivered (material from it), truck, trailer,
  driver, unit. **Snapshot** (order/load numbers, customer, line description,
  truck/trailer unit numbers, driver name, planned quantity) so later
  reassignment or renaming never changes the record.
- Actual `delivered_at`, `quantity` + explicit `unit_code` (no default; >0, ≤3
  decimals, whole numbers for `load` and `each`), external paper/scale ticket
  reference, notes.
- Status: `submitted` → `accepted` (office review), `needs_review` (flagged
  automatically or by a reviewer), `voided` (reason required), `superseded`
  (replaced by a correction). Automatic review reasons: unit differs from the
  order line's unit (no conversion), delivered on another day than planned,
  truck/driver differ from the assignment, no external reference, a second
  ticket for the same load, a reused external reference.
- Duplicate safeguards: a per-submission idempotency key (unique; a repeated
  submit returns the same ticket) and an explicit confirmation for a second
  ticket on the same load or a reused external reference (multiple tickets per
  load are allowed — e.g. split loads — but never by accident).
- `delivery_ticket_events`: append-only history (submitted, flagged, accepted,
  voided, corrected) with actor and note; events also go to the order history.
- Rules: the load must be planned (not canceled) and have an active assignment;
  the order must be Scheduled, Dispatched, In progress, Partially completed or
  Completed. A load with live tickets cannot be canceled. Tickets never change
  order status, pricing or billing.
- Permissions: `tickets.view` (owner, office, dispatcher), `tickets.edit`
  (create and correct non-accepted tickets: owner, office, dispatcher),
  `tickets.review` (accept, flag, void, correct accepted tickets: owner,
  office). Writes only through `SECURITY DEFINER` functions.

**UI**: `/tickets` (loads awaiting tickets, needs review, submitted, accepted,
voided, search), new-ticket form from a load, ticket page with history and
correction/void/accept actions; ticket status on the dispatch board and order
page. Out of scope: files/photos/signatures/OCR, driver portal, billing.

### What was built (N5)

- Migration `20261015000100_delivery_tickets.sql` (additive): `delivery_tickets`,
  `delivery_ticket_events`, `ticket_status`, permissions, a `(company_id, id)` key
  on `order_lines`, `submit_delivery_ticket`, `correct_delivery_ticket`,
  `review_delivery_ticket`, `private.prepare_ticket` (all validation and review
  flags in one place), a guard that keeps revisions immutable, a guard that
  stops canceling a load (or its order) with live tickets, and
  `prevent_modification` extended so the sample purge can remove ticket events.
- Numbers come from the existing per-company `ticket` sequence; two concurrent
  submissions get consecutive numbers (tested with two connections).
- Duplicate protection: per-form idempotency key (unique), explicit confirmation
  (error `PT422` → confirmation box) for a second ticket on a load or a reused
  paper/scale number; concurrent submissions on the same load are serialized by
  a row lock on the load.
- A correction falls back to the assignment the ticket was recorded against if
  the load has none any more, so a later unassignment never blocks a correction.
- UI: `/tickets` (loads awaiting a ticket, needs review, submitted, accepted,
  voided, all; search), `/tickets/new?load=…`, `/tickets/[id]` (delivery,
  review flags, revisions, history, accept / flag / void / correct),
  `/tickets/[id]/correct`; ticket status and an "Enter delivery ticket" link on
  the dispatch board; tickets per load on the order page; dashboard card.
- Tests: `tests/db/tickets.test.ts` (12), `tests/unit/ticket-rules.test.ts` (4),
  `tests/e2e/tickets.spec.ts` (2); tenancy guards updated (31 business tables,
  60 reviewed definer functions).

### Remaining limits (N5)

- Entered by the office from paper; no file storage, photos, signatures, OCR or
  driver portal. No printable ticket layout yet.
- One quantity per ticket (one order line). A load carrying two materials needs
  two tickets (confirmed as separate deliveries) — a multi-line ticket may be
  wanted later.
- Quantities are never compared across units; reconciliation of delivered vs
  ordered quantities, billing readiness and QuickBooks are not started.
- A reused paper ticket number on two *different* loads submitted at the same
  instant is not serialized (each is flagged only if it sees the other).
- Tickets do not move order status (Dispatched / Completed stays manual).

## 5e. Ticket reconciliation and billing readiness (N6) — first version

### Plan (written before building)

**Inspected first.** Order statuses: draft, confirmed, scheduled, dispatched,
in_progress, partially_completed, completed, on_hold, canceled (Completed and
Canceled are final). Ticket states: submitted, needs_review, accepted, voided,
superseded (one current revision per number). Loads carry an optional planned
quantity + unit; order lines carry `quantity numeric(12,3)` + `unit_code` and
locked accepted prices (`order_lines_guard`). Company units: ton, load, cu_yd,
hour, mile, day, each — no conversions anywhere. No billing, export or
accounting fields existed; Reports was a placeholder promising "billing exports",
and the dashboard had a placeholder "Deliveries ready for billing" card. Customers
have `po_required`.

**Model** (migration `20261016000100_billing_readiness.sql`, additive):

- *Derived, not stored*: views `billing_load_status`, `billing_line_status`,
  `billing_exceptions`, `billing_order_status` compute readiness from loads,
  assignments, order lines and current ticket revisions on every read, so no
  status can drift. The handoff function re-reads them under row locks.
- *Office decisions are the only stored state*: `billing_reviews`
  (acknowledgment with reason, bound to a fingerprint of the exact exceptions),
  `billing_handoffs` + `billing_handoff_orders` (batch, actor, time, reference,
  frozen snapshot, undo with reason). One active handoff per order (partial
  unique index), idempotency key per form.
- Permissions `billing.view`, `billing.manage` (owner, office). Writes only
  through definer functions; RLS read-only; audit on the order.

**Rules.**

- *Scope*: orders that are Scheduled, Dispatched, In progress, Partially
  completed or Completed. Draft / Confirmed (not scheduled), On hold and Canceled
  orders are out of scope; canceled loads are ignored (a load with live tickets
  cannot be canceled, so canceling never hides a delivery). Tickets of out-of-scope
  orders still appear in the Tickets review queue.
- *Missing ticket*: a planned load is **due** once its planned end time has passed
  or its order is Completed; a due load without a live (submitted / needs review /
  accepted) ticket is missing — also when its ticket was voided and not replaced.
  Future loads are never "missing". A Completed order without any ticket is
  missing documentation.
- *Review*: any live ticket not yet accepted blocks the order. Superseded
  revisions never count (only the current revision of each number).
- *Quantities* — exact-match policy, no invented tolerance: compared only when
  the expected quantity exists and the ticket units equal the expected unit.
  Load: planned vs the sum of its live tickets (no plan → "not compared", not an
  exception). Order line: ordered vs the sum of live tickets for the line, once
  the order is Completed (before that, deliveries are partial by nature). Any
  difference, a unit that cannot be compared, or a line with no ticket is an
  exception; nothing is converted or assumed zero.
- *Pricing / documentation*: a per-unit line with a $0.00 rate and a missing PO
  (customer requires one) are exceptions. Prices are only shown, never
  recalculated or changed.
- *Precedence*: handed off › missing documentation › needs review › blocked
  (exceptions without a current acknowledgment) › work not completed › ready.
- *Acknowledgment*: `billing.manage`, reason required, refused if the exceptions
  changed since the page was loaded; stops counting automatically when the
  exceptions change (fingerprint).
- *Handoff*: only `ready` orders; one batch number per submit; refuses orders
  already in an active handoff; never marks anything billed or paid and never
  changes the order. Corrections after a handoff are allowed (the ticket record
  stays the truth) and show "changed after handoff". Undo keeps the record.

**UI**: `/billing` (All orders with status and the reason + action, Missing
tickets, Tickets to review, Exceptions with acknowledgment, Ready to bill with
selection and handoff, Handed off batches with file download and undo; search,
service-date range, customer, status and exception filters), `/billing/orders/[id]`
(loads, lines, exceptions, decisions history), dashboard card, nav item.

### What was built (N6)

- Migration `20261016000100_billing_readiness.sql`: the four views, three tables
  with guards (batch: download counter only; handoff row: undo once;
  acknowledgments append-only), `acknowledge_billing_exceptions`,
  `hand_off_orders`, `revert_billing_handoff`, `record_billing_export`, the
  `billing` document sequence (`B-2026-0001`) for every company plus a trigger for
  new companies, permissions and RLS.
- `src/lib/billing/rules.ts`: labels, explanations ("why" + "what to do"), the
  quantity policy text and the handoff CSV builder (`tlt-billing-handoff-v1`,
  RFC 4180 quoting, spreadsheet-formula neutralization). CSV columns and their
  manual QuickBooks mapping are listed in docs/SCHEMA.md → Billing readiness.
- Pages: `/billing`, `/billing/orders/[id]`, `/billing/batches/[id]/csv`;
  dashboard "Orders ready to bill"; Billing in the navigation; Reports
  placeholder no longer promises the export.
- Tests: `tests/db/billing.test.ts` (10: missing / review / correction / void,
  out-of-scope orders, unit-safe comparisons, PO and zero rate, acknowledgment
  and invalidation, handoff with unchanged order and snapshot, undo and changed
  after handoff, permissions and isolation, two-connection concurrent handoff,
  SQL/TS parity), `tests/unit/billing-rules.test.ts` (6),
  `tests/e2e/billing.spec.ts` (2); tenancy guards updated (34 business tables,
  65 reviewed definer functions, billing views in the cross-company check).

### Remaining limits (N6)

- Exact-match quantities only; a per-company tolerance setting (explicit, off by
  default) would reduce acknowledgments on weighed loads.
- Handoff is per whole order, and only once it is Completed; no per-load partial
  billing of long-running orders.
- The CSV is a plain handoff list, **not** a QuickBooks import file; the mapping
  to QuickBooks fields is manual until Desktop vs Online is decided.
- No invoices, payments, tax calculation, AR, GL or QuickBooks sync.
- Lists are built from up to 2,000 open orders and filtered in the app; large
  companies will need server-side paging.
- Tickets corrected after a handoff are flagged, not blocked.

## Recommended next task

**B3 — staging deployment** (hosted Supabase, all 13 migrations via
`supabase db push`, auth email/SMTP, deploy, backup/restore drill). Then decide
QuickBooks Desktop vs Online and verify an import or API mapping against a test
company before adding any QuickBooks-specific export; and consider an explicit
per-company quantity tolerance for billing exceptions.

---

## 6. Completed work (history)

**Foundation:** scaffold; roles, permissions, profiles, settings, numbering,
audit; customers, contacts, sites; units, materials, charges, price lists; auth
(sign-in/out, reset, invite); app shell; settings (company, numbering, users,
permissions, email status, sample data, audit log).

**Quotes:** editor with decimal-safe live totals; database-authoritative totals
with override enforcement; sequential numbers; immutable issued revisions,
revision history; print preview and PDF; email with preview/test/live modes and
delivery records; statuses sent, accepted, declined, expired and canceled.

**Orders** (migration `20261010000600_orders.sql`): `orders`, `order_lines`,
`order_status_events`, `order_list`; `orders.view` / `orders.edit`; idempotent
`convert_quote_to_order()` copying the accepted revision (bill-to snapshot,
contact, site, PO, instructions, terms, tax, totals, every line incl. overrides
and discounts); initial status Confirmed; converted quotes frozen; orders list
and detail.

**Verified by tests:** money and quote math; status rules; document model; PDF
rendering; email provider retries and failures; error mapping; RLS for anon,
pending, inactive, dispatcher, office and owner; append-only audit; immutable
revisions; failed/preview/test email handling; override permission; concurrent
numbering and concurrent conversion; TypeScript ↔ database calculation parity;
sample-data removal; permission catalog parity; browser flows for auth,
permissions, customers, rates, the full quote lifecycle and order conversion.

**Known gaps carried forward:** real Resend delivery and Supabase auth emails
unverified; no automatic quote expiry (by design); no quote duplication.

---

## 7. Reference

### File structure

```
src/
  app/(auth)/                      sign-in, password reset
  app/auth/{confirm,callback}/     email-link handling
  app/(app)/                       authenticated shell
    dashboard/ customers/ quotes/ orders/ materials/ settings/       built
    dispatch/ route-planner/ tickets/ fleet/ reports/                placeholder pages ("not built yet")
    quotes/[id]/versions/[versionId]/pdf/route.ts                    PDF
  components/ui/ components/layout/ components/<module>/
  lib/                             pure logic (money, quote calc, status, document, schemas, permissions)
  server/                          server-only (auth guards, Supabase clients, data access, email, pdf)
supabase/migrations/               0100 foundation · 0200 customers & catalog · 0300 quotes ·
                                   0400 sample data · 0500 user directory · 0600 orders
supabase/seed.sql                  fictional sample data
scripts/dev-stack/                 local Postgres + Auth + PostgREST stack (no Storage)
tests/unit · tests/db · tests/e2e
```

### Environment variables / external accounts

| Variable | Needed for |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | everything |
| `SUPABASE_SERVICE_ROLE_KEY` | invitations, owner bootstrap (server only) |
| `APP_BASE_URL` | auth email links |
| `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `EMAIL_TEST_RECIPIENT` | quote email |

External accounts: Supabase (staging + production), Resend (verified domain),
a Next.js host. Later: a heavy-truck routing provider (evaluation pending);
QuickBooks (Desktop vs Online to be confirmed); possibly an LLM provider for the
assistant (Phase 5).
