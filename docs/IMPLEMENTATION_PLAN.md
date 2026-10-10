# Top Line Trucking Manager → Hauling Operating System — Implementation Plan

Top Line Trucking is the first customer. The long-term goal is a hauling
operating system that other trucking and hauling companies could also use.
This plan is grounded in an audit of the code as it exists (commit `a2a5f0b`,
audited 2026-10-10), updated after the tenant foundation (B1), order management (N1 + N2), the fleet registry (N3), dispatch assignments (N4), delivery tickets (N5) and the later milestones in §5e–§5j. The product's working name is Taviron (not final; set in `src/lib/product.ts`). The code, migrations and tests are the source of truth;
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
| Auth: sign-in, sign-out, reset, invite, no-access, early-access sign-up | ✅ locally (hosted email 🟡) (N9, see §5i) | `src/app/(auth)`, `src/app/onboarding`, `src/proxy.ts`, `src/server/auth.ts`, `scripts/early-access.mjs` | Verification, invitation and reset emails are sent by Supabase Auth and tested end to end with the local mail catcher. Not yet delivered by a hosted project (needs SMTP, templates and URLs, §5i). Public Auth sign-up stays disabled. |
| Roles and permissions | ✅ per company | `company_memberships`, `role_permissions` (per company), `role_permission_defaults`, Settings → Permissions | Roles: owner, office, dispatcher, mechanic (fleet view + service status), driver (no permissions yet). A user can belong to several companies; one is active at a time, chosen in the account menu (N9). Only owners can grant or remove Owner. |
| Customers, contacts, job sites | ✅ | `customers`, `customer_contacts`, `customer_sites`; `src/app/(app)/customers` | Saved site instructions exist (`customer_sites.directions`). There is no customer portal. |
| Materials, charges, units, price lists | ✅ | `materials`, `charge_items`, `units_of_measure`, `price_lists`, `price_list_entries` | Customer price lists have dated history. **No supplier costs** anywhere. |
| Quotes: editor, revisions, status, history | ✅ | `quotes`, `quote_versions`, `quote_lines`, `save_quote_draft` and related functions | Quote lines snapshot **prices, not costs**. There is no quote duplication and no automatic expiry (by design). |
| Quote PDF and print preview | ✅ | `src/server/pdf/quote-pdf.tsx`, `src/lib/quotes/document.ts` | PDFs for sample quotes carry **no SAMPLE watermark**. |
| Quote email | 🟡 | `src/server/email/provider.ts`, `sendQuoteEmail` | Preview and test modes are tested. Real Resend delivery has never been exercised. |
| Quote → order conversion | ✅ | `orders`, `order_lines`, `convert_quote_to_order` | — |
| Order management | ✅ (N1 + N2, see §5a) | `src/app/(app)/orders`, `src/components/orders`, `src/lib/orders`, migration `20261012000100_order_management.sql` | Status transitions, detail edits, scheduling (date range + time window), direct orders, history. **Loads per order, trucks and drivers** come with dispatch (N4). No order PDF / confirmation email yet. |
| Scheduling and dispatch | ✅ day board (N4, see §5c) · urgent orders (N10, §5j) | `src/app/(app)/dispatch`, `src/components/dispatch`, `src/lib/dispatch`, migration `20261014000100_dispatch_assignments.sql` | Loads per order with explicit times, assignments with eligibility and database-enforced no double-booking, history; urgent orders shown on the board with acknowledgement. No week view, recurring loads, PTO or notifications. |
| Trucks, trailers, drivers, qualifications | ✅ (N3, see §5b) | `src/app/(app)/fleet`, `src/components/fleet`, `src/lib/fleet`, migration `20261013000100_fleet_registry.sql` | Registry, service status with history, qualifications with expiry, dispatch-readiness rules. No maintenance, odometer, documents/photos or PTO yet. |
| Delivery tickets and documents | ✅ office entry (N5, see §5d) | `src/app/(app)/tickets`, `src/components/tickets`, `src/lib/tickets`, migration `20261015000100_delivery_tickets.sql` | Numbered tickets with revisions, review and void history. **No file storage**, photos, signatures, printing or driver entry. |
| Reconciliation and billing-ready records | ✅ first version (N6, see §5e) | `src/app/(app)/billing`, `src/components/billing`, `src/lib/billing`, migration `20261016000100_billing_readiness.sql` | Derived readiness, exception acknowledgments, handoff batches with a CSV file. **No invoices, payments, tax, AR or QuickBooks sync**; the CSV is not a QuickBooks import format. No quantity tolerance setting yet (exact match). |
| Command Center (merged dashboard) and reports | ✅ Command Center (N10, see §5j) · 🧱 Reports | `src/app/(app)/command-center`, `src/lib/command-center`, `src/components/command-center`; `/dashboard` redirects | One home page: pinned attention summary, your work (assigned items, your own loads when linked to a driver record), the prioritized queue (now with urgent orders), operations figures from one database summary, sales (quotes) and one activity feed; sections arranged and collapsed per person; non-urgent items hidden per person. Reports is still a placeholder. |
| Route planner / map | 🧱 | `src/app/(app)/route-planner/page.tsx` | No provider has been selected. `customer_sites` has latitude/longitude columns that are never filled. |
| Fleet maintenance | ❌ | — | — |
| Employee / driver portal, qualifications, PTO, announcements, incidents | 🟡 driver portal (N8, see §5g) | `src/app/(app)/driver`, `src/components/driver`, `src/app/(app)/field-reports`, migration `20261018000100_driver_portal.sql` | Drivers see their own assignments, enter tickets with paper-ticket photos (N8.1, §5h) and send field reports; qualification reminders. No offline queue, no PTO, announcements or incident records. |
| Supplier price imports and price history | ❌ | — | — |
| Operational exceptions queue | ✅ (N7, extended N10 — see §5f, §5j) | `private.operational_exceptions`, migrations `20261017000100_command_center.sql`, `20261021000100_command_center_coordination.sql` | Nine kinds incl. urgent orders, derived live, prioritized, assignable, hideable per person (non-urgent only). No notifications (email/SMS/push), no maintenance or supplier-cost kinds, no payroll kinds. |
| AI assistant / smart dispatch | ❌ | — | — |
| Payroll readiness / driver pay | ❌ planned (see §8 A) | — | Not built: no pay rules, periods or approvals exist; billing readiness never implies payroll. |
| Multi-tenant isolation | ✅ (B1; onboarding N9; defaults N10) | `companies`, `company_memberships`, `company_id` on 41 tables, `tests/db/tenancy.test.ts`, `tests/db/coordination.test.ts`, `tests/e2e/tenancy.spec.ts` | Self-serve company creation behind the early-access gate, company switcher, no company-specific defaults; new companies choose their time zone. No per-company branding or subscription billing. |
| Audit log | ✅ per company | `audit_events.company_id`, Settings → Audit log | — |
| Sample data handling | ✅ | `is_sample`, `remove_sample_data()` | — |
| Local dev stack | 🟡 | `scripts/dev-stack` | Postgres, Auth, PostgREST, optional Storage (N8.1) and a mail catcher (N9). The `supabase start` path (Docker) has never been run. |
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
| N7 ✅ | Operations dashboard | Done (§5f) — Command Center with live counts and an attention queue | N1–N6 | Replace the placeholder cards with real counts as each module lands. | — |

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

