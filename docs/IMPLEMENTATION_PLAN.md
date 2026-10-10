# Top Line Trucking Manager → Hauling Operating System — Implementation Plan

Top Line Trucking is the first customer. The long-term goal is a hauling
operating system that other trucking and hauling companies could also use.
This plan is grounded in an audit of the code as it exists (commit `a2a5f0b`,
audited 2026-10-10), updated after the tenant foundation (B1, 2026-10-11). The code, migrations and tests are the source of truth;
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
| Roles and permissions | ✅ per company | `company_memberships`, `role_permissions` (per company), `role_permission_defaults`, Settings → Permissions | Roles: owner, office, dispatcher, **mechanic** (no permissions yet), driver. A user can belong to several companies; one is active at a time (no switcher UI yet). |
| Customers, contacts, job sites | ✅ | `customers`, `customer_contacts`, `customer_sites`; `src/app/(app)/customers` | Saved site instructions exist (`customer_sites.directions`). There is no customer portal. |
| Materials, charges, units, price lists | ✅ | `materials`, `charge_items`, `units_of_measure`, `price_lists`, `price_list_entries` | Customer price lists have dated history. **No supplier costs** anywhere. |
| Quotes: editor, revisions, status, history | ✅ | `quotes`, `quote_versions`, `quote_lines`, `save_quote_draft` and related functions | Quote lines snapshot **prices, not costs**. There is no quote duplication and no automatic expiry (by design). |
| Quote PDF and print preview | ✅ | `src/server/pdf/quote-pdf.tsx`, `src/lib/quotes/document.ts` | PDFs for sample quotes carry **no SAMPLE watermark**. |
| Quote email | 🟡 | `src/server/email/provider.ts`, `sendQuoteEmail` | Preview and test modes are tested. Real Resend delivery has never been exercised. |
| Quote → order conversion | ✅ | `orders`, `order_lines`, `convert_quote_to_order` | — |
| Order management | 🟡 | `src/app/(app)/orders` | Orders are read-only. There are no status transitions, edits, direct orders, delivery dates or loads. |
| Scheduling and dispatch | 🧱 | `src/app/(app)/dispatch/page.tsx` | No tables. |
| Trucks, trailers, drivers, equipment | 🧱 | `src/app/(app)/fleet/page.tsx` | No tables. |
| Delivery tickets and documents | 🧱 | `src/app/(app)/tickets/page.tsx` | No tables. `document_sequences` has a `ticket` key. **No file storage** is used anywhere. |
| Reconciliation and billing-ready records | ❌ | — | — |
| Reports and management dashboard | 🟡 / 🧱 | `src/app/(app)/dashboard`, `src/app/(app)/reports` | The dashboard shows real quote figures; its operations cards are placeholders. Reports is a placeholder. |
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
| N1 | Order lifecycle | Read-only orders | `orders`, `order_status_events` | `set_order_status()` with a transition table (Confirmed → Scheduled → Dispatched → In progress → Partially completed / Completed; On hold; Canceled), reasons, history; delivery window / requested dates; loads planned per order. | Keep status in sync with assignments and tickets (derive where possible). |
| N2 | Direct orders | None | Quote editor + `save_quote_draft` pricing rules | `save_order_draft()` reusing the price resolution and override checks; editor component shared with quotes. | Do not fork the pricing rules — reuse them. |
| N3 | Fleet registry (minimal) | Placeholder | — | `trucks`, `trailers`, `drivers` (linked to memberships), equipment type, verified capacity, `service_status` (in service / out of service with reason). | Never assume capacities; leave them blank until verified. |
| N4 | Dispatch assignments | Placeholder | N1, N3 | `dispatch_assignments (order, date, load #, truck, trailer, driver, planned qty/unit, status)`; a day/week board; conflict rules: double-booking, out-of-service equipment, driver unavailable; keyboard-accessible editing. | Concurrency: use DB exclusion/uniqueness to prevent double-booking. |
| N5 | Delivery tickets | Placeholder | N4, storage (S7) | `delivery_tickets` numbered via `document_sequences('ticket')`, revisions, print layouts (full and half page), planned vs actual quantity, signature/photo upload, printed status. | Ticket immutability once reviewed, like quote revisions. |
| N6 | Reconciliation and billing-ready records | None | N5 | Review queue: awaiting data / awaiting review / missing info / ready for billing; price-change flags vs order; billing export (CSV) with idempotent export batches. | No invoices or QuickBooks posting until an integration is approved. |
| N7 | Operations dashboard | Placeholder cards | N1–N6 | Replace the placeholder cards with real counts as each module lands. | — |

### 4.3 Phase 3 — fleet and employee operations

| Feature | First steps | Dependencies |
| --- | --- | --- |
| Maintenance requests (driver-submitted, photos) | `maintenance_requests` + storage; driver portal form | B1, S7, N3 |
| Work orders, parts, labor, history | `work_orders`, `work_order_lines`; mechanic role | Maintenance requests |
| Service schedules and reminders (date / mileage / engine hours) | `service_schedules`, odometer and hour readings; nightly reminder job | N3; background job runner (none exists — choose Supabase cron / pg_cron or a scheduled route) |
| Out-of-service enforcement and clearance | `service_status` change only through `return_to_service()` requiring a permission; dispatch rule refuses OOS equipment; downtime log | N3, N4 |
| Driver qualifications, licenses, training, expirations | `driver_qualifications` with expiry; eligibility rule used by dispatch | N3 |
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

## Recommended next task

**B3 — staging deployment** (hosted Supabase project, `supabase db push` of all
migrations including company separation, auth URLs, email templates and SMTP,
deploy the app, real password-reset and test-mode quote emails, backup/restore
drill B5). Then **N1 order lifecycle → N3 fleet registry → N4 dispatch → N5
tickets**, each built on the company model from the start.

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
