# Requirements traceability matrix

**Purpose.** One table per domain that ties each requirement to its source, the code that implements it, its
migrations, its tests, its real status and what is still needed. It does not replace
`docs/TAVIRON_MASTER_PLAN.md` (the authoritative plan). Where this file and the plan disagree, the plan is the
authority for decisions and this file reports what the code does; disagreements found are listed in §11.

**How to update.** When a feature changes state, update its row here in the same commit as the master plan §12 row.
Verify every claim in the code (route, server code, migration, test file) before writing it, and do not copy it
from another doc. Use only the status words below. New requirements get the master plan B-number. A requirement
with no B-row gets the next free T-number, and T-numbers are never reused. Never write a test result that was not
recorded.

**Date:** 2026-10-22. Built from a read-only audit of branch `claude/ui-and-signin-checkpoint` at `e488ef2`.

## Status vocabulary (exact words)

| Word | Meaning here |
| --- | --- |
| not started | No code for it. |
| partial | Some of the agreed scope is in code; the gaps are named in the row. |
| implemented | The code exists. It has no recorded passing automated test of real behaviour. |
| verified | Automated tests that exercise real behaviour exist and were recorded passing (local runs; see the test results below). Mocked-provider AI tests do **not** count. |
| deployed | In Production commit `5881927` **and**, when it needs a migration, that migration is hosted. **Deployed never means "verified live"**: the sandbox cannot reach the deployed domains. |
| blocked | Cannot continue without an owner decision, credential, provider or hosted migration (named in the row). |
| not applicable | Excluded by a confirmed decision. |
| undecided | Depends on an open owner decision (§9 of the master plan); nothing may be invented. |

Qualifiers in parentheses are allowed, for example "implemented (Preview only)" or "deployed · verified".

## Deployment facts (verified 2026-10-22 from GitHub deployment records and git)

- **Production** branch `claude/top-line-trucking-manager-vmw04i` = **`5881927`** (Production deployment record
  2026-10-19, success). Not verified live.
- **Preview** branch `claude/ui-and-signin-checkpoint` = **`e488ef2`**: Preview deployment record state success at
  `https://tltmaster-e5qazl7mr-taviron.vercel.app`. **Not verified live:** the URL is unreachable from the sandbox.
- **Preview-only commits** (`git log --oneline 5881927..e488ef2`, 29 commits): delete switch code (`8238483`), customer
  portal / Testing Lab / MFA (`9ffff32`, `8480ddb`), static homepage hero (`9e0282d`), global search (`891f996`),
  security hardening (`330f422`), guided onboarding (`d8f04e3`), MFA inline check (`5cc4af9`), design-audit fixes
  (`cb3963c`), username sign-ins (`bcf2c85`, `2a470dc`, `4de0c30`, `7e3d246`), reference numbers (`7448553`, `155a855`),
  Onboarding Kit (`010954a`), Ask Taviron (`fbaf337`), order-to-cash chain test (`10cd4e8`), Reports typed dates
  (`d8b2af2`), website transformation (`dc99cd0`), input-loss and test fixes (`5398fdb`, `e488ef2`), plus docs.