## 5f. Owner command center and exception resolution (N7)

### Plan (written before building)

**Inspected first.** The dashboard shows quote figures and an "Operations" card
built from separate per-module queries (`countUnassignedLoadsToday` loads ids
into the app, `ticketCounts`, `billingCounts`, `fleetOverview`). Reusable
sources: billing views (`billing_load_status`, `billing_order_status`) for
missing tickets and billing blocks; `private.assignment_eligibility` (the same
rules `assign_load` applies) for assignment problems; equipment
`service_status` / `out_of_service_since`; the audit log (RLS: `audit.view`, or
order entries with `orders.view`, fleet entries with `fleet.view`). Role
defaults: owner and office have everything operational (office lacks
`audit.view`); dispatcher has dispatch, orders, tickets view/edit and fleet view;
mechanic has fleet view/service; driver has nothing. **No maintenance data
exists**, so no maintenance metric is shown as a number. Finding: since N6,
billing actions are logged on the order, so `orders.view` (dispatchers) can read
billing audit entries — to be closed here.

**Approach — derived, never stored.**

- One SECURITY DEFINER function computes the exceptions for the caller's
  company (`private.operational_exceptions`), reusing the billing views and the
  eligibility function; it filters every row by the company it resolves itself
  and gates each exception kind by the caller's permissions. Public entry points:
  `command_center_summary()` (counts, `null` when not permitted) and
  `command_center_exceptions(kind, mine, limit, offset)` (prioritized, paged,
  with a total). Nothing is cached or stored, so a fix in any module shows on the
  next page load. No polling; a Refresh button and an "as of" time.
- Exception kinds and permission gates: `missing_ticket` (tickets.view or
  billing.view), `unassigned_load` (dispatch.view), `ticket_review`
  (tickets.view), `billing_blocked` (billing.view), `equipment_out_of_service`
  (fleet.view), `assignment_problem` (dispatch.view).
- **Deduplication** — one row per underlying issue, keyed `kind:entity id`:
  a due load without a live ticket is a *missing ticket* (also when it was never
  assigned — the reason says so), never also an *unassigned load*; *unassigned*
  covers only today's loads that have not ended. A ticket waiting for review
  appears once (its current revision); its order is not also listed as a
  billing exception (billing lists only orders whose readiness is *blocked*, i.e.
  everything is documented and reviewed but exceptions are unacknowledged). An
  assignment appears once with all its blockers; equipment out of service appears
  once per unit (with the number of upcoming loads booked on it).
- **Assignment to a person**, using existing memberships and permissions:
  `exception_assignments` (who, by whom, note, when; ended on reassign/unassign),
  only for a currently open exception, only to an active member whose role holds
  the permission that resolves that kind; `exceptions.assign` (owner, office);
  audited. An assignment is not a status: the exception stays until its record
  changes, and a stale assignment simply stops showing.
- No dismissal or snooze (nothing may hide an open problem). No AI or automatic
  actions; each row carries a structured reason (codes), which leaves room for
  explainable, human-approved recommendations later.
- Links into existing workflows: ticket entry or dispatch (with the load
  highlighted), ticket page, billing order page, truck/trailer page.
- UI: `/command-center` (navigation for anyone with one of the source
  permissions; drivers and signed-out users are refused), metric cards linking to
  filtered lists, the attention queue with filters and paging, recent activity
  (bounded, paged, billing entries only with `billing.view`); the dashboard's
  Operations card becomes a summary that links to it.

### What was built (N7)

- Migration `20261017000100_command_center.sql`: `exceptions.assign` (owner,
  office); `exception_assignments` (current assignee per exception key, ended on
  reassign/unassign, guard: rows only end once, never edited or deleted except
  with the member); `private.operational_exceptions`,
  `private.exception_visible`, `private.exception_resolve_permission`,
  `private.require_command_center`; public `command_center_summary`,
  `command_center_exceptions` (kind / mine filter, limit 1–100, offset, total),
  `exception_assignee_options`, `assign_exception`, `unassign_exception`;
  `audit_read_orders` narrowed so billing entries need `billing.view`.
- Priority: **Urgent** — a load today without a truck; an upcoming (today or
  tomorrow) assignment the rules would now refuse. **High** — a delivered load
  without a ticket; a ticket flagged for review; a later assignment problem;
  equipment out of service with loads booked on it. **Normal** — a ticket waiting
  for acceptance; an order blocked from billing; equipment out of service with
  nothing booked. Within a priority, oldest first. Age comes from the record
  (load end, last unassignment or load creation, ticket revision time,
  out-of-service time); billing blocks and assignment problems have no reliable
  start, so no age is shown.
- `src/lib/command-center/rules.ts`: kind labels, who handles each kind, reason
  texts (reusing the eligibility and ticket review texts), titles, the
  recommended action and its link, age and the overview cards (a card the role
  may not see is left out; maintenance reads "Not available").
- UI: `/command-center` (status strip, overview cards linking to filtered lists,
  attention queue with kind / "assigned to me" filters, priority explanation,
  20 per page, recent activity 15 per page with Older/Newer, Refresh button and
  "as of" time, separate error states per section, empty states); dispatch board
  accepts `?load=` and highlights that load; navigation item for anyone with
  dispatch, tickets, billing or fleet view; dashboard Operations card now shows
  the Command Center summary instead of its own counts (the old
  `countUnassignedLoadsToday` and `billingCounts` helpers were removed).
- Tests: `tests/db/command-center.test.ts` (8), `tests/unit/command-center-rules.test.ts`
  (5), `tests/e2e/command-center.spec.ts` (4); tenancy guards updated
  (35 business tables, 72 reviewed definer functions).

### Remaining limits (N7)

- Computed on every page load from all open records; fine at the current scale,
  but a company with tens of thousands of open loads would need indexes tuned or
  a materialized summary with explicit invalidation.
- No maintenance exceptions (no maintenance data), no expiring-qualification or
  quote follow-up kinds yet, no notifications or e-mail digests, no automatic
  refresh (Refresh button only).
- Assignment is a pointer to a person, not a workflow: no due dates, no
  comments thread, no notification to the assignee.
- Recent activity is the audit log as each role may read it; it is not filtered
  to "operational" actions beyond the entity types.

## 5g. Driver portal and field reports (N8)

### Plan (written before building)

**Inspected first.** Driver identity: `drivers.user_id` → `company_memberships
(company_id, user_id)` (composite FK, same company), at most one driver record
per account per company (`drivers_user_key`); the office links them on the
fleet driver page. The `driver` role exists with **no permissions**, so drivers
can read nothing today. Tickets are written only by `submit_delivery_ticket`
(`tickets.edit`) through `private.prepare_ticket`. There is **no file storage**
in the local stack (no `storage` schema), and Supabase Storage has never been
configured for a hosted project.

**Identity rule (no schema change needed).** A portal user is the active
member of the current company whose account is linked to an *active* driver
record of that company. Every driver function resolves that driver from the
session (`auth.uid()` + `private.current_company_id()`); IDs from the browser
are only accepted if they belong to that driver's own active assignments.

**Scope.**

- Permission `driver.portal` (driver role). Drivers get no table grants beyond
  what they have: all reads and writes go through SECURITY DEFINER functions
  that return only their own data and only driver-safe fields.
- `/driver` (mobile-first): today's assignments in time order (plus the next
  day's, read-only), order number, customer and job site with directions, job
  instructions, load and dispatch notes, planned quantity and unit, truck and
  trailer, the load's ticket status and the next action; recent tickets with
  their review status; qualification reminders (expired / expiring in 30 days /
  unverified CDL and medical card). Never prices, totals, internal or
  scheduling notes, other drivers' work, billing or order history.
- Ticket entry by the driver for their own assigned load from the start of the
  load's day: same validation, numbering, duplicate confirmation, idempotency
  key, review flags and office review as office entry (a shared private
  helper; `submit_delivery_ticket` keeps its behavior). The driver cannot choose
  another driver or other equipment (taken from the assignment), and the ticket
  is never accepted automatically. The event records the source (driver portal).
- **Photos: not in this milestone** — blocked on private storage (bucket with
  company-scoped policies and signed URLs) that is not available locally;
  documented in §5g limits and SETUP.
- Field reports: new `field_reports` (delay, cannot complete, breakdown,
  equipment issue, inspection issue) tied to one of the driver's own
  assignments and its truck/trailer; idempotency key; status open →
  acknowledged → resolved by office/dispatch (equipment kinds also by the
  shop), with notes, actor and time; audited; nothing changes service status or
  assignments automatically. They appear in the Command Center as a new
  exception kind and on a `/field-reports` list and detail page.
- Permissions: `field_reports.view` (owner, office, dispatcher, mechanic —
  mechanics see equipment kinds only), `field_reports.manage` (owner, office,
  dispatcher; mechanic for equipment kinds).
- Mobile: large touch targets, minimal typing, explicit sending / sent / failed
  + retry states, no success before the server confirms, the same submission
  key on retries, nothing stored in browser storage. **No offline queue** (not
  claimed).

### What was built (N8)

- Migration `20261018000100_driver_portal.sql`: permissions `driver.portal`
  (driver), `field_reports.view` / `field_reports.manage` (owner, office,
  dispatcher, mechanic — mechanics only for equipment kinds);
  `private.create_ticket` (the former body of `submit_delivery_ticket`, which
  now calls it — office behavior unchanged, verified by the existing ticket
  tests); `private.portal_driver`, `private.driver_assignments`;
  `driver_portal_home`, `driver_assignment_form`, `driver_submit_ticket`,
  `driver_submit_field_report`, `review_field_report`; `field_reports` with a
  guard (only review fields change, forward only; never deleted) and RLS (delay
  reports need `dispatch.view`); the command center gains `delay_report` and
  `equipment_report` (open → priority 1 for breakdown / cannot complete, else 2;
  acknowledged → 3), a "Driver reports open" figure, and assignment rules
  (delay reports only to people with dispatch access).
- Driver tickets: the load must be on the driver's own active assignment and
  dated today or earlier; driver, truck and trailer come from the assignment
  (anything else in the request is ignored); the submission key is required, a
  retry returns the same ticket, and a key used by someone else is refused;
  the event and audit entry record "entered by the driver". Review, correction
  and void stay with the office roles.
- Field reports: delay, cannot complete, breakdown, equipment issue,
  inspection issue; tied to one of the driver's own assignments from two days
  ago to tomorrow, with the truck or trailer of that assignment for equipment
  kinds; snapshot of order/load/units/driver; idempotent; audited on the order
  (delays) or the truck/trailer (equipment). Office page `/field-reports` and
  detail with acknowledge / resolve (resolution note required) and links to the
  load, order and truck/trailer. Reports never change service status or
  assignments.
- UI: `/driver` (My Day: reminders, "tickets still needed" for the two previous
  days, today, tomorrow, recent tickets with their review status, own reports),
  `/driver/assignments/[id]/ticket`, `/driver/assignments/[id]/report`;
  navigation "My Day" and "Driver Reports"; drivers without office permissions
  are sent from the dashboard to My Day. Large touch targets; the order line's
  unit is marked but never preselected; date prefilled with the load date and
  time with the current time only on the load's day; sending / failed + "Send
  again" / server-confirmed success; no browser storage.
- Tests: `tests/db/driver-portal.test.ts` (7), `tests/unit/driver-rules.test.ts`
  (3), `tests/e2e/driver-portal.spec.ts` (2, phone viewport, including an
  offline send, a retry and a double tap producing one ticket); command center
  and tenancy tests updated (36 business tables, 80 reviewed definer functions).

### Remaining limits (N8)

- **No ticket photos.** Blocker: no private file storage. The local stack has
  no Supabase Storage, and no hosted bucket has been configured or tested. Safe
  implementation needs a private bucket, object paths starting with the company
  id, storage policies using the same membership check, short-lived signed URLs,
  and size/type limits — to be built and tested on staging (B3) first.
- No offline queue: a send without signal fails visibly and nothing is kept on
  the phone; the driver re-sends when back in coverage.
- Drivers cannot correct their own tickets (the office corrects); no inspection
  records (DVIR) exist, so "inspection issue" is a free-text report.