- **Hosted database** (owner's report, not independently verified): migrations applied **through `20261120000600`**.
  **Pending (Phase B, 17):** `20261120000700` → `20261120002300` (base access, billing view, privileges and Command
  Center counts added 2026-10-22; results of the 2026-10-23 clean run in SESSION_HANDOFF). They wait until Production runs code with the
  two-step verification (MFA) screens, and until every platform admin has enrolled an authenticator (runbook
  `docs/runbooks/2026-10-14-hosted-db.md` §14). Preview and Production **share one Supabase project**. One mismatch:
  `20261120000600` is hosted, but the code that reads it (`8238483`) is on Preview only.
- **AI:** no provider is configured. Ask Taviron and "Explain this plan" were tested with a mocked provider only.
  `src/lib/ai/evidence.ts` holds `EVAL_EVIDENCE = []`, so there is no real `npm run ai:eval` evidence.
- **Test results (VER2, 2026-10-22, local, production build of the app code at `e488ef2`, which is unchanged since):**
  - lint 0 errors, typecheck clean, `npm run build` passes.
  - **Clean starting state:** a fresh PostgreSQL 16 cluster (C.UTF-8), `stack.sh db-reset` (every migration and the
    seed), then the storage server (all three buckets). Full vitest: **883/883** (134 files, 110 s). Full browser
    suite: **204 passed / 2 failed / 10 skipped** (16.7 min). Both failures were a test-order dependency (no real
    material on a fresh seed), fixed in `05b7a7c` and re-run green (4/4). Skips: 9 `gate.spec` (needs a gated server;
    run separately: 8 passed / 1 skipped on 2026-10-20) and 1 order-dependent skip that passes once the live demo
    exists (re-run: 12/12 of the skippable specs passed).
  - **Built-up dev database** (722 companies, 7,813 orders): vitest 875/883 with 8 Command Center timeouts → root
    cause the missing ticket index; with `20261120001600` the 18 Command Center/coordination tests pass on the same
    data. DB project with `001600` and `001700`: 380/380.
  - **Phase A database** (migrations through `20261120000600`, as hosted): full browser suite 183 passed / 22 failed
    / 10 skipped; every failure is a test expecting a Phase B migration (new reference formats, portal, MFA recovery
    codes, onboarding, account provisioning, Testing Lab) or the dev mailbox path; 20 app pages opened as the owner
    render without an error page, Phase B pages show their "needs a database update" state.
  - **GitHub CI** green on `5837017` (the six Preview pushes before it, `891f996`–`dc868d1`, were all red); it now runs the DB tests with Supabase Storage.

  "Verified" below refers to these local runs.

Abbreviations: MP = master plan, IP = IMPLEMENTATION_PLAN, HO = SESSION_HANDOFF, `(app)` = `src/app/(app)`.
Test files are named without directory when the folder is clear: db = `tests/db/`, unit = `tests/unit/`,
e2e = `tests/e2e/`.

---

## 1. Core operations

| ID | Requirement | Source | Implementation | Status | Evidence/tests | Dependencies/migrations | Known gaps & security notes | Owner decision/authorization needed | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | Customers, contacts, sites, materials, dated customer/standard price lists | MP §3; IP §5a | `(app)/customers/**`, `(app)/materials/**`, `src/server/data/customers.ts`, `catalog.ts` | deployed · verified | e2e customers, materials; db tenancy | `20261010000200` | No material density field | — | — |
| T2 | Quotes: versions, PDF, accepted version immutable; email is a preview until a provider exists | MP §3, §7 | `(app)/quotes/**` (incl. `versions/[versionId]/pdf/route.ts`), `src/lib/quotes`, `src/server/quotes`, `src/server/email/provider.ts` | deployed · verified | db quotes, quote-calc-parity; unit quote-calc, quote-document, quote-pdf, quote-status; e2e quotes | `20261010000300` | Default `EMAIL_PROVIDER=preview` → nothing sent; automatic expiry deferred | Email provider + domain (W4) | — |
| O6 | Quote acceptance creates exactly one Confirmed order, idempotent | MP §8 O6 | `convert_quote_to_order` (`20261027000100`) | deployed · verified | db quotes, order-to-cash-chain | — | — | — | — |
| T3 | Orders, edit, schedule (delivery location needed to schedule), needs-scheduling queue | MP §3; IP §5a, §5n | `(app)/orders/**`, `src/server/data/orders.ts`, `src/lib/orders` | deployed · verified | db orders, order-management, order-workflow; unit order-rules; e2e orders, order-workflow | `20261010000600`, `20261012000100`, `20261025000100` | §9 Q19 rules awaiting confirmation | §9 Q19 | — |
| O1 | Order types; required fields per type enforced at confirmation | MP §7, §8 O1 | **None:** no `order_type` anywhere in `src/` or migrations | not started · undecided | — | Needs a migration once decided | Incomplete confirmed orders reach Dispatch (Medium) | §9 Q8 | Owner answers Q8 |
| O2 | Confirmed-order edits that make assignments infeasible are flagged; never silent reassignment | MP §7, §8 O2 | `command_center_exceptions` kind `load_outside_schedule` (`20261025000100`) | deployed · verified | db command-center | — | Flags after save; MP §7's review step before a harmful change is saved is not built | — | Specify the pre-save review (B7 scope) |
| T4 | Dispatch board: eligibility, conflicts (exclusion constraint), replacement history, audit | IP §5c | `(app)/dispatch/page.tsx`, `dispatch/resources`, `src/lib/dispatch/board.ts`, `src/server/data/dispatch.ts`, `assign_load` | deployed · verified | db dispatch; unit dispatch-board; e2e dispatch, dispatch-availability | `20261014000100` + later eligibility migrations | P8: manual-assignment lists sent in full (~1 MB at 900 trucks); O12 pagination needed at ~200 units | — | Paginate when a real fleet needs it |
| T5 | Smart Dispatch Stage 1: proposals, reasons, warnings, alternatives, revalidated approval, audited rejections; maintenance, time off, documents, trailers | MP §6.1; IP §5o, §5y | `src/lib/dispatch/smart.ts`, `src/server/data/smart-dispatch.ts` | deployed · verified | unit smart-dispatch, smart-board-plan, smart-dispatch-bases; db smart-dispatch, dispatch-maintenance; e2e smart-dispatch | `20261027000100`, `20261103000100`, `20261112000200` | O3: no travel time, verified HOS or Stage 2 | §9 Q20 | — |
| B5 | Plan the day: multi-load plan, hard constraints, priorities (incl. Keep crews together), approve through `assign_load` | MP B5; OPTIMIZATION.md | `(app)/dispatch/plan/**`, `src/lib/optimization/plan.ts`, `availability.ts`, `src/server/data/optimization.ts` | deployed · verified | unit optimization, optimization-feasibility, optimization-scale, plan-availability; e2e plan-the-day | none | Costs missing (§9 Q17) shown as missing; distances estimated and labelled | §9 Q17 | — |
| B50 | Hours of service: dispatcher confirms each driver's hours on Smart Dispatch / Plan the day approval; server refuses without it | MP B50 | `src/lib/hos/index.ts` (source "none"), approve actions in `(app)/dispatch/**` | deployed · verified | unit hos; e2e smart-dispatch, plan-the-day | none | HOS is not verified by Taviron (no ELD); manual board assignments unchanged | ELD/log source (§9 Q20) | — |
| B7 | Smart Dispatch Stage 2: whole-plan proposals, disruption repair, new-load evaluation, decision history | MP B7, §6.1 | none found | not started | — | B5 | — | — | Specify after B5 feedback |
| T6 | Smart Load Build increment 1: draft loads from one material line, payload ≤ usable capacity, dispatcher approval creates planned loads | MP §5; SMART_LOAD_BUILD.md | `src/lib/dispatch/load-build.ts`, `(app)/orders/[id]/load-build/`, `src/server/data/load-build.ts` | deployed · verified | unit load-build; e2e load-build | none | Increment 2: `src/lib/dispatch/trip-plan.ts` is unit-tested (unit trip-plan) but **imported by no page** (not wired, as documented) | Source of trip times (SMART_LOAD_BUILD §9) | Wire once the source is decided |
| B10 | Truck-aware route planner (first slice, HERE adapter) | MP B10; ROUTING.md | `(app)/route-planner/`, `src/lib/routing/route.ts`, `src/server/routing/here.ts`, `service.ts` | deployed · verified (straight-line mode) | unit routing; e2e route-planner | `20261112000500` | No HERE key → straight-line estimates only (labelled); no truck dimensions; GPS/ELD adapters not built | HERE key in Vercel (paid service terms) | Owner sets key; then verify road miles |
| T7 | Route & Conditions Intelligence (closures, frost laws, seasonal limits, weather) evaluated per trip | MP §6.2; IP §8 E | none | not started · blocked | — | Audit of free/official sources first | "No alert" must never mean "clear" | Provider choice; no paid service without approval | Source audit (research only) |
| B51 | Job site directions verification (kind, verified by/when, intervals, flagged on customer, order, My Day) | MP B51 | `verify_site_directions`; customer/order/driver pages; Settings | deployed · verified | db site-directions; e2e site-directions; db demo-samples; e2e demo-parity | `20261115000200` (hosted, Phase A) | Catalog entry `site-directions` is in_development, not published | Publication | Refresh demo data on hosted demos (owner) |
| B59 | Company CRM slice 1: prospect→customer, owner, tags, activities, follow-ups, opportunities, history, pipeline, CSV export, duplicate check | MP B59; GAP_ANALYSIS §3 | `(app)/customers/pipeline/`, `(app)/customers/export/route.ts`, `src/server/data/crm.ts`, `src/lib/crm/labels.ts` | deployed · verified | db customer-crm; e2e customer-crm | `20261119000100` (hosted, Phase A) | Not built: configurable stages, saved views, customer documents, self-serve import, AI summaries | — | — |
| B59b | CRM integrated email (per-company reply-to, inbound, threading) | MP B59; GAP_ANALYSIS §4 | Outbound quote email only (`src/server/email/provider.ts`) | blocked | — | Provider account, verified domain, inbound route, webhook signing secret | — | Provider + domain + secrets | — |
| B73 | Readable reference numbers (ORD-/QTE-/TKT-/BIL-/CUS-/MWO-), never reissued, searchable however typed | MP B73; REFERENCE_NUMBERS.md | `src/components/ui/copy-reference.tsx`, search keys in migration | implemented (Preview only) · verified · blocked | db reference-numbers; e2e reference-numbers; unit global-search | `20261120001300` (Phase B) | Table rewrite of 6 tables (seconds at current sizes, per the runbook) | Production promotion + Phase B | Promote, then Phase B |
| B11 | Company onboarding & CSV import (mapping, validation, duplicates, preview, history, reversal) | MP B11; ONBOARDING §1–3 | Platform-operator imports: `src/app/admin/onboarding/**`, `src/lib/platform/imports.ts`, `src/components/admin/import-uploader.tsx` | partial · deployed (operator imports) · verified | db onboarding; e2e onboarding | `20261020000100`, `20261024000100` | No self-serve company import; XLSX refused by design (`import-uploader.tsx` asks for CSV) (O9) | XLSX library (dependency approval) | Build self-serve import (company-scoped functions; owner applies the migration) |
| B44 | Release-readiness sprint items (demo persona names, dispatch edge cases, planner speed) | MP B44; IP §5ah | various; migrations `20261111000100`–`000300` | deployed · verified | db fleet, demo-samples; unit optimization-feasibility, theme-variants; e2e dispatch-availability, plan-the-day, long-names, demo-parity | hosted | — | — | — |
| T8 | Material calculator (L × W × D, tenant density, overage, reviewed transfer) | MP §7 | **None:** no `density` in `src/` or migrations | not started · undecided | — | Tenant density data | — | §9 Q3 | — |
| T9 | Distance pricing (tenant per-mile, base → site → base, overrides, audit) | MP §7 ("urgent"), §11 step 3 | **None:** only HERE route distances in the Route Planner | not started · undecided | — | Dispatch bases exist (B62) | Must avoid double-charging where hauling includes travel | §9 Q5, Q6, Q7 | Owner answers Q5–Q7 |
| T10 | Unified intake (calls, texts, email, walk-ins), AI drafts and a person reviews | MP §7 | none | not started · blocked | — | AI (B6), inbound email (B59b) | — | Provider + AI readiness | — |
| B9 | Customer operating intelligence (driver notes → proposed profile changes) | MP B9 | none | not started | — | Driver-notes capture; B6 | — | — | — |
| B12 | Scheduling views (calendar, timeline, board, map, coverage) on one data model | MP B12 | none found beyond the daily board | not started | — | Truck location source for the map (§9 Q20) | — | §9 Q20 (map) | — |
| B37 | Whole-fleet load matching, sequencing, backhauls | MP B37 | none | not started | — | B5, B10, HOS | — | — | — |
| B38 | Network design and strategic capacity | MP B38 | none | not started | — | Lane/cost history | — | — | — |

## 2. Fleet & maintenance

| ID | Requirement | Source | Implementation | Status | Evidence/tests | Dependencies/migrations | Known gaps & security notes | Owner decision/authorization needed | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T11 | Fleet registry: trucks/trailers with capacity and service status; driver qualifications | IP §5b | `(app)/fleet/**`, `src/lib/fleet/*`, `src/server/data/fleet.ts` | deployed · verified | db fleet; unit fleet-rules; e2e fleet | `20261013000100` | Missing capacity flagged, never assumed | — | — |
| T12 | Maintenance increment 1: truck work orders, labor, costs, preventive schedules (days/miles/hours), readings; a safety-critical defect blocks dispatch until authorized clearance | MP §6.3; IP §5w | `(app)/maintenance/**` (incl. `clearance`, `preventive`), `src/lib/maintenance.ts`, `src/server/data/maintenance.ts` | deployed · verified | db maintenance, dispatch-maintenance; unit maintenance-rules; e2e maintenance | `20261101000100`, `20261103000100` | Not built: parts, purchase orders, vendors, warranties, shop capacity | §9 Q22 defaults (who clears, warning windows, automatic preventive WOs) | — |
| T13 | Fleet management increment 1: vehicle documents (metadata, expiry), ownership, driver assignment history, derived availability, costs/downtime | IP §5x | `(app)/fleet/trucks|trailers/**`, `src/lib/fleet/availability.ts` | deployed · verified | db fleet-management; unit fleet-availability; e2e fleet-management | `20261102000100` | No document file upload (needs a private bucket) | §9 Q23 (files) | — |
| T14 | Expired vehicle documents policy: block/warn per kind, "Mark verified", enforced in `check_assignment` and mirrored in Smart Dispatch / Plan the day | MP §9 Q23 (decided 2026-10-13); IP §5ai | Settings → Dispatch rules (`(app)/settings/page.tsx`), `dispatch_document_issues` | deployed · verified | db document-policy; e2e document-policy; unit smart-dispatch | `20261112000200` | MP §9 Q23 text still says "Not built until decided" (stale) | — | Correct the MP text |
| B48 | Trailer work orders; trailer safety defects and shop visits block dispatch | MP B48 | Maintenance pages, eligibility codes `trailer_*` | deployed · verified | db trailer-work-orders; unit trailer-shop-rules; e2e maintenance | `20261115000100` (hosted, Phase A) | Preventive schedules are truck-only | — | Refresh hosted demos (owner) |
| T15 | Driver/dispatcher-reported vehicle issues become triaged maintenance requests | MP §9 Q4 | Field reports (`(app)/field-reports/**`, `src/server/data/field-reports.ts`); "Create a work order" from a trailer report | partial · undecided | e2e driver-portal, maintenance | — | No triage queue or severity on reports | §9 Q4 | — |
| T16 | Compliance documents: upload from phone, OCR draft, review, duplicate VIN/plate, 90-day expiry warnings; DVIR inspections | MP §6.3; COMPANION_APP §3 | none (no OCR; no upload for vehicle documents) | not started · undecided | — | Private storage; OCR provider | — | §9 Q12 scope | — |
| B23 | Compliance management and operational enforcement | MP B23 | Qualifications, document policy (T14) and maintenance clearance (T12) exist | partial · undecided | see T12, T14 | — | No jurisdiction rules; "missing evidence ≠ violation" | §9 Q12 | — |
| B13 | Maintenance ticket board, tasks, notifications centre, adaptive dashboards, load entry from email/documents | MP B13 | none | not started · blocked (notification channels) | — | Notification provider (approval) | — | Provider | — |
| B24 | Safety incidents, investigations, corrective actions | MP B24 | none | not started | — | Incident schema (migration) | — | — | — |
| B25 | Driver performance and coaching | MP B25 | none | not started · blocked | — | Telematics/ELD provider | — | Provider (paid) | — |
| B28 | Fuel and expense intelligence | MP B28 | none | not started · blocked | — | Fuel-card / accounting provider | — | Provider | — |
| B29 | Fleet lifecycle, TCO, investment analysis | MP B29 | none | not started | — | Acquisition/financing data; B28 | — | — | — |
| B33 | Procurement and supplier intelligence | MP B33 | none | not started | — | Vendors, POs (not built); B34 | — | — | — |
| B34 | Inventory and parts (movement ledger, no negative stock) | MP B34 | none | not started | — | Parts ledger migration | — | — | — |
| B35 | Warehouse, dock and yard scheduling | MP B35 | none | not started | — | Facilities model; ETA sources (B10) | — | — | — |

## 3. Delivery, billing & order-to-cash

| ID | Requirement | Source | Implementation | Status | Evidence/tests | Dependencies/migrations | Known gaps & security notes | Owner decision/authorization needed | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T17 | Delivery tickets: office entry, driver entry with photos, office scans, review queue, revisions, bulk accept, duplicate guard | IP §5d, §5h, §5k | `(app)/tickets/**` (incl. `scans`, `photos` routes), `src/lib/tickets`, `src/server/data/tickets.ts` | deployed · verified | db tickets, ticket-processing, ticket-photos; unit ticket-rules, ticket-processing; e2e tickets, ticket-processing, ticket-photos | `20261015000100`, `20261019000100`, `20261022000100` | S4: hosted `ticket-photos` bucket not confirmed; no OCR | — | Owner confirms bucket (S4) |
| T18 | Fulfillment and billing readiness: fully delivered → billable; a partial delivery stays out | MP §3, §8 O7; IP §5e | `(app)/billing/**`, `src/lib/billing/rules.ts`, `src/server/data/billing.ts` | deployed · verified | db billing; unit billing-rules; e2e billing | `20261016000100`, `20261114000100` | Final billing-quantity rule open | §9 Q9 | — |
| T19 | Invoice drafts: computed preview (accepted tickets × approved prices) | MP §7; IP §5n | `src/lib/billing/invoice-draft.ts` | deployed · verified | unit invoice-draft; db order-to-cash-chain | none | Not stored, approved, numbered, issued or exported | §9 Q10 | — |
| T20 | Billing handoff: CSV batches, audit, reversal, one handoff per key | MP §3 | `(app)/billing/batches/[id]/csv/route.ts`, `src/lib/billing/rules.ts` | deployed · verified | db billing, order-to-cash-chain; e2e billing | `20261016000100` | Not a QuickBooks import format (stated in code) | — | — |
| T21 | Invoice approval, issue, numbering, partial billing | MP §7, §9 Q10 | **None:** no invoice table in any migration | not started · undecided | — | — | — | §9 Q9, Q10 | — |
| T22 | QuickBooks / accounting export, duplicate-export prevention | MP §7; IP §8 A | **None:** billing and payroll CSVs say "NOT a QuickBooks format" | not started · blocked | — | Credentials; verified test company | — | Authorization + credentials | — |
| B42 | Order-to-Cash Control Center (lifecycle panels, state dimensions, AR, collections) | MP B42; IP §5aj | Increment 1: `(app)/order-to-cash/page.tsx`, `src/lib/order-to-cash.ts`, `src/server/data/order-to-cash.ts` (read-only) | partial · deployed (increment 1) · verified | unit order-to-cash; e2e order-to-cash | none | **Doc conflict:** MP B42 row says "queued — do not start"; IP §5aj records increment 1 built under owner authorization. Invoices/receivables/payments shown as "Coming soon" | §9 Q9, Q10, Q15 | Fix the MP row; wait for the decisions |
| B77 | Order-to-cash chain proven end to end by the roles that do each step | MP B77 | Test only | verified (test on Preview only) | db order-to-cash-chain (3/3 runs, 2026-10-20) | existing | Invoices and payments remain outside Taviron | — | — |
| B8 | Load profitability and pre-acceptance | MP B8 | none | not started · undecided | — | Cost data | Missing costs never assumed | §9 Q17 | — |
| B36 | Revenue, rate and pricing intelligence | MP B36 | none | not started · undecided | — | Cost data; market-rate source (approval) | — | §9 Q17 | — |
| B20 | Contract lifecycle and AI contract intelligence | MP B20 | none | not started · blocked | — | Private storage; AI (B6) | — | Storage, AI provider | — |
| B21 | Electronic signature workflows | MP B21 | none (no e-signature provider code) | not started · blocked | — | B20; paid provider | — | Provider (paid), secrets | — |
| B22 | Document automation (templates, generation, approvals, delivery) | MP B22 | Quote PDF only (T2) | partial | unit quote-pdf | Email provider; B21 | — | — | — |
| B39 | Connected freight ecosystem (EDI/API partners) | MP B39 | none | not started · blocked | — | Each partner is an approval | — | Per partner | — |

## 4. Command Center, alerts, search, reports

| ID | Requirement | Source | Implementation | Status | Evidence/tests | Dependencies/migrations | Known gaps & security notes | Owner decision/authorization needed | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T23 | Command Center: prioritized exceptions, assignment, role-aware sections, per-person layout/hiding | IP §5f, §5j; MP §8 P7 | `(app)/command-center/page.tsx`, `src/lib/command-center/rules.ts`, `src/server/data/command-center.ts`, `src/components/command-center/section-layout.tsx` | deployed · verified | db command-center, command-center-performance, coordination; unit command-center-rules; e2e command-center, coordination | `20261017000100`, `20261021000100`, `20261114000100`, `20261114000200`; `20261120001600` (ticket line index, local only, Phase B) | Intermittent e2e `command-center.spec.ts:59` (cause not found, GAP_ANALYSIS §7). **Root cause of the DB-test timeouts found 2026-10-22:** no index on `delivery_tickets.order_line_id`, so the billing views read every live ticket per order line (0.7–0.9 s per Command Center call for a ~900-order company; 250 ms with `20261120001600`; 8 timeouts → 0 on the same data). `billing_order_status` still aggregates all companies before filtering (~170 ms) | Hosted apply of `001600` [owner, Phase B] | Push the company filter into the billing views (view rewrite, tested) |
| T24 | Urgent office→dispatch coordination; one urgent indicator | IP §5j; MP §12 (`8052e65`) | `src/lib/command-center/urgent.ts` | deployed · verified | db command-center-urgent; unit command-center-urgent; e2e urgent-indicator | `20261119000200` (hosted, Phase A) | Escalation is a single time limit | §9 Q18 | — |
| T25 | Three alert priorities with safety minimums; acknowledgment ≠ resolution; critical stays until resolved | CLAUDE.md (owner 2026-10-20); COMMUNICATIONS.md | `alert_event_types.min_priority` (informational / action_required / critical), `(app)/communications/alerts/**` | deployed · verified | db operational-alerts | `20261105000300` | Escalation runs daily (Hobby cron) or on use; in-app only | Alert defaults (§9 Q25) | — |
| O4 | Command Center yellow/red severity model per §6.1 | MP §8 O4 | `PRIORITY_LABELS` Urgent/High/Normal in `src/lib/command-center/rules.ts` | partial | unit command-center-rules | — | Not mapped to warning/critical colours | — | Map priorities to tokens (`critical` only for genuine critical) |
| B55 | Taviron Live round 1: 7-day outlook (loads, gaps, trucks down, people off, value at risk) | MP B55 | `src/lib/live/outlook.ts`, `src/server/data/live.ts` | deployed · verified | unit live-outlook; e2e live-outlook | none | — | — | — |
| B70 | Global search across authorized records (header → `/search`) | MP B70 | `(app)/search/page.tsx`, `src/lib/search.ts`, `src/server/data/global-search.ts` | implemented (Preview only) · verified | unit global-search; e2e global-search | none | RLS through the person's session; filter-injection guarded (SECURITY_REVIEW) | Production promotion | Promote with the Preview bundle |
| T26 | Reports: delivered value, rework, billing turnaround, utilization, downtime; By Dispatch Base | MP §3; IP §5n; B62 | `(app)/reports/page.tsx` | deployed · verified | e2e dispatch-bases (report), reports-dates | `20261026000100` | No profitability/ROI; measured vs estimated must stay apart | §9 Q17 | — |
| B79 | Reports period typed MM/DD/YYYY with calendar alternative | MP B79 | `TypedDateInput` / `DateRangeFields` | implemented (Preview only) · verified | unit typed-date; e2e reports-dates | none | Shared `DateInput` unchanged | — | Promote |
| B30 | Executive command center and cross-department intelligence | MP B30 | none | not started | — | B8, B27–B29 data | — | — | — |
| B40 | Governed data and analytics platform (metric registry, API, BI) | MP B40 | none | not started · blocked (external access) | — | B18 first | — | API tokens/BI = approval | — |
| B16 | Data reliability findings (missing, duplicate, stale, anomalies) | MP B16 | Only the setup readiness checklist (`src/lib/onboarding/readiness.ts`) | not started | unit onboarding-readiness (checklist only) | B11 | — | — | — |

## 5. Multi-base & plan entitlements

| ID | Requirement | Source | Implementation | Status | Evidence/tests | Dependencies/migrations | Known gaps & security notes | Owner decision/authorization needed | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B62 | Dispatch bases: settings, per-person base access (RLS), base on records and forms, list filters, Smart Dispatch base rule, report | MP B62 | Settings → Dispatch Bases, `src/server/data/bases.ts`, `src/server/data/dispatch.ts` (board filter), `src/server/data/maintenance.ts` (work-order filter); model and matrix in ARCHITECTURE "Dispatch base access" | deployed (Phase A part) · implemented and verified locally (Phase B part) · pushed to Preview with this bundle | db base-scope (6), dispatch-bases, tenancy; unit smart-dispatch-bases; e2e dispatch-bases (incl. a base-limited dispatcher in the pages and through PostgREST) | `20261120000100`, `000200` (hosted, Phase A); `001700`, `001800`, `002000`, `002100`, `002200`, `002300` (local only, Phase B) | **2026-10-22 security fixes (each reproduced before, refused after):** Command Center items (`001700`) and counts (`002300`, a North dispatcher saw 53 orders instead of 1); other bases' order lines, loads, assignments, tickets, field reports, work orders and 13 history/document tables readable and writable through elevated-rights functions (`001800`, `002000`, statement-level guard checks every row: bulk, upsert, MERGE); shop schedule (`002100`); app roles' TRUNCATE/TRIGGER/REFERENCES and anon table grants removed (`002200`). Board and work-order base filters added. Residual: duplicate-ticket error text can name another base's ticket if the caller already knows a load id | Hosted apply of Phase B [owner] | — |
| T27 | Dispatch-base limit per plan enforced in the database | MP §5.1; B62 | `private.base_limit()` (`20261120000100`) | deployed · verified | db dispatch-bases | hosted | A company without a lifecycle plan defaults to **1 base** (includes Top Line until its plan is recorded) | Record Top Line's free-beta plan (console) | Owner records the plan |
| B63 | Plan demos (Essential / Growth / Professional) | MP B63 | Demo Management → Plan Shown (`src/app/admin/demo/page.tsx`) | deployed · verified | db demo-plans; e2e demo-plans | `20261120000300` (hosted) | — | — | Refresh hosted demos |
| T28 | Truck counting and truck limits per tier; overage 30-day grace; downgrade rule | MP §5.1, §10 | **None:** no truck limit in code (only bases) | not started · blocked | — | Subscription billing not authorized | — | Billing authorization (§10) | — |
| T29 | Features and limits per tier beyond trucks and bases (entitlements) | MP §9 Q14; B58 | Only per-company portal entitlement (`private.portal_entitlements`, `20261120000700`, Preview) | undecided | db customer-portal | Phase B | — | §9 Q14; which plans include the portal | — |
| B58 | Customer support centre (cases, notes vs replies, assignment, escalation) and feature controls | MP B58 | Partial base: Help → Contact Support → platform Support page (`(app)/help/contact`, `src/app/admin/support/page.tsx`) | partial | e2e help | — | No cases, assignment, replies inside Taviron | Plan → feature mapping | — |

## 6. Employee experience

| ID | Requirement | Source | Implementation | Status | Evidence/tests | Dependencies/migrations | Known gaps & security notes | Owner decision/authorization needed | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T30 | Communications: direct messages, groups, channels, operation workspaces, announcements with acknowledgment, presence, preferences, private attachments; 14-day retention, 5-min edit window, manager removal with reason | MP §5; IP §5aa, §5ac; COMMUNICATIONS.md | `(app)/communications/**`, `src/lib/communications.ts`, `src/server/data/communications.ts`, `/api/cron/comm-housekeeping` | deployed · verified | db communications, comm-attachments, comm-hardening, operational-workspaces; unit communications, cron; e2e communications, cron | `20261105000100`–`000400`, `20261107000100`, `20261108000100` | S6: the file purge needs `CRON_SECRET` (whether it is set is not confirmed in the repo) | Remaining §9 Q25 defaults | Owner confirms one cron run |
| T31 | Email / SMS / push delivery of notifications | COMMUNICATIONS "Not built"; COMPANION_APP §7 | **None** (no web push, no VAPID) | not started · blocked | — | Provider, keys, one migration (push subscriptions) | — | Provider + approval | — |
| T32 | Time-off requests (edit/withdraw while pending), approvals, approved absences in dispatch | MP §5; IP §5z | `(app)/time-off/**`, `src/lib/time-off.ts`, `src/server/data/time-off.ts` | deployed · verified | db time-off; e2e time-off | `20261104000100` | Coverage checks beyond dispatch availability not built | — | — |
| T33 | PTO banks, append-only ledger, balance checks; accruals (annual, hours worked, per pay period), caps, carryover | MP §9 Q24 (decided); IP §5ai | `(app)/time-off/balances/`, `src/lib/pto.ts`, `src/server/data/pto.ts` | deployed · verified | db pto-balances, pto-accruals; e2e pto-balances | `20261112000100`, `20261112000300` | Payroll/ELD hours integration not built (hours entered by hand) | — | — |
| T34 | Time-off approval chains | IP §5ak | Settings → Time off | deployed · verified | db time-off-chain; e2e time-off-chain | `20261112000400` | — | — | — |
| B46 | Work schedules: full-day requests use scheduled hours | MP B46 | Person page work schedule | deployed · verified | db work-schedules | `20261114000300` | — | — | — |
| B47 | Driver schedule notices (assigned / date or time changed) | MP B47 | Triggers + My Day notices | deployed · verified | db driver-notices; e2e companion | `20261114000500` | In-app only | — | — |
| T35 | Driver portal (My Day): assignments, instructions, tickets with photos, delay/breakdown reports | IP §5g, §5h | `(app)/driver/**`, `src/lib/driver`, `src/server/data/driver.ts` | deployed · verified | db driver-portal; unit driver-rules; e2e driver-portal | `20261018000100`, `20261031000200` | Breakdown location/repair coordination not built | — | — |
| B49 | Companion app (installable PWA): manifest, offline-page-only service worker, driver tab bar, freshness line, parked-only notice, Got it | MP B49; COMPANION_APP.md | `src/app/manifest.ts`, `public/sw.js`, `src/app/offline/page.tsx`, `src/lib/companion.ts`, `src/components/companion/*` | deployed · verified (Chromium only) | unit companion, service-worker, site-access; e2e companion, gate | none | **Not tested on a real iPhone/Android or iOS Safari**; documents and DVIR not built | Push (VAPID keys); native store apps (accounts) | Owner installs on a real phone |
| B45 | People: one list for employees and sign-ins; Settings in four groups | MP B45 | `(app)/employees/**`, `src/server/people/invite.ts`, `src/lib/people`, `src/server/data/people.ts` | deployed · verified | db employees; e2e employees, employee-login-link | `20261031000100`, `20261113000100` | Invitations need SMTP on hosted Auth (S4) | — | — |
| T36 | Profile self-service (photo with framing, display name, phone) | MP §5; HO `e96f6a5` | `(app)/profile/page.tsx` | deployed · verified | db profile; unit people-photo; e2e profile | `20261030000100` | — | — | — |
| B54 | Administrator identity in console, workspaces and demos | MP B54 | `src/server/data/profile.ts`, `src/app/admin/profile/page.tsx` | deployed · verified | e2e platform, profile | none | Touches `src/server/auth.ts` (approval tier) | — | — |
| B72 | Username sign-ins for employees and portal contacts, first-login password, role landing, turn off | MP B72; ACCOUNT_PROVISIONING.md | `(app)/employees/new-sign-in/`, `account-actions.ts`, `src/app/(auth)/welcome/`, `src/server/accounts.ts`, `src/lib/accounts.ts`, `src/lib/shared-device.ts` | implemented (Preview only) · verified · blocked | db account-provisioning, tenancy; unit accounts, usernames; e2e account-provisioning, portal-provisioning, username-login | `20261120001200` (Phase B; destructive for setup state) | The recorded "works on a Phase A database" check rolled back `000700`–`001100` only; none is recorded for `001200`–`001500` | Promotion + Phase B (auth core) | Run the Phase A check with `001200`–`001500` too |
| T37 | Custom roles and individual permission overrides; audited sensitive actions | MP §5 (Employee Management) | **None:** no custom roles; standard roles only | not started · undecided | — | — | — | Which actions are sensitive; whether custom roles are wanted | — |
| B27 | Driver payroll from accepted tickets: company formula engine, versioned rules, periods, exceptions, owner approval/lock, CSV by hash | MP B27; PAYROLL.md | `(app)/payroll/**` (incl. `periods/[id]/export/route.ts`), `src/lib/payroll/formula.ts`, `export.ts`, `src/server/payroll`, `src/server/data/payroll.ts` | deployed · verified | unit payroll-formula; db payroll; e2e payroll | `20261118000200`, `000400` (hosted, Phase A) | **Top Line's rules not configured** (no pay records); calculation off until a rule is approved; gross only; not a QuickBooks format | §9 Q16 | Owner provides rate sheets |
| B65 | Help Center: contextual help, search, articles, guides, Contact Support, platform Support page | MP B65 | `(app)/help/**`, `src/lib/help/*`, `src/components/help/*`, `src/server/help.ts`, `src/app/admin/support/page.tsx` | deployed · verified | db help-center; unit help-search, help-registry; e2e help | `20261120000400` (hosted) | AI help answers blocked; no authoring UI; catalog `help-center` not published | Publication | — |
| B26 | Workforce planning and staffing | MP B26 | none | not started · blocked | — | HOS data (ELD) | HOS never inferred | §9 Q20 | — |

## 7. AI & automation

| ID | Requirement | Source | Implementation | Status | Evidence/tests | Dependencies/migrations | Known gaps & security notes | Owner decision/authorization needed | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B6 | Shared AI runtime: `AiProvider`, OpenAI adapter, gates, ledger, budgets, tool registry (read/propose/execute) | MP B6; AI.md §1–§6 | `src/server/ai/{types,openai,config,gates,run,tools,evals}.ts`, `src/lib/ai/capabilities.ts`, `src/lib/ai/evidence.ts` | implemented · deployed (code) · blocked | unit ai-foundation (mocked provider); db ai-usage (real DB: ledger scope, append-only, idempotency) | `20261110000100` (hosted) | **Not verified:** no real model call; `EVAL_EVIDENCE = []`. Known: any member can inflate own company's usage; no budget reservation | `AI_PROVIDER`, `OPENAI_API_KEY`, model, `AI_MONTHLY_TOKEN_LIMIT` (secrets, paid usage) | Owner configures, runs `npm run ai:eval`, commits evidence only if passing |
| T38 | "Explain this plan" on Plan the day (pseudonymous facts, grounding checks, labelled) | AI.md §7 | `src/lib/ai/plan-explanation.ts`, `src/server/ai/plan-explanation.ts`, `explainPlan` in `(app)/dispatch/plan/actions.ts` | implemented · deployed (Blocked state) · blocked | unit ai-foundation (mocked); e2e plan-the-day (Blocked state only) | B6 | Earlier owner live eval superseded by test set v2 (`6ac1c51`) | As B6 | As B6 |
| B76 | Ask Taviron: read-only operational assistant | MP B76; AI.md §15 | `(app)/assistant/**`, `src/server/ai/assistant.ts`, `src/lib/ai/assistant.ts`, `src/server/data/assistant.ts` | implemented (Preview only) · blocked | unit ai-assistant, e2e ai-assistant (mocked / Blocked state) — **not verified** | B6; `AI_MODEL_OPS_ASSISTANT`, `ops_assistant` capability | Single-turn; no contextual entry points | As B6 | Promote; then owner configuration |
| T39 | AI in demo companies only when `AI_IN_DEMOS=on` | DEMO_TENANTS §2 | `src/lib/ai/capabilities.ts`, `src/server/ai/gates.ts` | implemented · verified (gate logic, mocked) | unit ai-foundation, demo-parity | — | — | Whether to turn on | — |
| B15 | AI readiness dashboard and audited adaptive learning | MP B15 | Partial: `/setup` "AI capabilities" shows gate states | partial | e2e plan-the-day (setup gate) | Migration for decision history/rules | No decision history or learned rules | — | — |
| T40 | Controlled autonomy: record recommendations, approvals, outcomes, failures | CLAUDE.md (owner 2026-10-20) | Smart Dispatch rejections audited; approvals via `assign_load`; HOS confirmation note | partial | db smart-dispatch | B15 | No unified decision/outcome history | — | Design with B15 |
| B61 | Taviron Live rounds 2–8 (exception lifecycle, Copilot, Scenario Lab, profitability, readiness forecast, portal, document-to-workflow) | MP B61 | Round 1 only (B55) | not started (rounds 2–8) · blocked (AI) | — | B6 evidence | — | AI configuration | — |
| B60 | Platform Marketing Center (AI execution, scheduling) | MP B60; GAP_ANALYSIS §5 | none | not started · blocked | — | Analytics/social/email providers; AI evidence | — | Providers | — |

## 8. Customer portal & commercial

| ID | Requirement | Source | Implementation | Status | Evidence/tests | Dependencies/migrations | Known gaps & security notes | Owner decision/authorization needed | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B14 | Customer self-service portal (product decision) | MP B14, §7 | Superseded in practice by B66 | undecided (per MP row) | — | — | **Doc conflict:** MP B14 says "do not build until scope is confirmed", MP §3 says "Absent", but B66 is built | Confirm B66 scope supersedes B14 | Reconcile MP rows |
| B66 | External customer portal (orders, loads, printable tickets, quotes answer for staff confirmation, quote requests, support, help, tracking links) + Testing Lab | MP B66; CUSTOMER_PORTAL.md | `src/app/portal/**`, `src/app/track/[token]/`, `(app)/customer-portal/**`, `src/server/portal.ts`, `src/server/portal-invite.ts`, `src/lib/portal.ts`, `src/app/admin/testing-lab/`, `src/lib/platform/testing-lab.ts` | implemented (Preview only) · verified · blocked | db customer-portal, demo-samples; unit portal; e2e customer-portal, testing-lab, portal-provisioning | `20261120000700`, `000800` (Phase B) | Not built: invoices/payments in portal, emailed invitations, custom domains. Security findings F1/F4/F5/F7 fixed in `001100` (Phase B) | Which plans include the portal; email provider | Promote + Phase B |
| B74 | "Remove sample data" also removes sample customers' portal messages | MP B74 | Function change | implemented (Preview only) · verified · blocked | db quotes, orders, order-management | `20261120001400` (Phase B) | — | Phase B | — |
| B31 | Customer intelligence portal and business reviews | MP B31 | none | not started · undecided | — | B14/B66 scope | — | B14 | — |
| B32 | Customer success and account growth intelligence | MP B32 | none | not started | — | B20, support records, B31 | — | — | — |
| B52 | Platform Launchpad: counts, needs-attention, activity, company directory, audited demo refresh | MP B52 | `src/app/admin/page.tsx`, `src/app/admin/companies/**`, `src/lib/platform/launchpad.ts` | deployed · verified | db platform-launchpad; e2e platform | `20261118000100` (hosted) | Console dashboard not customizable; no integrations/support tabs; system health partial (GAP_ANALYSIS §1) | — | — |
| B53 | Customer lifecycle: KPIs, versioned plans (§5.1 = v1), subscription per company (plan, terms, offer, agreed amount), onboarding fee, go-live earlier-only, Go Live Now with password, scheduled activation, annual cancellation balance | MP B53; PLATFORM_LIFECYCLE.md | `src/app/admin/plans/page.tsx`, `src/components/admin/subscription-card.tsx`, `src/server/reauth.ts`, `src/lib/platform/lifecycle.ts`, `/api/cron/lifecycle-activation` | deployed · verified | db platform-lifecycle; e2e platform, cron | `20261118000300` (hosted); `CRON_SECRET` | No charge, invoice or email anywhere; Top Line free beta not set automatically | Payment provider; Top Line plan entry | Owner sets Top Line's offer |
| T41 | Trials | MP §5.2 ("no free trial", confirmed) | — | not applicable | — | — | — | — | — |
| T42 | Discounts: founding 20% (private, first 10), annual 10% | MP §5.1, §10 | Stored only in private lifecycle data (B53); never on the public site | partial (recorded, not charged) | db platform-lifecycle; unit platform (no founding data public) | — | **Doc conflict:** MP §10 says "discounts do not stack"; PLATFORM_LIFECYCLE says whether founding + annual combine is the owner's decision (amount typed by hand) | Confirm stacking rule | Owner confirms; align the doc |
| T43 | Onboarding fee received/waived | MP §10; B53 | Subscription card | deployed · verified (recording only) | db platform-lifecycle | — | No payment collection | Payment provider | — |
| T44 | Cancellation, 90-day post-access retention, free export, then delete/anonymize | MP §10 | Annual cancellation balance only (B53) | partial | db platform-lifecycle | B17, B18 | No retention clock, export bundle or deletion workflow | Final retention policy (legal) | — |
| B57 | Failed-payment enforcement (grace, restriction, webhook restore) | MP B57, §10 | **None** (no payment provider code) | not started · blocked | — | Payment provider | Never delete data for non-payment | Provider + billing authorization; in-delivery policy | — |
| T45 | Subscription billing: charges, invoices/receipts, payment methods, taxes, renewal and price-change notices, self-service billing | MP §10 | **None** (no Stripe or other processor code) | not started · blocked | — | Processor, tax, legal | — | §9 Q13, Q15; explicit authorization | — |
| B68 | Guided customer onboarding checklist (company `/setup` + Taviron view), documents, CSV via existing importer | MP B68; ONBOARDING §4 | `(app)/setup/actions.ts`, `src/app/admin/onboarding/[companyId]/`, `checklist-actions.ts`, `src/lib/onboarding/tasks.ts`, `src/server/data/onboarding.ts`, `src/app/onboarding/documents/**`, `templates/[entity]` | implemented (Preview only) · verified · blocked | db guided-onboarding; unit onboarding-tasks; e2e guided-onboarding, demo-parity | `20261120001000` (Phase B; destructive for checklist data on rollback) | Not yet: manual tasks, templates, Launchpad attention item, email reminders | Email provider for reminders | Promote + Phase B |
| B75 | Onboarding Kit (questionnaire, templates, worksheet, integration checklist, go-live acceptance signed by owner + Taviron) | MP B75; ONBOARDING §5 | `(app)/setup/kit/`, `kit-actions.ts`, `src/app/admin/onboarding/[companyId]/kit/`, `src/lib/onboarding/kit.ts`, `kit-validate.ts`, `src/server/data/onboarding-kit.ts` | implemented (Preview only) · verified · blocked | db onboarding-kit; unit onboarding-kit; e2e onboarding-kit | `20261120001500` (Phase B) | **Hosted risk:** companies with a checklist cannot go live until acceptance is signed; check scheduled go-lives before the push | Phase B | — |
| B19 | Customer implementation management (plans, sign-offs, go-live approval) | MP B19 | Covered in part by B68 + B75 | partial | see B68, B75 | B11, B15, B18 | — | — | — |
| B41 | SaaS operations (configuration validation, adoption, support escalation, service health) | MP B41 | `/setup` checklist only | partial | unit onboarding-readiness | Monitoring/support systems | — | Access, billing | — |
| B67 | Archive and delete practice companies; KPI/MRR exclusion | MP B67 | `src/components/admin/company-lifecycle-controls.tsx`, admin company page | deployed · verified (classification/archive); permanent delete off | db company-classification; e2e company-archive | `20261120000500` (hosted); `20261120000600` delete switch (hosted; its code on Preview only) | Delete refused while the DB switch is off; hosted `session_replication_role` permission unverified | Whether to ever turn delete on | — |

## 9. Security & infrastructure

| ID | Requirement | Source | Implementation | Status | Evidence/tests | Dependencies/migrations | Known gaps & security notes | Owner decision/authorization needed | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T46 | Sign-in, sign-up, password reset, auth callbacks; unconfirmed emails named | IP §5i; MP §5 | `src/app/(auth)/*`, `src/app/auth/*`, `src/server/auth.ts` | deployed · verified | e2e auth; unit safe-redirect | — | S4: hosted SMTP, templates and URL configuration not confirmed | Owner configures SMTP (DEPLOYMENT §1) | — |
| B69 | Two-step verification (TOTP), mandatory for platform admins, optional company policy, recovery codes | MP B69; CUSTOMER_PORTAL §3 | `src/app/mfa/`, `src/server/mfa.ts`, `src/components/security/company-mfa-policy.tsx` | implemented (Preview only) · verified · blocked | db mfa; unit mfa-totp; e2e mfa | `20261120000900` (Phase B) | Every platform admin must enroll **before** the push | Promotion (auth core) + Phase B | Owner enrolls authenticator, then Phase B |
| B71 | Security hardening after 2026-10-19 review (F1–F7) | MP B71; SECURITY_REVIEW_2026-10-19.md | `20261120001100`; `src/app/portal/actions.ts`, `src/server/portal-invite.ts` | implemented (Preview only) · verified · blocked | db security-hardening, help-center; e2e customer-portal | `20261120001100` (Phase B) | 4 hosted checks open (aal1 second-factor enrolment, admins enrolled, `session_replication_role`, invite email template) | Owner hosted checks | Run the 4 hosted checks after Phase B |
| T47 | Account recovery: password reset, MFA recovery codes (single use, rate-limited) | CUSTOMER_PORTAL §3 | `(auth)/forgot-password`, `update-password`; `mfa_recovery_redeem` | partial (reset deployed; recovery codes Preview only) | e2e auth, mfa; db mfa | Phase B | — | — | — |
| T48 | Tenant isolation: `company_id` + RLS on every business table; SECURITY DEFINER with `search_path = ''` on the reviewed list | CLAUDE.md; MP §2 | All migrations; `tests/db/tenancy.test.ts` list | deployed · verified | db tenancy, permissions, coordination; e2e tenancy, permissions, roles | — | B62 summary-count gap (see B62) | — | — |
| T49 | Platform owner granted only by `scripts/platform-admin.mjs`; no route grants it | CLAUDE.md; IP §5m | `scripts/platform-admin.mjs`, `private.platform_admins`, `src/server/platform.ts` | deployed · verified | db platform; e2e platform | `20261024000100` | — | — | — |
| T50 | Early-access gate: personal site codes + shared password; never signs anyone in | MP §5; IP §5l, §5v | `src/proxy.ts`, `src/server/site-access.ts`, `src/lib/shared-password.ts`, `src/app/early-access/` | deployed · verified | db site-access, shared-early-access; unit site-access, shared-password, early-access; e2e gate | `20261023000100`, `20261029000100` | **S2: `SITE_ACCESS_SECRET` rotation unverified** (appeared in a screenshot) | Owner rotates | Owner rotates and redeploys |
| T51 | Audit history on consequential actions | MP §2 | Per-module audit tables/events; `private.platform_audit` | deployed · verified (per module) | module DB tests (e.g. db order-management, platform, customer-crm) | — | No single company-wide audit view | — | — |
| B56 | Restricted support sessions (read-only default, approved elevation, expiry, banner) | MP B56 | **None** | not started · undecided | — | — | Today the platform admin has no support-session model | Who approves the owner's own elevation | — |
| T52 | Backups and tested restore | MP §8 S3; BACKUP_RESTORE.md | Doc + local `pg_dump` before local migrations | partial · blocked | — | Hosted Supabase Free has no automatic backups (runbook §2) | **No restore drill recorded** | Plan/cost decision (S3) | Owner decides plans; weekly `pg_dump` meanwhile |
| T53 | Preview/production separation (`main` → Production on mytaviron.com; separate DB) | DEPLOYMENT §2b; MP §5 | Not configured | partial · blocked | GitHub deployment records | — | Preview and Production share one Supabase project | Owner performs §2b | — |
| B17 | Privacy & data lifecycle governance (classification, retention catalog, legal holds, privacy requests, governed deletion) | MP B17 | Only Communications retention + legal hold (`20261105000100`, `20261108000100`) | partial | db comm-hardening | Legal review of periods | No privacy-request workflow | Retention policy approval | — |
| B18 | Customer data portability (versioned exports, dry runs, reconciliation) | MP B18, §10 | Partial: customers CSV (`(app)/customers/export/route.ts`), billing CSV, payroll CSV | partial · undecided | e2e customer-crm, billing, payroll | — | No company-wide export | §9 Q11 formats | — |
| T54 | Observability: error monitoring, job/integration health | GAP_ANALYSIS §1; MP §7 reliability | **None:** no error-monitoring SDK; `src/server/errors.ts` maps DB errors to safe messages only | not started | unit errors | — | Failed cron runs only visible in Vercel logs | Any paid monitoring needs approval | Propose a free option |
| B3 | Continuous development foundation: workflow, risk classifier, CI | MP B3 | `scripts/release/risk.mjs`, GitHub Actions CI | deployed · verified | unit release-risk; CI runs | — | — | — | — |
| S5 | `npm audit` advisories | MP §8 S5 | dev-only lint chain | not applicable (reviewed, low) | `npm audit` | — | Never `--force` | — | Re-check on `eslint-config-next` update |
| T55 | Secrets server-only; never `NEXT_PUBLIC_`; never in logs | CLAUDE.md; AI.md §3 | `src/server/env.ts`, `src/server/ai/config.ts` | implemented · verified (config tests) | unit ai-foundation | — | — | — | — |

## 10. Website & presentation

| ID | Requirement | Source | Implementation | Status | Evidence/tests | Dependencies/migrations | Known gaps & security notes | Owner decision/authorization needed | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B78 | Website transformation: positioning, dropdown nav, six platform-area pages, three solutions pages, Trust, FAQ, footer groups, sitemap | MP B78; MARKETING §7 | `(site)/platform/[area]`, `(site)/solutions/[segment]`, `(site)/trust`, `(site)/faq`, `src/lib/site/{nav,areas,faq,pricing-faq}.ts`, `src/app/sitemap.ts` | implemented (Preview only) · verified | unit site-areas; e2e website, home-hero, platform, marketing | none (`src/proxy.ts` matcher gains `sitemap.xml`) | Public site stays behind the gate | Launch/indexing approval | Promote with the bundle |
| B4 | Homepage hero | MP B4; WEBSITE_3D.md | Production runs the 3D story; Preview has the static hero with the real product (`9e0282d`) | implemented (Preview only) · verified | e2e home-hero | — | `three` / `@types/three` still in `package.json` though no `src/` file imports them; release-highlights registry `src/lib/site/releases.ts` is imported nowhere | — | Remove unused dependency (review tier) |
| W1 | Pricing page: five tiers, annual, onboarding fees, Book a Demo / Contact Us, no founding mention, no checkout | MP §5.1, §8 W1 | `(site)/pricing/page.tsx`, `src/lib/site/pricing.ts` | deployed · verified | unit platform (tier table, tier fit, no founding data); e2e platform, website | — | Tax wording absent (W7) | Public launch approval | — |
| W2 | Taviron palette; red only for critical | MP §4, §8 W2 | `src/app/globals.css` tokens, `src/lib/theme.ts` | deployed · verified | unit theme, theme-variants; e2e theme | — | Production brand package (vector masters etc.) not produced | — | — |
| T56 | Light/dark mode via `data-theme`, never `dark:` | IP §5u; CLAUDE.md | `src/lib/theme.ts` | deployed · verified | unit theme-variants; e2e theme | — | — | — | — |
| W3 / W5 | Demo-request form (required counts) and six lead statuses with spam flag | MP §5.2, §8 W3, W5 | `(site)/demo/page.tsx`, `src/components/site/lead-form.tsx`, `/api/leads/route.ts` (rate-limited), `src/app/admin/leads/**` | deployed · verified | db platform; e2e platform | `20261028000100` | — | — | — |
| W4 | Lead emails (prospect confirmation, team notification) | MP §8 W4 | `src/server/leads/notify.ts`, `src/lib/site/lead-emails.ts` | implemented · blocked | unit email, email-html | Email provider + domain | Every attempt recorded "not sent" | Real-email approval | — |
| W6 | Lead follow-up reminders (1 and 3 business days) | MP §5.2, §8 W6 | **None:** the only crons are comm-housekeeping and lifecycle-activation (`vercel.json`) | not started · blocked | — | Cron + secret; email provider | — | Approval (new cron, email) | — |
| W7 | Legal pages reviewed; tax wording | MP §8 W7 | `(site)/privacy`, `(site)/terms` (metadata says "draft") | partial · blocked | e2e website | — | — | Legal review | — |
| T57 | Guided demo | MP §5.2; MARKETING §7 | Walkthrough request led by the Taviron team (`(site)/demo`); no interactive website demo | partial · undecided | e2e website | — | — | Whether to build an interactive demo | — |
| B1 | Demo feature parity in every demo mode (shared idempotent samples, Refresh) | MP B1; DEMO_TENANTS | `src/server/demo/samples.ts`, `seed.ts`, `prairie-lantern*.ts`, `northfield-refresh.ts`, `src/app/admin/demo/page.tsx` | deployed · verified | unit demo-parity; db demo-samples, prospect-demo; e2e demo-parity | Phase B features show "needs a database update" in demos | Field reports have no samples; Refresh is a button | Owner runs Refresh on hosted demos after each push | Owner: Refresh |
| B2 | Demo experience: photo, one-time welcome, Change view, presentation mode | MP B2; IP §5ae | `src/app/(app)/demo-actions.ts`, `src/lib/platform/preview.ts` | deployed · verified | e2e demo-experience | `20261109000100` (hosted) | — | — | — |
| B43 | Feature catalog, screenshot pipeline and quality gate, catalog-driven pages | MP B43; MARKETING §1–§6 | `src/lib/site/features.ts`, `capabilities.ts`, `screenshots.json`, `scripts/capture-screenshots.mjs` | deployed · verified | unit feature-catalog, site-capabilities; e2e marketing | — | Unpublished: site-directions, order-to-cash, CRM, payroll, AI explanation, route planner, dispatch bases, customer portal, help center; MARKETING §6 still calls route planning "planned" while the catalog says available | Publication is a person's decision | Update catalog after Phase B |
| B64 | Visual alignment, terminology, 2026-10-19 design audit fixes | MP B64; DESIGN_AUDIT_2026-10-19.md | `src/lib/layout.ts`, `src/lib/terminology.ts`; fixes `cb3963c` | partial (alignment deployed; audit fixes Preview only) · verified | e2e sidebar, platform | — | Not-found title / HTTP 200 under the loading boundary; `/early-access` and portal sign-in not yet audited | — | Fix not-found status |
| T58 | SEO: noindex unless `SITE_INDEXING=on`; robots; sitemap | MP §5; MARKETING §7 | `src/app/layout.tsx` (`index: false`), `src/app/robots.ts`, `src/lib/site/indexing.ts`, `src/app/sitemap.ts` (Preview only) | partial (robots deployed; sitemap Preview only) · verified | e2e website, gate | — | Indexing off | Launch/indexing approval | — |
| T59 | Website analytics | MARKETING §7; GAP_ANALYSIS §5 | **None** (privacy notice says no analytics cookies) | undecided | — | — | — | Privacy decision + provider | — |
| T60 | Website screenshots from the real app (quality gate) | CLAUDE.md; SCREENSHOTS.md | `scripts/capture-screenshots.mjs`, `docs/screenshots` | partial | e2e marketing | — | New areas lack screenshots | — | Capture after promotion |
| T61 | Branding per company workspace, "Powered by Taviron" | MP §4; IP §5o | `src/lib/branding.ts`, `(app)/brand/logo/route.ts` | deployed · verified | unit dates-and-branding; e2e branding | `20261027000100`, `20261027000200` | — | — | — |

---

## 11. Claimed but missing, or docs contradicting the code (found in this audit)

1. **Smart Load Build increment 2:** `src/lib/dispatch/trip-plan.ts` is tested but not imported by any page. The docs
   say this too ("not wired").
2. **Release highlights registry:** `src/lib/site/releases.ts` is imported nowhere (MP B4 says "still unused").
3. **`three` / `@types/three`** remain dependencies after the 3D story was retired on Preview. No `src/` file imports
   them.
4. **MP §3 status table (2026-10-11) is stale.** It still says Customer portal "Absent", Fleet "Partial (no
   maintenance)" and so on. IP §8 roadmap rows are stale the same way: PTO "Planned", maintenance "Planned", global
   search "Partial".