- Loads more than two days old drop off the driver's list (the office enters
  late tickets as before).
- No push notifications to the driver or the office; the office sees reports
  in the Command Center and on Driver Reports.

## 5h. Secure file storage and ticket photos (N8.1)

### Plan (written before building)

**Inspected first.** Hosting is Supabase (Auth, PostgREST, Postgres) + a Next.js
host. No storage exists anywhere: the local no-Docker stack runs Postgres,
GoTrue, PostgREST and a gateway only; no hosted bucket has been created. The
Supabase Storage server (open source, `supabase/storage`) can be built from
source here (v1.45.0 — the newest release that runs on Node 22) and run with a
local file backend against the dev database, so storage authorization can be
tested against the real server rather than mocks. Driver tickets go through
`driver_submit_ticket` → `private.create_ticket`.

**Storage architecture.**

- Supabase Storage, one **private** bucket `ticket-photos` (`public = false`,
  5 MB limit, `image/jpeg`, `image/png`, `image/webp`). Object paths:
  `<company_id>/ticket-photos/<attachment_id>.<ext>`, chosen by the database,
  never by the browser.
- A `ticket_attachments` table is the record of every photo: company, the
  driver's assignment and load, status (`pending` → `uploaded` → `attached`, or
  `discarded`), path, detected MIME type, size, SHA-256, upload key
  (idempotency), uploader, times, and the ticket number and revision once
  attached.
- Storage RLS on `storage.objects` for the bucket: **insert** only when a
  `pending` attachment row with exactly that path exists for the caller in the
  caller's company (so a changed path or record id is refused); **read** only
  for attached photos of the caller's company with `tickets.view`; no update or
  delete for app users. Checks run in SECURITY DEFINER helpers, so the policy
  does not depend on table grants.
- Upload goes through the app server (`POST /driver/photos`): the server
  checks the session, size and the file's **magic bytes** against the declared
  type, computes the hash, asks the database for the path
  (`driver_begin_ticket_photo`: own active assignment, limits), uploads with
  the user's own token (storage RLS applies), then `driver_confirm_ticket_photo`
  checks the object exists in `storage.objects` with the same size and type.
  Same-origin check against cross-site posts. The phone re-encodes the photo to
  JPEG (max 2000 px), which also strips EXIF/GPS data.
- The ticket submission carries the uploaded photo ids; `driver_submit_ticket`
  attaches them in the same transaction (own, same assignment, `uploaded`,
  at most 3 per ticket). Duplicate protection is unchanged (a retry with the
  same key returns the same ticket; photos were attached by the first).
- Viewing: `/tickets/photos/[id]` checks access through RLS and redirects to a
  60-second signed URL created with the viewer's token; pages always link to
  this route, so an expired link is never reused. Missing objects return a
  clear "file missing" response.
- Lifecycle: photos belong to the ticket number — kept when the ticket is
  corrected (shown on every revision with the revision they were attached to),
  voided or superseded; never deleted with the ticket. Unattached uploads
  older than 24 hours are abandoned: `scripts/cleanup-ticket-photos.mjs`
  (service role) lists them and storage orphans, removes the objects through
  the Storage API, then marks the rows `discarded` only after the database
  confirms the objects are gone.
- Audit: upload and attach on the order history; discards in the audit log.
  Nothing about photos appears in the Command Center.

**Infrastructure / environment.** Hosted: Supabase Storage is part of the
project; the migration creates the bucket and policies when the `storage`
schema exists (otherwise run `select private.setup_ticket_photo_storage();`
once storage is enabled). No new app secrets: uploads and signed URLs use the
signed-in user's token; only the cleanup script uses
`SUPABASE_SERVICE_ROLE_KEY`. Local: `DEV_STORAGE=1 scripts/dev-stack/stack.sh up`
builds and starts the storage server (file backend) behind the gateway.

**Testing.** Database tests for the attachment functions and the storage RLS
policies (inserting into `storage.objects` as real roles); integration tests
against the running storage server with real user tokens (authorized upload,
other company, tampered path, other driver, read permissions, expired signed
URL, no public access); unit tests for file validation; browser test of the
phone upload with progress, retry and office viewing.

**Staging rollout.** Apply the migration with `supabase db push`; confirm the
bucket is private in the dashboard; run the storage integration tests against
staging with test users; schedule the cleanup script (daily); then enable for
drivers.

### What was built (N8.1)

- Migration `20261019000100_ticket_photos.sql`: `ticket_attachments` (+ guard, RLS),
  `private.can_upload_ticket_photo` / `can_read_ticket_photo` (storage policy
  helpers), `private.setup_ticket_photo_storage()` (bucket + policies, run by the
  migration when storage exists), `driver_begin_ticket_photo`,
  `driver_confirm_ticket_photo`, `driver_submit_ticket` with `photo_ids`,
  `abandoned_ticket_photos` and `mark_ticket_photos_discarded` (service role).
- Upload route `POST /driver/photos` (same-origin, session, size, magic bytes,
  SHA-256, reserve → upload with the user's token → confirm); view route
  `/tickets/photos/[id]` (RLS check, 60-second signed URL, 404 for a missing file).
- Phone UI: "Take a photo" (camera), re-encode to JPEG ≤ 2000 px (drops EXIF/GPS),
  per-photo progress bar, "Uploaded" only after the server confirms, "Not uploaded"
  + Retry (same upload key) and Remove; the ticket cannot be sent while a photo is
  uploading or failed; up to 3 photos.
- Office: "Paper ticket photos (n)" on the ticket page (all revisions, revision
  shown), a camera mark in the ticket list. Nothing in the Command Center.
- Dev stack: `DEV_STORAGE=1` builds and runs Supabase Storage v1.45.0 (file
  backend) behind the gateway; `scripts/cleanup-ticket-photos.mjs`.
- Limits: 5 MB per file, JPEG / PNG / WebP (content-checked), 3 photos per
  ticket, 3 waiting uploads per assignment, unattached uploads removed after 24 h,
  signed links valid 60 s.
- Tests: `tests/db/ticket-photos.test.ts` (5, storage policies exercised in the
  database as real roles), `tests/storage/ticket-photos.storage.test.ts` (4,
  against the real storage server with real user tokens: private bucket,
  tampered paths, other drivers and companies, anonymous, wrong type, oversize,
  no overwrite or delete, office-only reads, expired and altered links, cleanup
  script), `tests/unit/images.test.ts` (2), `tests/e2e/ticket-photos.spec.ts`
  (phone upload with progress, an offline failure and retry, direct attacks on the
  upload route, office viewing, driver and mechanic refused); tenancy guards
  updated (37 business tables, 86 reviewed definer functions).

### Remaining limits (N8.1)

- Verified against the open-source storage server locally (file backend); the
  hosted bucket has **not** been created or tested yet — that is a staging step.
- Storage files are not in database backups; a storage backup has to be set up.
- HEIC photos are converted on the phone when the browser can decode them (Safari
  does); otherwise the driver is asked to use the camera button.
- Office users cannot add photos, and drivers cannot add photos to a ticket after
  sending it (a correction by the office keeps the existing photos).
- No virus scanning: only image types are accepted, content-checked, re-encoded
  on the phone, stored privately and never executed or served inline from the
  app's own origin.

## 5i. Accounts, company onboarding and early access (N9)

### Found before changing anything

- N8.1 is complete and pushed (`51862bf`); all suites were green. Open items are
  external: the hosted `ticket-photos` bucket has never been created or tested, and
  storage files need their own backup (both staging tasks).
- Sign-in, sign-out and password reset exist (`src/app/(auth)`, `/auth/confirm`
  handles `token_hash` links). Public sign-up is off in Supabase Auth
  (`enable_signup = false`; locally `GOTRUE_DISABLE_SIGNUP=true`) and stays off.
- **No email delivery locally**: the no-Docker stack had no mail server, so reset
  and invitation emails went nowhere and could not be tested.
- Companies: only operators create them (`private.create_company` + the
  `create-owner.mjs` script). It seeds settings, numbering, role permissions,
  units and the standard price list atomically; the `billing` sequence comes from
  a trigger. There is no self-serve company creation.
- Invitations: Settings → Users calls `auth.admin.inviteUserByEmail` (service role)
  and then `add_company_member` as the inviting user. Inviting an email that
  already has an account (e.g. a member of another company) fails with "already
  exists" — the person cannot be added at all.
- Multiple companies: memberships per company and `profiles.active_company_id`
  exist, `my_access` returns `membership_count`, but users cannot change the active
  company (no grant, no function, no UI).
- Roles: a non-owner holding `users.manage` (only owners have it by default) could
  grant the Owner role through `set_user_access` / `add_company_member`.

### Plan

- **Local email**: a development-only mail catcher in the dev stack; Supabase Auth
  sends confirmation, invitation and reset emails to it using the repository's
  templates (new `confirmation.html`). E2E tests read the links from it.
- **Early-access gate (needed now)**: self-serve accounts and companies would be
  public registration without it. Separate component in the `private` schema (not
  reachable through the API): codes stored only as SHA-256 hashes, with label,
  maximum uses, expiry and revocation; redemptions; attempts for rate limiting
  (per IP, per email, per user). Operators create, list and revoke codes with
  `scripts/early-access.mjs` (the code is shown once). Auth stays in Supabase Auth.
- **Sign-up** (`/signup`): access code + name + email + password + company name.
  The server checks the code and rate limits, creates the account through the Auth
  admin API (unconfirmed), reserves one use of the code for that account, and asks
  Auth to send the verification email. Public `/auth/v1/signup` remains disabled.
- **Onboarding** (`/onboarding`): after verifying the email and signing in, one
  database transaction creates the company (`private.create_company`), the owner
  membership and the active company, and completes the reservation — repeated
  submissions return the same company. Existing accounts create an additional
  company with an access code on the same page.
- **Invitations**: inviting an existing account adds the membership (no second
  account); repeated invitations are idempotent; only owners can grant or remove
  the Owner role.
- **Company switcher** in the account menu for people with several companies
  (`switch_company`, own active memberships only); every query already follows the
  active company in the database.
- **Test companies**: `scripts/create-test-company.mjs` (local databases only)
  creates a company with owner, office, dispatcher, mechanic and driver accounts.

### What was built (N9)

- Migration `20261020000100_company_onboarding.sql`:
  - Private tables `private.early_access_codes` (SHA-256 hash only, label, max
    uses, expiry, revocation), `private.early_access_redemptions` (one reservation
    per account, unique request key) and `private.access_attempts` (failed
    attempts for rate limiting). None are reachable through the API.
  - Service-role functions `early_access_check` (10 failures per IP and 5 per
    email per 15 minutes), `early_access_reserve` (idempotent per request key,
    row-locked so the last use cannot be taken twice), `early_access_request`,
    and `early_access_create_code` / `early_access_list_codes` /
    `early_access_revoke_code`.
  - For signed-in users: `my_onboarding`, `complete_company_onboarding` (verified
    email required, one transaction: company with settings, numbering, permissions,
    units and price list via `private.create_company`, owner membership, active
    company, completed reservation, audit event; a repeat returns the same
    company), `create_company_with_access_code` (existing accounts; 5 failures per
    user), `my_companies`, `switch_company` (own active memberships only).
  - Invitations: `add_existing_member` (adds an existing account by email; reports
    "already a member"; refuses deactivated people). `add_company_member` and
    `set_user_access` now let only owners grant or remove Owner.
- Sign-up `/signup` (access code, company, name, email, password): the server
  checks the code and rate limits, creates the unconfirmed account with the Auth
  admin API, reserves one use, and has Supabase Auth send the verification email.
  A retry of the same form is recognised and only resends the email. The repeat
  key is made in the browser on first submit (the page is prerendered).
- `/onboarding` (finish creating the company; or another company with a new code),
  `/no-access` sends people with a pending company there.
- Company switcher in the account menu (only shown with two or more companies);
  "Create a company" for owners.
- Settings → Users: inviting an existing account adds it to the company (no second
  account), repeats are idempotent; the Owner role is offered only to owners.
- Operator scripts: `scripts/early-access.mjs` (create — shows the code once —,
  list, revoke, hash) and `scripts/create-test-company.mjs` (local databases only:
  a company with owner, office, dispatcher, mechanic and driver accounts).
- Dev stack: `scripts/dev-stack/mailbox.mjs` (SMTP catcher writing
  `.dev-stack/mail/*.json`), Auth sends with the repository templates (new
  `supabase/templates/confirmation.html`), email confirmation required.
- Tests: `tests/db/onboarding.test.ts` (10), `tests/unit/early-access.test.ts` (4),
  `tests/e2e/onboarding.spec.ts` (2: code refused / used up, unverified sign-in
  refused, verification email → company, invitation emails, existing account
  added, switcher, cross-company URL, public Auth sign-up closed, no shared repeat
  key), `tests/e2e/roles.spec.ts` (5: allowed and refused pages per role);
  tenancy guards updated (101 reviewed definer functions).

### Remaining limits (N9)

- Hosted Supabase is **not configured** for any of this yet (see SETUP §2): Confirm
  email, the three templates, SMTP, Site URL and redirect URLs must be set by hand;
  `SUPABASE_SERVICE_ROLE_KEY` is required on the server for sign-up and invitations.
- Rate limiting uses the first `X-Forwarded-For` address; the host must set that
  header itself (Vercel does). Behind another proxy, check it before launch.
- No self-serve "resend verification email" button: a person who loses the email
  can retry the same form, or an operator resends it. Unverified accounts with an
  unused reservation are not cleaned up automatically.
- Access codes are managed with a script, not an admin screen. There is no waiting
  list, marketing site or subscription payment (out of scope for N9).
- A person cannot leave a company themselves; an owner deactivates them.

## 5j. Unified Command Center and workflow coordination (N10)

### Found before changing anything

- Start: branch `claude/top-line-trucking-manager-vmw04i`, commit `dc21c1d` (N9), clean tree.
  The N9 report matched the code (sign-up, onboarding, switcher, invitations, tests).
- **Baseline**: vitest 263/265 (2 storage tests failed) and the browser suite could not
  start. Cause: the local dev gateway (`scripts/dev-stack/gateway.mjs`) crashed when Storage
  closed a connection after its response started (the 5 MB rejection), taking Auth and
  PostgREST offline. A dev-tool bug, not an app bug: fixed (cut that one response, keep
  serving). After the fix: vitest 265/265, browser 36/36.
- **Dashboard** (`/dashboard`): quote figures with a date/customer filter, follow-up lists,
  recent activity (audit or quote events), "Orders scheduled today", a fleet card, a card
  repeating the Command Center total, and a "Deliveries in progress — not available"
  placeholder. Everyone landed here after sign-in.
- **Command Center** (`/command-center`, N7/N8): operational overview cards and a
  prioritized attention queue derived live in the database
  (`private.operational_exceptions`), assignable to a person, plus operational activity.
  Required dispatch/tickets/billing/fleet/field-report permissions.
- **Overlap**: two entry points with overlapping figures computed in different places
  (out-of-service trucks in `fleetOverview()` and in `command_center_summary`; the dashboard
  repeated the queue total); two activity feeds with different rules.
- **Orders → dispatch → tickets → billing**: one chain of shared records — loads and
  assignments reference the order, tickets reference load/assignment/order line, billing
  readiness is a set of live views (`billing_load_status`, `billing_order_status`). A ticket
  correction therefore re-evaluates readiness automatically; nothing is copied. Received
  (submitted), needs review, accepted, voided and superseded are explicit ticket states;
  accepted ≠ billed. Payroll does not exist (no pay rules, no data).
- **Gaps**: no urgency on orders (no flag, owner or acknowledgement); after reviewing a
  ticket the reviewer stays on it (no "next"); opening a queue item loses the queue context;
  the order page does not say where the order stands in billing; nothing can be hidden or
  arranged per person.
- **Authorization**: unchanged model (role per membership, per-company `role_permissions`,
  RLS on everything, definer functions checking company and permission). Owner permissions
  are fixed — and lacked `driver.portal`, so an owner who also drives could not see their
  own loads.
- **Company-specific assumptions**: `company_settings` column defaults `company_name =
  'Top Line Trucking'`, `state = 'IN'`, `timezone = 'America/Chicago'` (new companies
  inherited Central time without being asked); sidebar logo "TOP LINE TRUCKING", page
  titles, PDF creator and dev email subjects name Top Line; the settings time-zone hint
  mentions Lake and Porter counties; `create-owner.mjs` defaulted to the Top Line slug.
  The B1 migration (historical, not editable) creates the company row "Top Line Trucking"
  on every install; it has no members and receives no data from other companies. No live
  function references that company. `private.create_company` copies nothing from another
  company.

### Plan

- One Command Center at `/command-center` (`/dashboard` redirects, keeping old links):
  pinned status strip, "Your work" (items assigned to you, your own loads when your
  account is linked to a driver record), the attention queue, operations figures from one
  database summary, sales (quotes) for people with quotes access, one activity feed.
  Sections can be reordered and collapsed per person; the strip with urgent counts cannot.
- Hide-for-me on non-urgent items (per person, time-limited, never resolves the record,
  still counted); urgent items cannot be hidden.
- Urgent orders: office flags an order with a reason and optional deadline; dispatch sees
  it on the board and in the queue, acknowledges and moves it through explicit states;
  optional company escalation time; full history; no automatic assignment.
- Ticket review queue: queue position, "Accept and next", return to the same filter.
- Order page: one progress panel (loads, assignments, tickets, billing readiness, urgency)
  with the next step and who handles it.
- Company defaults: no company-specific defaults; time zone chosen at onboarding; neutral
  product name in shared UI (working name in one constant).

### What was built (N10)

- Migration `20261021000100_command_center_coordination.sql` (additive; dev database backed
  up first):
  - `company_settings`: no company-specific defaults (`company_name`, `state` default to
    empty); new `urgent_ack_minutes` (escalation time, null = off). Onboarding functions take
    a time zone (`complete_company_onboarding(name, timezone)`,
    `create_company_with_access_code(…, timezone)`); the one-argument versions are no longer
    executable by app users.
  - Owner role gains `driver.portal` (owner permissions are fixed; the portal still needs a
    linked, active driver record).
  - `order_urgencies` (one open flag per order: reason, needed-by, state, who flagged, who
    acknowledged) and append-only `order_urgency_events`; `flag_order_urgent` (orders.edit,
    idempotent), `update_order_urgency` (dispatch.edit for working states, orders.edit to
    withdraw, either to resolve; notes required for blocked / waiting / resolved / withdrawn;
    "truck assigned" only when an assignment exists); a completed or canceled order closes its
    flag with a history entry. Nothing assigns trucks or changes assignments. Flags and
    their history cannot be deleted, except together with a sample order by "Remove sample
    data" (same rule as every other order record).
  - `user_preferences` (section order and collapsed sections only) and `exception_dismissals`
    (hide a non-urgent item from your own view for 4 h / 1 day / 3 days; still open and
    counted); `save_my_preference`, `hide_exception`, `unhide_exception`.
  - Command Center: `urgent_order` kind (priority 1 until acknowledged or when past its
    needed-by time; escalation reason when the company's time passes), `orders_today` and
    `urgent_orders` in the summary (one source for the merged page), hidden counts, queue
    paging of hidden items; `orders.view` alone now opens the Command Center.
- **Command Center** (`/command-center`, the only home page; `/dashboard` redirects): pinned
  attention summary (urgent count always visible, not collapsible), "Your work", attention
  queue, operations figures (incl. orders today, urgent orders, drivers ready), sales and
  quotes, one activity feed (full audit with `audit.view`, otherwise operations + quote
  events). "Arrange sections" and collapse per person; "Hide for me" on non-urgent items.
  Drivers without office permissions start on My Day.
- **Context**: records opened from the queue, the ticket list or the dispatch board carry a
  validated `back` link ("Back to the Command Center" / "ticket queue" / "dispatch board")
  that returns to the same filter and page.
- **Ticket review queue**: "Review queue: n of N", previous/next, "Accept and next" (after
  accept, flag or void the next ticket opens; when the queue is empty, back to the list);
  review views list oldest first, like the Command Center.
- **Order page**: "Progress" panel (dispatch → delivery tickets → billing readiness, from the
  same records and the same due rule as billing) with the next step and who handles it;
  "Urgent order" panel with history.
- **Dispatch board**: urgent orders banner (oldest first) with "Acknowledge".
- **Company-neutral shared code**: product name in `src/lib/product.ts`; sidebar shows the
  active company; email templates, titles, PDF creator and dev email subjects no longer name a
  customer; billing texts say "your accounting system"; `create-owner.mjs` requires a slug;
  time zones offered nationally with labels; Settings hint no longer names counties.
- **Dev stack**: the gateway no longer crashes when an upstream closes a connection mid-response.
- **Tests**: `tests/db/coordination.test.ts` (10), `tests/unit/coordination.test.ts` (9),
  `tests/e2e/coordination.spec.ts` (3: urgent order office → dispatch → Command Center with
  another company seeing nothing; review queue accept-and-next and return; per-person
  layout, hide/show, owner who drives); updated `command-center.spec.ts` (return to the
  filtered queue), `auth.spec.ts`, `roles.spec.ts`, `onboarding.spec.ts` (time zone),
  `tests/db/onboarding.test.ts`, tenancy guards (41 business tables, 110 reviewed definer
  functions).

### Remaining limits (N10)

- No notifications: escalation marks an urgent order overdue in the Command Center; nobody is
  emailed, texted or paged. Escalation rules beyond one time limit (business hours, holidays,
  per-customer rules) are not modelled — they need the companies' real rules first.
- Urgency is not shown in the orders list (only on the order, the board and the queue).
- Billing readiness requirements are the same for every company (all loads documented and
  accepted, differences acknowledged). Company-specific requirements (e.g. photo required,
  PO required) are a planned setting (§8 B/G).
- No OCR/extraction: tickets are entered by hand or by the driver; "received" (submitted) and
  "verified" (accepted) are explicit states; suspected duplicates require confirmation.
- The review queue and position are computed on each page load (no locking between two
  reviewers; the second decision on the same ticket is refused by the database).
- Payroll readiness does not exist yet (§8 A). Nothing in billing implies driver pay.
- The historical B1 migration creates an empty "Top Line Trucking" company on a fresh install;
  an operator can rename or deactivate it (it has no members and receives no other company's
  data).


## Recommended next task

**B3 — staging deployment** (hosted Supabase, all 18 migrations via `supabase db push`, auth
email settings, templates and SMTP per SETUP §2, deploy, backup/restore drill, the sign-up →
onboarding → invitation flow with a real inbox, the `ticket-photos` bucket checks and a
storage backup). It is the dependency for every external verification below.

Then, in order of value and readiness:
1. **Payroll readiness (§8 A)** — only after the pay rules of the participating companies are
   written down and the export target (QuickBooks Online payroll or another system, file vs
   API) is confirmed with a test company.
2. **Company billing requirements and order-list urgency** (§8 B, small).
3. **Fleet maintenance and defects (§8 D)** — feeds dispatch eligibility and the Command
   Center (data model first; safety-critical defects block dispatch per company policy).

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
| `SUPABASE_SERVICE_ROLE_KEY` | early-access sign-up, invitations, owner bootstrap (server only) |
| `APP_BASE_URL` | auth email links |
| `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `EMAIL_TEST_RECIPIENT` | quote email |

External accounts: Supabase (staging + production), Resend (verified domain),
a Next.js host. Later: a heavy-truck routing provider (evaluation pending);
QuickBooks (Desktop vs Online to be confirmed); possibly an LLM provider for the
assistant (Phase 5).

---

## 8. Product roadmap — status by requirement (Taviron)

Status words: **Verified** (implemented and covered by tests that ran) · **Implemented,
unverified** (built; not exercised end to end, usually because it needs an external system)
· **Partial** · **Planned** (agreed, not started) · **Deferred** (not before its dependency)
· **Blocked** (waiting on a decision or an external fact). No row is a promise of a date.

Principles that hold for every row: each company's data, numbering, pricing, permissions and
settings stay its own; no company's practices become a global default; estimates stay
separate from actuals; recommendations never act on their own (dispatch changes, invoices,
payroll and external commitments need an authorized person); missing or stale data is never
shown as "no problems".

### Foundation (for reference)

| Requirement | Status | Where |
| --- | --- | --- |
| Tenant isolation (RLS, definer checks, composite keys, storage policies) | Verified | §5, `tests/db/tenancy.test.ts`, `tests/e2e/tenancy.spec.ts`, `tests/db/coordination.test.ts` |
| Secure onboarding with early-access gate, invitations, switcher | Verified locally · hosted email unverified | §5i |
| Clean company defaults (no inherited data or company-specific defaults; own time zone) | Verified | §5j |
| One Command Center with role-aware sections, per-person layout and hiding | Verified | §5j |
| Urgent office → dispatch coordination (flag, acknowledge, states, escalation flag, history) | Verified · notifications planned | §5j |
| Order → dispatch → ticket → billing progress from shared records | Verified | §5j, §5e |
| Staging / production separation, backups and tested recovery | Planned (B3) | SETUP, BACKUP_RESTORE |

### A. Payroll readiness and accounting integration

| Requirement | Status | Dependencies / notes |
| --- | --- | --- |
| Payroll access restricted to explicitly authorized users (new `payroll.view` / `payroll.approve`, owner-only by default) | Planned | Fits the existing permission model; no other role gets it by default. |
| Preliminary driver earnings from verified (accepted) ticket/load data | Blocked | Needs each participating company's pay rules (per load, per ton, per hour, minimums, special rates). Do not invent a formula. |
| Driver pay rules separate from customer billing rates | Planned | Separate tables; never read from price lists. |
| Pay periods, period summaries, drill-down to loads | Planned | After pay rules. |
| Exceptions (missing/unverified tickets in a period, corrections after approval) | Planned | Reuses the Command Center (new kind, payroll permission only). |
| Review and approval; calculated → approved → exported → externally processed states | Planned | Approval never automatic; corrections after approval reopen with history. |
| Duplicate-safe exports with audit trail | Planned | Same pattern as billing handoff batches (idempotency key, one active batch per item). |
| QuickBooks Online as first integration target | Blocked | Verify each company's actual QuickBooks setup (Online vs Desktop, payroll product), the supported API or import, required identifiers and format, against a test company — before building. |
| Provider-neutral integration boundary (other accounting/payroll systems) | Planned | Export model in Taviron's terms; provider adapters separate. |
| Payroll execution, taxes, withholding | Out of scope | Remain in the payroll system. |

### B. Quotes, customers and pricing

| Requirement | Status | Dependencies / notes |
| --- | --- | --- |
| Customers, contacts, sites | Verified | §1 matrix |
| Duplicate-aware global search | Partial | Per-module search exists; no cross-module search or duplicate warnings on create. |
| Quote versions, approval (sent/accepted), expiry dates, revisions; accepted versions immutable | Verified | Quotes never change silently; orders copy the accepted version. |
| Automatic expiry | Deferred | By design shown as "past expiration"; decide per company. |
| Materials and dated customer/standard rates | Verified | |
| Supplier costs, margins, cost-informed suggestions | Planned | Needs supplier price data and an import format. |
| Delivery zones / distance bands, minimums, contracts, fuel surcharges | Partial | Charges and percentage surcharges exist; zones, distance and minimum rules do not. |
| Volume (L × W × D) and density-based tonnage estimates | Planned | Estimates must stay labelled as estimates, separate from delivered quantities. |
| Company-specific billing requirements (photo required, PO required, tolerance) | Planned | Company settings feeding the billing views; currently one rule set for all. |
| Pricing and numbering isolated per company | Verified | |

### C. Dispatch and driver fairness

| Requirement | Status | Dependencies / notes |
| --- | --- | --- |
| Daily board with eligibility, qualifications and no double-booking | Verified | |
| Weekly / monthly planning, recurring loads with exceptions | Planned | |
| Driver/truck availability, PTO, maintenance downtime | Partial | Out-of-service equipment and qualifications block assignment; no PTO or planned downtime. |
| Replacement assignments with history | Verified | |
| Urgent work coordination | Verified (N10) | Configurable escalation time; richer policies need real rules. |
| Explainable recommendations (AI-assisted) | Deferred | After reliable history; safety/legal constraints are hard limits; humans approve changes. |
| Fairness analysis (eligibility, opportunities, load mix, duration, distance, waiting, verified earnings) | Deferred | Needs payroll data (A) and enough history; load count alone is not fairness. |

### D. Fleet, maintenance and parts

| Requirement | Status | Dependencies / notes |
| --- | --- | --- |
| Out-of-service status with history and dispatch impact | Verified | |
| Defects from driver reports | Partial | Breakdown/equipment reports exist; no defect records or severity. |
| Maintenance histories, preventive schedules, inspections | Planned | Data model first. |
| Work orders, labor, parts, external shop invoices, downtime, repeat issues | Planned | |
| Repair completed ≠ authorized return to service; safety-critical defects block dispatch per company policy | Planned | Company setting for which defects block. |
| Parts: ordered / shipped / delivered / physically received (tracking never confirms receipt) | Planned | |
| AI risk and repair-window suggestions with stated uncertainty | Deferred | After maintenance data exists. |

### E. Route and conditions intelligence

| Requirement | Status | Dependencies / notes |
| --- | --- | --- |
| Configurable operating regions per company | Planned | No region is assumed (not only Northwest Indiana). |
| Official closures, construction, incidents, detours, bridge/weight limits, weather, frost laws | Blocked | Sources and their coverage must be researched and verified first; show source and freshness; confirmed vs forecast. |
| Matching restrictions to trips | Deferred | Needs routes and vehicle/load data; never treat "no alerts" as "clear"; never recommend violating a restriction; humans approve reroutes. |

### F. Employees, drivers, mobile and breakdowns

| Requirement | Status | Dependencies / notes |
| --- | --- | --- |
| Driver portal: assignments, instructions, tickets with photos, delays and breakdown reports | Verified | §5g, §5h |
| Qualification and document expirations | Partial | Qualifications with expiry and reminders; no document storage for them. |
| Owner/office staff who also drive | Verified (N10) | Linked driver record + `driver.portal`; responsibilities never add permissions. |
| Availability, PTO, announcements, assignment acknowledgement | Planned | |
| Breakdown workflow (confirmed location/map pin, affected assignments, repair, reassignment, return to service) | Partial | Reports exist; location, repair coordination and return-to-service do not. |
| GPS / location / offline | Deferred | Needs a privacy model, permissions, freshness and conflict handling first. No compliance claims. |

### G. Reporting, proactive assistance and commercial readiness

| Requirement | Status | Dependencies / notes |
| --- | --- | --- |
| Revenue, cost, profitability, maintenance spend, utilization, ticket-to-billing time, payroll exceptions, pricing performance | Planned | Mark actual / estimated / incomplete / unavailable; profitability only with reliable costs. |
| Predictive optimization | Deferred | Only when data quality justifies it. |
| Onboarding, training, support, data export, offboarding | Partial | Onboarding done (N9/N10); export and offboarding planned. |
| Backups and tested recovery; staging/production separation | Planned (B3) | |
| Public website, subscription payments | Out of this work | Separate project; access stays server-enforced. |
| Controlled beta: parallel testing, baseline metrics, acceptance criteria, readiness review | Planned | Existing procedures stay authoritative during parallel testing; no duplicate live dispatch or billing without a plan. |
| Product name | Working name "Taviron", not cleared | One constant (`src/lib/product.ts`); no rebranding work until cleared. |

### Unresolved business rules and external dependencies

- Driver pay formulas, special rates, pay periods, adjustments, approvals and export format
  (per participating company).
- Accounting/payroll systems actually used by each company, and their supported import/API.
- Urgent-order escalation beyond a single time limit (business hours, holidays, who is
  notified and how).
- Company-specific billing documentation requirements and quantity tolerances.
- Maintenance policies: which defects stop dispatch, who may return equipment to service.
- Operating regions and official data sources for road and weather conditions.
- Hosted environment (B3): SMTP, templates, URLs, storage bucket and backups.