5. **MP B14** says the customer portal must not be built until scope is confirmed; **B66 is built** (Preview).
6. **MP B42** says "queued — do not start"; **IP §5aj** records increment 1 (`/order-to-cash`) built and it is in
   Production.
7. **MP §9 Q23** still ends with "Not built until decided"; the policy is decided and built (`20261112000200`).
8. **Discount stacking:** MP §10 says "discounts do not stack", but PLATFORM_LIFECYCLE leaves founding + annual to the
   owner.
9. **MARKETING §6** calls route planning "planned"; `features.ts` has `route-planner` status `available`, not
   published.
10. **ONBOARDING §1** says people are invited in "Settings → Users"; that page now redirects to People (B45).
11. **`CRON_SECRET`:** PLATFORM_LIFECYCLE says it "exists for comms". Nothing in the repo confirms it is set on
    Vercel (MP §8 S6 still lists it as pending).
12. **"Works on a Phase A database":** this was recorded with `000700`–`001100` rolled back. No such check is recorded
    for `001200`–`001500`.
13. **No truck-count limit exists in code.** Only dispatch-base limits are enforced, while the tier table limits both.
    It is not claimed as built, but it is a gap against §5.1 / §10.

## 12. Open owner decisions

From MP §9 (open unless noted) and the undecided items above. Each line gives the options, then what follows.

| # | Decision | Options → consequence |
| --- | --- | --- |
| Q1 | Who creates employee accounts | Company admins invite (B45/B72 already allow it) vs Taviron creates them during onboarding. The answer sets the onboarding steps and B68 tasks. |
| Q2 | Can dispatchers edit Smart Dispatch's load breakdown before approval | Yes → editor plus re-validation in B7. No → approve or reject only. |
| Q3 | Irregular material areas | Multiple rectangles vs one area. The answer sets the material calculator (T8) inputs. |
| Q4 | Reported vehicle issues → maintenance requests | Automatic request with triage vs manual creation by the office. The answer sets T15 and B13. |
| Q5–Q7 | Distance pricing: which base; per-mile vs bands vs both; automatic on quotes with overrides | These answers unblock T9 (marked urgent in MP §7). |
| Q8 | Order types for internal orders and transfers | Unblocks O1 (required fields at confirmation). |
| Q9 | Billing quantity when tickets are missing or partly accepted | Ordered vs delivered. The answer sets T18, invoice drafts and B42. |
| Q10 | Invoice numbering, issuance, partial billing, accounting export; whether Taviron issues invoices | Issue in Taviron → T21 and an invoice table. No → keep the handoff CSV and QuickBooks export (T22). |
| Q11 | Customer data export formats and workflow | Unblocks B18 and the export side of T44. |
| Q12 | Initial compliance scope | Unblocks T16, B23 and DVIR. |
| Q13 | Recurring billing on the go-live anniversary vs the 1st of the month | Needed before any subscription billing (T45). |
| Q14 | Features and limits per tier beyond trucks and bases | Sets entitlements (T29, B58) and which plans include the portal (B66). |
| Q15 | Final legal terms, tax, payment processor, public-pricing approval | Unblocks W7, T45, B57 and launch. |
| Q16 | Driver pay formulas, periods, approvals, export format | Unblocks Top Line payroll (B27 is built; no rule is configured). |
| Q17 | Cost data for profitability | Unblocks B8, B36 and profitability reports. |
| Q18 | Urgent-order escalation beyond one time limit | Business hours, holidays, who is notified. |
| Q19 | N15 rules awaiting confirmation (report blocks, capacity overruns, location to schedule, "fully delivered") | Confirm or change the current behaviour. |
| Q20 | Smart Dispatch preferences; ELD/log source; truck locations | Unblocks verified HOS (B50), B26 and the B12 map. Keep crews together is decided (off by default). |
| Q22 | Maintenance defaults (who clears, own repair, warning windows, automatic preventive WOs) | Confirm the defaults. Automatic WOs need a scheduler. |
| Q23 (files) | Store vehicle document files in Taviron | Yes → private bucket + upload. No → metadata only (current). |
| Q25 (rest) | Communications defaults (history for new members, active-delivery holds, auto-archive, escalation, email/SMS/push) | Push/email need a provider (T31). |
| B56 | Who approves the platform owner's own support elevation | Required before B56 can be designed. |
| B57 | Payment provider; in-progress-delivery policy during restriction | Unblocks B57 and T45. |
| T42 | Do founding and annual discounts combine | MP §10 "do not stack" vs a typed amount in the console. |
| T37 | Custom roles / overrides; which actions count as sensitive | Unblocks T37. |
| T57 / T59 | Interactive website demo; website analytics (privacy) | Each needs a decision before it is built. |
| AI | Provider key, models, monthly token limit, `AI_IN_DEMOS` | Moves B6, T38 and B76 from Blocked to Needs review, then Ready after a passing eval. |
| Launch | Public site launch, indexing, removal of the gate | MP §2: founder only. |

## 13. Blocked items

| Item | Blocked on | Who |
| --- | --- | --- |
| Phase B migrations `20261120000700`–`001500` (B66, B68, B69, B71, B72, B73, B74, B75) | Production running MFA-screen code (promotion of the Preview bundle, approval tier: auth core), every platform admin enrolled, TOTP on in Supabase | Owner |
| Production promotion of `e488ef2` (B70, B76, B78, B79 and the above) | Release checks (VER2 re-run in progress) + owner approval (auth core tier) | Owner (after green checks) |
| AI capabilities (B6, T38, B76, B15, B61, B60, AI help, CRM AI) | Provider key, model, token limit, passing `npm run ai:eval` | Owner |
| Lead emails (W4), reminders (W6), CRM email (B59b), invitations by email, notifications (T31), onboarding reminders (B68) | Email provider + verified domain (+ inbound, signing secret for B59b); push keys | Owner |
| Subscription billing, failed payments, discounts charged (T45, B57, T28) | Billing authorization, processor, tax, legal (§9 Q13, Q15) | Owner |
| QuickBooks / accounting (T22) | Credentials, authorization, test company | Owner |
| Road routing (B10 road miles) | HERE key | Owner |
| Verified HOS, workforce planning (B50 upgrade, B26) | ELD/log source (§9 Q20) | Owner |
| Backups/restore (T52), prod/preview split (T53) | Plan/cost decision; DEPLOYMENT §2b steps | Owner |
| `SITE_ACCESS_SECRET` rotation (T50/S2), SMTP + templates (S4), `ticket-photos` bucket (S4), `CRON_SECRET` confirmation (S6) | Owner actions in Vercel/Supabase | Owner |
| Order types (O1), material calculator (T8), distance pricing (T9), invoices (T21), compliance (T16) | §9 Q8, Q3, Q5–Q7, Q9–Q10, Q12 | Owner |
| Top Line payroll (B27) | Pay rules / rate sheets (§9 Q16) | Owner |

## 14. Top next implementation actions (ordered)

Order: release blockers, security and data integrity → broken functionality → critical workflows → missing
agreed features → AI/UX → commercial/website. **[owner]** marks a step that needs owner authorization or action.

1. Finish the VER2 re-run on `e488ef2`. Record the results in SESSION_HANDOFF and fix any regression before
   promotion. *(Independent.)*
2. Extend the "works on a Phase A database" check: roll back `001200`–`001500` as well as `000700`–`001100`
   locally, run the affected specs (people, employees, portal, orders, quotes, setup, admin onboarding) and record
   the result in the runbook §14. *(Independent; local backup first.)*
3. ~~Close the B62 summary-count leak~~ — done locally 2026-10-22 (`20261120001700`, items and counts; hosted apply is Phase B). Original note: make the SECURITY DEFINER Command Center summary/exception counts honour base
   access for base-restricted people. Add a DB test and a migration with a tested rollback. *(Independent to build;
   hosted apply **[owner]**.)*
4. **[owner]** Promote the verified Preview to Production (approval tier). Then Phase B: enroll an authenticator
   (TOTP on), confirm no checklist company is about to go live, back up, `db push` the 9 migrations, run the runbook
   verification SQL and the 4 hosted checks from SECURITY_REVIEW, then Refresh demo data.
5. **[owner]** Rotate `SITE_ACCESS_SECRET` (S2). Confirm `CRON_SECRET` and one successful run of each cron (S6). Decide
   the backup plan (S3). Configure SMTP, templates and URLs and confirm the `ticket-photos` bucket (S4).
6. Fix the known broken behaviour: the not-found page's title / HTTP 200 under the loading boundary (B64). Find the
   cause of the intermittent `command-center.spec.ts:59`. *(Independent.)*
7. Finish the B62 scope: base filter on the dispatch board and on maintenance lists, with e2e coverage in the
   Dispatcher and Mechanic demo modes. *(Independent; no migration expected.)*
8. Self-service CSV import for company administrators (B11 / ONBOARDING §3 step 1), reusing the staging → approve →
   revert model. *(Build independently; migration apply **[owner]**.)*
9. Reconcile the docs listed in §11 (MP §3 table, B14, B42, §9 Q23 text, MARKETING §6, ONBOARDING §1) and remove the
   unused `three` dependency and `releases.ts` (or wire it). *(Independent; docs ride with the next code
   checkpoint.)*
10. **[owner]** Configure AI (key, models, token limit), run `npm run ai:eval` for `plan_explanation` and
    `ops_assistant`, and commit the evidence only if it passed. Then verify Ask Taviron in Limited/Ready state.
11. After Phase B: update the feature catalog. Mark dispatch bases, help center, customer portal, CRM and payroll per
    their real state; publication stays **[owner]**. Capture screenshots for the new platform areas through the
    quality gate.
12. **[owner]** Answer §9 Q8 (order types) and Q5–Q7 (distance pricing). Then build O1 and T9, the next critical
    workflows in MP §11 step 3.
