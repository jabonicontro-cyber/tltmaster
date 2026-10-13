# Taviron master plan

Last updated: 2026-10-11 (after N15, consolidated from the founder's master context). This is the one
authoritative plan: product direction, decisions, proposals, open questions, outstanding fixes and the
roadmap order. Build details per milestone are in `docs/IMPLEMENTATION_PLAN.md`; current deployment state
and owner actions are in `docs/SESSION_HANDOFF.md`.

**How to read the labels**
- **Confirmed** — decided by the founder; binding.
- **Proposal** — a working figure or design; not to be published or built as final without approval.
- **Open** — no decision yet; never invent an answer (§9).
- Status words for code: *working* (built and tested locally), *partial*, *placeholder*, *absent*. Nothing
  here is "verified on staging" unless it says so — the staging database has not been checked from a session.

---

## 1. What Taviron is for

An integrated operating system for hauling companies, material suppliers and dispatch operations — not a set
of disconnected screens. One record per job, carried through every stage:

> customer request → quote or approved pricing → order → dispatch → delivery ticket → fulfillment →
> billing → invoice → accounting handoff → payroll inputs

Employees never re-enter a job in another module. Operational correctness, safety, data integrity and reliable
workflows come before feature count.

**Product areas:** customers, quotes, contracts, orders · dispatch, Smart Dispatch · Route & Conditions
Intelligence · fleet maintenance, mechanics, compliance · material calculator and distance pricing · delivery
tickets, fulfillment, billing, invoices, accounting · payroll inputs and reporting · customer portal · driver
mobile · company administration, integrations, audit history, data quality.

## 2. Architecture rules (confirmed, in force)

- **Tenant isolation is server-side:** every business table has `company_id` and RLS; APIs, server functions,
  storage, reports, exports, notifications, search and audit history all respect it. Hiding a button is never
  authorization.
- **Three separate areas:** public marketing pages · each company's authenticated workspace · the restricted
  Taviron platform area (`/admin`, platform role granted only by `scripts/platform-admin.mjs`).
- Least privilege, server-side validation, uniqueness constraints, idempotency, audit history and honest error
  handling on every consequential action.
- **Demo tenants stay in sync with the product** (permanent, confirmed 2026-10-12): one application for every
  company; demo companies differ only by data and the documented safety differences (docs/DEMO_TENANTS.md §2,
  enforced by tests); demo compatibility is part of every feature's definition of done; nothing real leaves a demo.
- **Demo feature parity in every demo mode** (permanent, confirmed 2026-10-12): every released feature is demonstrable
  in each role preview that can use it (Owner, Dispatcher, Dispatcher who also drives, Office, Driver, Mechanic, and any
  later mode), with realistic sample data from the shared idempotent helper, delivered to existing demos by Refresh
  without duplicates or losing demo users. A feature is not complete until its demos are (DEMO_TENANTS §3).
- **Recommendations never act on their own.** Smart Dispatch, invoice drafts and any future AI extraction only
  propose; an authorized person approves.
- **Honest data:** never invent prices, quantities, dates, customer terms, material properties, truck
  capacities, pay rules, testimonials or metrics. Missing data is shown as missing; estimates are labelled.
- No deploy to production, public launch, indexing, removal of the early-access gate, publication of legal
  terms, paid services or destructive data operations without the founder's explicit approval.

## 3. Verified implementation status (2026-10-11, local tests; staging unverified)

| Area | Status | Notes |
| --- | --- | --- |
| Customers, materials, price lists | Working | Customer-specific rates with effective dates. No material density field. |
| Quotes | Working | Versioned, PDF; email is preview-only until a provider is configured. |
| Quote → order | Working (N15) | Acceptance creates exactly one Confirmed order in the same transaction; idempotent; no assignment, scheduling or invoicing. |
| Orders | Working | Delivery location required to **schedule** (N15). Not yet: per-order-type required fields at **confirmation**, order types, change review that protects existing plans. |
| Needs-scheduling queue | Working (N14) | Confirmed orders without a date, in Dispatch and the Command Center. |
| Dispatch board | Working | Eligibility, conflicts (exclusion constraint), audit. |
| Smart Dispatch | Stage 1 working (N15) | Proposals with reasons, warnings, alternatives, exclusions; approval re-checked; rejections audited; 1–7 day horizon. No travel time, driver availability, trailer choice, load-breakdown planning or multi-day schedule proposals (Stage 2). |
| Route Planner / Route & Conditions | Placeholder / absent | Page labelled "Planned". No data sources chosen. |
| Driver portal | Working | Assignments, tickets with photos, delay/breakdown reports (web, not a native app). |
| Delivery tickets | Working | Review queue, revisions, office scans, bulk accept, duplicate guard. |
| Fulfillment and billing readiness | Working (N15) | Fully delivered → billable; partial stays out; recalculated on read. |
| Invoice drafts | Preview only (N14) | Computed; not stored, approved, numbered, issued or exported. |
| Billing handoff | Working (CSV) | Batches with audit and reversal; not a QuickBooks format. |
| QuickBooks / accounting | Absent | No credentials, configuration or export. |
| Payroll | Inputs only | `verified_delivery_inputs`; no formulas. |
| Reports | Measured basics (N14) | Delivered value, rework, billing turnaround, utilization, downtime. No profitability or ROI. |
| Command Center | Working | Prioritized exceptions, assignment, personal layout. No yellow/red severity model per §6.6 yet. |
| Fleet | Partial | Trucks/trailers with capacity and service status, driver qualifications. **Maintenance first increment (2026-10-11, Preview; needs migration 20261101000100 on each database):** truck work orders with lifecycle, history, findings, labor hours and cost lines; preventive schedules by days/miles/engine hours; readings; safety-critical defects restrict the truck until an authorized inspection clears it; clearance queue; driver notice on My Day. Not yet: trailers, parts inventory, purchase orders, vendor records, warranties, shop capacity, compliance documents or OCR. **Fleet management first increment (2026-10-11, Preview only; needs migration 20261102000100):** vehicle documents (metadata, expiry warnings, no upload), ownership, driver assignment with history and atomic reassign, derived availability with maintenance restrictions, readings, recorded costs and downtime on profiles. |
| Material calculator | Absent | |
| Distance pricing / dispatch bases | Absent | No dispatch-base entity exists. |
| Customer portal | Absent | |
| Tenant branding | Working (N15) | Logo and colors per company; "Powered by Taviron". |
| Public website | Working, gated | 9 pages, lead form, capability registry. See §5 for the gaps against the founder's requirements. |
| Demo leads | Partial | Stored, rate-limited, platform-only, audited; no emails, reminders, truck/base counts; statuses differ from §5.4. |
| Subscription billing, payments, agreements | Absent | Nothing charges money; none may be built without authorization. |
| Imports | CSV only | Team-led, reviewable, reversible; no XLSX. |

## 4. Branding (confirmed direction)

**Taviron palette:** midnight navy `#0C1A2B` · electric blue `#168BFF` · titanium silver `#C7D1DE` · clean white
`#F7F9FC` · safety red `#E5484D`, reserved for genuine critical alerts and safety issues.

**Logo:** geometric T symbol and a clean TAVIRON wordmark; blue is an accent inside the symbol; no blue element
beneath the A; no ® until registration is confirmed. Current artwork is conceptual. The production brand package
(vector SVG/PDF masters, transparent PNG, wordmark and symbol, app icon and favicon, monochrome, light/dark,
clear-space and minimum-size rules) is still to be produced.

**Where it applies:** public pages and the Taviron platform area use Taviron branding. Each company workspace
uses the company's own logo and palette (N15), with "Powered by Taviron" in shared places, through central
tenant-aware theme tokens — never per-page hacks — with contrast and safety colors preserved.

> **Light and dark mode (2026-10-11):** the internal app (company workspace, platform area, sign-in) has a
> per-person Appearance choice in the user menu — Light, Dark or Match my device — kept in that browser. Dark
> mode re-maps the shared tokens; company colors still apply; `critical` red, the public website, quote
> documents and print stay as they are (IMPLEMENTATION_PLAN §5u).

> **Status (2026-10-11):** the public website uses the palette (tokens `navy`, `navy-2`, `navy-3`, `electric`,
> `action`, `action-hover`, `silver`, `cloud`, `safety` in `src/app/globals.css`; inside `.site`, `brand`
> utilities resolve to electric blue) and an interim geometric-T logo (`src/components/site/logo.tsx`). The
> app's default tokens are Taviron too (navy navigation, action-blue accent) since the shell update; a company's
> own logo and colors override them in its workspace, and urgency uses a fixed `critical` red. See §8, item W2.

## 5. Public website and demo requests (immediate priority)

**Required experience:** Home · Platform · Solutions · Pricing · Book a Demo · Contact · legal pages · Sign In.
One responsive site; clear boundary from the workspace and platform area; claims only from
`src/lib/site/capabilities.ts`; early-access gate stays on until the founder approves launch.

**Exists today (gated):** all of the above pages, a 3D hero built from real screens, a demo and a contact form,
Sign In, `noindex` unless `SITE_INDEXING=on`, the capability registry and `docs/RELEASE_CHECKLIST.md`.

**Smart Load Build (2026-10-11):** canonical spec in [`docs/SMART_LOAD_BUILD.md`](SMART_LOAD_BUILD.md) (accepted
requirements A–J, gap analysis, rules, open questions, milestones). Increment 1 implemented: draft loads from an
order's single material line (exact totals, payload limited to usable truck capacity, even spread over scheduled
days, nothing moved), dispatcher approval creates planned loads only. Next: cycle-time data — increment 2 audited and proposed in SMART_LOAD_BUILD.md §9 (trip logic tested, not wired); first decision: source of trip times.

**Deployment policy and Preview path (2026-10-11):** non-production branches are verified to deploy to Preview
(`claude/ui-and-signin-checkpoint`). Claude never pushes the production branch without approval; docs-only changes ride
with the next code checkpoint (CLAUDE.md → Workflow). Open: `main` as production branch, domains, Preview variables, the
mytaviron.com sign-in difference (SESSION_HANDOFF).

**Employee self-service and navigation (2026-10-11, Preview):** collapsible desktop sidebar (icon rail,
hover/keyboard expansion, pin), personal greeting, `/profile` with photo, display name and phone; role,
company and full name stay company-controlled. Needs migration `20261030000100` on staging (owner). The
employee directory, Mechanics shop board and company management (decided 2026-10-11: directory + records,
shop board, one-time setup links) are next.

**Employee Management (requirements being defined — NOT started):** a dedicated Employees tab with:
- employee directory and profiles;
- flexible role-based access: standard and custom roles, authorized individual overrides, audited sensitive actions;
- full messaging inside each company, permission-controlled: direct messages, group chats, role-based channels,
  company announcements and targeted alerts;
- full time off: requests (editable and withdrawable while pending), approvals and denials, leave types, balances,
  request history;
- coverage checks, and approved absences feeding Smart Dispatch driver availability;
- configurable notifications (in-app, email, push where available) and an audit history of administrative actions;
- tenant isolation and server-side authorization throughout.
**2026-10-12:** time-off requests, approval and approved absences in dispatch are built (IMPLEMENTATION_PLAN §5z); balances, accruals and policies are not.
**2026-10-12:** in-app employee communications are built (IMPLEMENTATION_PLAN §5aa, docs/COMMUNICATIONS.md): direct
messages, groups, department channels, dispatch-linked operational workspaces, operational alerts, announcements with
acknowledgment, presence, notification preferences and private attachments. Email/SMS/push delivery is not built;
hosted migrations pending.
Not a complete specification yet: open questions (e.g. who approves time off, accrual rules, message retention,
announcement targeting, which actions count as sensitive) stay with the founder. Custom roles, overrides, balances and accruals are not implemented.

**Roadmap after the UI checkpoints (not started):** further polish of the remaining screens (Orders, Fleet, Reports,
Customers, Tickets); refresh public screenshots from the real UI with consistent fictional data (no development overlays,
legitimate alerts kept); a restrained 3D trucking showcase (trucks, aggregate, road) with real screens central; an
end-to-end readiness review of the public site, demo requests, sign-in, permissions and core workflows. No invented features.

**Sign-in (2026-10-11):** unconfirmed emails are now named as such after a correct password, and platform owners get a
"Platform administration" menu link (local; not pushed).

**Internal UI polish (2026-10-11):** checkpoint 2 (Dispatch "Needs scheduling" panel, Billing reason / next step) done
locally. checkpoint 1 (shell, page headers, filter bars, buttons, Command Center
hierarchy) is done and tested locally; it is not pushed until the preview/production split is verified. Then screen by
screen: Billing, Dispatch, Orders, Fleet, Reports — through shared components first.

**Deployment split (2026-10-11):** verified that every push so far deployed to Vercel Production (19 of 19; one branch,
which is also the default). Proposed: `main` → Production (`mytaviron.com`), working branch → Preview
(`tltmaster.vercel.app`), separate variables per environment, a production Supabase project before real customers, and
promotion only by merging into `main` (DEPLOYMENT §2b). Awaiting the founder's approval; no configuration changed.

**Domains (2026-10-11, owner to confirm):** production/public `https://mytaviron.com`; testing `https://tltmaster.vercel.app`.
The sign-in logo links to `https://mytaviron.com`. Not verified from Claude's sandbox (network policy). Every push deploys to
the Vercel project's Production environment; if `mytaviron.com` is attached to the same project there is no preview/production
split yet (both addresses share one build, one set of variables and one database). Decision for the founder before launch.

**Early Access gate (2026-10-11):** the gate page is a branded Taviron page that takes one shared password
(`EARLY_ACCESS_PASSWORD`, server environment only; DEPLOYMENT §3b) as well as personal site codes. Either one
admits *this browser* to sign-in through its own revocable grant — it never signs anyone in or grants any
permission. Code pushed; on staging it needs migration `20261029000100` applied and the variable set (owner).

### 5.1 Pricing page (founder-provided; on the gated pricing page since 2026-10-11)

Five tiers, standard monthly prices, annual-commitment monthly equivalents and one-time onboarding fees. CTAs:
"Book a Demo" for standard tiers, "Contact Us" for Custom; no self-service checkout. Prices before applicable
taxes (tax wording after tax/legal review). **Founding-customer discounts are private and never advertised.**

**Status:** implemented on `/pricing` (`src/lib/site/pricing.ts`, IMPLEMENTATION_PLAN §5t). The site stays behind
the Early Access gate; publishing it publicly is still the founder's decision.

| Tier | Standard monthly | Annual commitment (−10%) | Hauling trucks | Dispatch bases | Onboarding (one-time) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Essential | $499 | $449.10 | up to 25 | 1 | $199 |
| Growth | $749 | $674.10 | up to 50 | up to 2 | $299 |
| Professional | $999 | $899.10 | up to 75 | up to 3 | $399 |
| Enterprise | from $1,499 | from $1,349.10 | up to 100 | up to 5 | $599 |
| Custom | Contact for quote | — | more than 100 or complex | multiple | from $599, by scope |

The lowest tier satisfying **both** the truck and the base limit applies. Private founding prices (20% off,
first 10 customers): $399.20 · $599.20 · $799.20 · $1,199.20.

### 5.2 Demo-request workflow (confirmed requirements)

- The demo is free; there is **no free trial**.
- **Required fields:** full name, work email, company name, number of hauling trucks, number of dispatch bases.
  **Optional:** phone, "What would you most like Taviron to improve?"
- **On success:** save the lead in Taviron (the source of truth), email the prospect a confirmation (receipt and
  that Taviron will follow up — no promised response time), email Taviron the lead details. Internal target:
  contact within one business day.
- **Statuses:** New · Contacted · Demo Scheduled · Demo Completed · Converted · Not Proceeding, with status
  history, internal notes, contact details, counts, needs and submission time.
- **Access:** platform administrators only (founder is the sole admin; one shared queue, no assignment workflow),
  enforced server-side and audited.
- **Reminders:** email the founder if a lead is not contacted within one business day; another reminder three
  business days after first outreach without a response; the lead stays open until Converted or Not Proceeding.

**Status (2026-10-11, on staging, verified by the owner):** counts, the six statuses, the spam flag, onboarding progress and
both emails are built on the existing lead system (migration `20261028000100`). Emails are recorded but not sent
until an email provider and domain are approved. Still open: reminders (no scheduler yet, §8 W6). The contact
form remains a second, lighter form kind.

## 6. Smart Dispatch, Route & Conditions, fleet (direction)

### 6.1 Smart Dispatch (confirmed requirements)
- Balances deadlines and commitments, truck utilization, travel efficiency and empty miles, driver workload and
  fairness, feasibility. Safety, legal limits, qualifications, physical capacity and equipment suitability are
  hard constraints.
- Recommendation-only; inside the Dispatch board; approved recommendations appear on the board.
- Revalidate before approval; block stale recommendations; deterministic and explainable; audit approvals; never
  silently create, erase or replace assignments.
- Plans as far ahead as confirmed orders require; near-term first; distant plans provisional; invalidated plans
  flagged.
- Distinguish: incomplete order data · confirmed orders needing scheduling · orders awaiting a truck/driver ·
  existing plans that became infeasible.
- Capacity only from the tenant's fleet records; missing/outdated capacity is flagged, never assumed.
- Multi-load and multi-truck orders track planned vs actual quantities; one delivery never marks an order
  fulfilled. **Stage 1** assignment recommendations (built), **Stage 2** proposed multi-day schedules (not built);
  both need dispatcher approval.
- Outside-capacity suggestions (another yard, outside hauler) off by default, tenant opt-in, never booked
  automatically.
- Alerts: critical ones prominent in the Command Center; yellow warnings, red only for genuine critical alerts;
  severity updates as conditions change; no duplicate notifications.

### 6.2 Route & Conditions Intelligence (direction)
Official closures and restrictions, truck routing limits, frost laws and seasonal weight limits, severe weather
and alerts — evaluated against the actual route, truck, load and delivery. Each alert carries source, time and
freshness, severity, affected assignment, implication and next action. Missing or stale data is disclosed; "no
alert" never means "clear". Provider choice needs an audit of free/official sources first; no paid services
without approval.

### 6.3 Fleet, maintenance, compliance (direction)
Requests and triage, diagnosis, work orders, labor, parts, inspections and authorized clearance; costs,
warranties, downtime, vendors, purchase orders, inventory; preventive maintenance by time/mileage/engine hours;
delivery and non-delivery vehicles. **A safety-critical defect immediately blocks dispatch; an ordinary
dispatcher cannot override it; repair alone does not restore eligibility when inspection and clearance are
required.** Proposed UI: a dashboard overview plus an interactive shop board (to confirm). Compliance documents:
upload from phone or computer, OCR into a draft, human review, original preserved, duplicate VIN/plate detection,
expiry warnings up to 90 days, verified-expired documents block use and feed Smart Dispatch. No claim of complete
DOT coverage until the scope is defined.

## 7. Quotes, orders, fulfillment, billing (direction)

- **Order types:** material sold and delivered · hauling-only (customer or third-party material) · Stone & Sand
  pickup / company delivery. Required fields differ by type and are enforced in the UI and on the server;
  confirmation is blocked when they are missing.
- **Order changes:** authorized dispatchers may edit confirmed orders; harmless changes save; changes affecting
  assignments, feasibility or commitments are reviewed before plans change. Never silent reassignment.
- **States kept separate:** fulfillment complete → billing eligible → invoice draft → invoice reviewed and
  approved → invoice issued → exported/handed off. (Today: the first three exist; approval, issue and export do
  not.)
- **Invoice drafts:** accepted tickets × approved prices only; lines without tickets are flagged for explicit
  review.
- **Material calculator** in quote and order entry: length × width × depth, selected material, tenant-configured
  density, optional overage; live volume and estimated tons; the user reviews before transferring; never
  overwrite a quantity silently; the calculation is preserved through acceptance. Illustration only:
  10 ft × 500 ft × 2 ft = 10,000 ft³ ≈ 370.37 yd³; at 1.5 t/yd³ ≈ 555.6 t.
- **Distance pricing (urgent):** tenant per-mile rates; default route dispatch base → ship-to → base;
  contract overrides; show origin, destination, miles, rate and charge; routing where available; audited manual
  corrections; preserved through acceptance; no double-charging where hauling already includes travel.
- **Unified intake** (calls, texts, email, walk-ins, manual): AI may draft, never invent terms; human review.
- **Driver mobile app** (future): assignments, acknowledgments, photos, digital tickets, documents, exceptions,
  PTO, inspections, announcements, messaging; paper tickets stay supported.
- **Payroll and accounting:** configurable formulas with approval; unresolved exceptions excluded; QuickBooks
  expected at launch (to be built and verified); duplicate-export prevention.
- **Customer portal** (future): quotes, order status, invoices; requests reviewed by the office; no customer
  ticket submission until decided.
- **Reports:** revenue captured, admin time saved, utilization and downtime, billing turnaround and cash flow,
  errors and rework, customer/material performance, Taviron's cost vs benefits — measured vs estimated vs
  projected, with baselines and seasonality; no causal claims without evidence.
- **Reliability:** global search, duplicate detection, data-quality workflows, configurable workflows, reliable
  integrations, backups, recovery, data portability.

## 8. Outstanding Fixes and Operational Risks

Severity: **Critical** (safety, data loss, tenant leak) · **High** (blocks launch or a core workflow) ·
**Medium** · **Low**. "Approval" = needs the founder's approval before the change.

| # | Finding (evidence) | State | Severity / impact | Smallest safe fix | Tests / dependencies | Approval |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Staging database migrations. | **Fixed 2026-10-11 (owner):** backup taken (schema 563 KB, data 298 KB, Supabase CLI dump); `db push` applied `20261025000100` … `20261028000100` to taviron-staging without errors; `migration list` shows every migration local = remote. | — | Keep backing up before each push. | — | — |
| S2 | `SITE_ACCESS_SECRET` appeared in a screenshot earlier; rotation not confirmed. | Unverified | High — gate bypass if leaked. | Rotate in Vercel, redeploy. | `scripts/check-deployment.mjs`. | Owner action |
| S3 | Hosting: Vercel Hobby is non-commercial; Supabase Free has no backups. | Confirmed | High before paying customers. | Decide plans; schedule backups and a restore drill. | `docs/BACKUP_RESTORE.md`. | Yes (cost) |
| S4 | Auth email (SMTP, templates, URLs) and the `ticket-photos` bucket on staging not confirmed. | Unverified | Medium — invitations and resets may not arrive. | Configure per DEPLOYMENT §1. | Invitation with a real inbox. | Owner action |
| S6 | Communications 14-day retention and the 5-minute window are enforced only after migration `20261108000100`; the physical file purge also needs `CRON_SECRET` (2026-10-12). | Code on Production (`e468636`); migrations and secret pending. Until then hosted Communications keeps the earlier rules; manager removal works through a fallback but cannot store the reason (verified against a database without the updates). | High for the retention promise. | Apply `20261107000100` → `20261108000100`; set `CRON_SECRET`; check one cron run (a failed run answers 500 in Vercel logs). | `tests/db/comm-hardening.test.ts`; `tests/e2e/cron.spec.ts`; DEPLOYMENT §2a. | Owner action |
| S5 | 5 high `npm audit` advisories. | **Reviewed 2026-10-12:** all five are one chain in dev-only lint tooling (`eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces`, denial of service on crafted glob patterns). Not in the deployed app; lint only reads our own files. npm's only "fix" is downgrading to the Next 14 config — rejected. | Low (dev only) | Re-check when `eslint-config-next` updates; never `--force`. | `npm audit`. | No |
| W1 | ~~Pricing page advertised the founding-customer discount and a single $499 price.~~ **Done 2026-10-11:** five tiers, annual-commitment prices, onboarding fees, "Book a Demo" / "Contact Us", no founding mention, no checkout. (`src/app/(site)/pricing/page.tsx`, `src/lib/site/pricing.ts`.) | Done | — | — | Unit test on tier table, tier fit and no founding data; platform e2e checks the page. | Public launch still needs approval |
| W2 | Brand colors in code were charcoal/red; red is the primary action color. **Public website done 2026-10-11; app shell, Command Center and platform-area header done the same day (Phase 1 of the app overhaul). Other app modules inherit the tokens but are not yet reviewed screen by screen. Website screenshots recaptured from the new UI the same day.** Confirmed palette is navy/blue/silver with red reserved for critical alerts. (`src/app/globals.css`.) | Confirmed | Medium — brand and alert semantics. | Central token change: brand → electric blue, charcoal → midnight navy; keep a separate `--color-danger` `#E5484D`. Contrast (measured): white on `#168BFF` is 3.4:1 and white on `#E5484D` 3.9:1 — both below the 4.5:1 minimum for normal text; `#168BFF` on navy is 5.2:1. Needs a darker action shade for white-text buttons and links on white (e.g. `#0F6FD6`, 4.9:1 — a proposal), large/bold text only for red labels. | Visual review, contrast checks, screenshots. | No (direction confirmed) |
| W3 | Demo form lacked required truck and dispatch-base counts; used a fleet-size range and a role field. | Fixed; verified on staging by the owner 2026-10-11 | High for the demo flow. | Add the two numeric fields (DB columns + validation), keep the range for old leads. | DB + e2e lead tests. | No |
| W4 | No lead emails (prospect confirmation, founder notification). | Built; on staging both attempts are recorded as "Not sent" (owner-verified 2026-10-11); **sending off** until a provider is approved (preview mode records every attempt as "not sent"; `LEAD_NOTIFY_EMAIL` sets the team inbox) | High — leads can go unnoticed. | Send through the existing provider after saving; record each send attempt on the lead; failures never lose the lead. | Unit/e2e with a test provider; staging with `EMAIL_TEST_RECIPIENT`. | Yes — real emails (needs provider + domain) |
| W5 | Lead statuses differed from the confirmed list. | Fixed; on staging since 2026-10-11 (owner-verified six statuses and the spam rule) (20261028000100): qualified → Contacted, onboarding → Converted + onboarding in progress, won → Converted, lost → Not Proceeding, spam → Not Proceeding + spam flag; history kept; rollback script tested | Medium | — | DB, unit, e2e tests. | — |
| W6 | No follow-up reminders; no scheduler exists in the project. | Confirmed | Medium | A daily Vercel Cron route (free on Hobby, once a day) protected by a secret, computing business days; idempotent reminder log. | Unit tests for business-day math; route auth test. | Yes — new env secret and cron |
| W7 | Legal pages are drafts; tax wording absent. | Confirmed | High before launch. | Legal review. | — | Yes |
| W8 | Design skills (`emilkowalski/skills`) were not installed. | Fixed (installed in `.claude/skills/`, 2026-10-11) | — | — | Available to sessions that start in this repo. | — |
| O1 | Required fields are checked at scheduling (delivery location), not at confirmation; no order types. | Confirmed | Medium — incomplete confirmed orders reach Dispatch. | After order types are decided, enforce per-type fields at confirmation in UI and DB. | DB + e2e. | Needs §9 Q8 / order-type answer |
| O2 | Editing a confirmed order does not flag existing assignments that become infeasible. | **Covered (verified 2026-10-12):** the Command Center lists every upcoming active assignment whose load falls outside the order's dates, or that the dispatch rules would now refuse, as an "assignment problem" (`20261025000100`; `tests/db/command-center.test.ts` moves an order's dates and expects `load_outside_schedule`). Assignments are never changed automatically. | — | — | — | No |
| O3 | Smart Dispatch: no travel time, driver availability, trailer choice or Stage 2 schedules. | Confirmed limitation | Medium | Needs data (locations, availability) first. | — | Data/decisions |
| O4 | Command Center has no yellow/red severity model matching §6.1 alerts. | Confirmed | Low–Medium | Map priorities to warning/critical colors once W2 lands. | Visual + unit. | No |
| O5 | Date entry: two-digit years and 6-digit years. | Fixed (N15) | — | — | Unit + e2e regression. | — |
| O6 | Quote acceptance did not create the order automatically. | Fixed (N15) | — | — | DB tests. | — |
| O7 | Partial deliveries vs billing readiness. | Fixed (N15) | — | — | DB tests. | — |
| O8 | Local e2e tests that assumed near-empty shared queues failed as test data accumulated. | Fixed (scoped to own records) | Low | — | — | — |
| O9 | Imports are CSV only; XLSX unsupported. | Confirmed | Low | Add XLSX when onboarding needs it (library choice needs approval). | Import tests. | Yes (dependency) |
| O10 | Old demo companies accumulate on each reset (kept, deactivated). | Confirmed | Low | Platform cleanup tool. | — | No |
| O11 | `dispatch.spec.ts` and `smart-dispatch.spec.ts` "rejecting a proposal…" failed intermittently in long runs. | **Cause found 2026-10-12:** test data accumulated by repeated runs (Top Line had 592 trucks / 417 drivers) makes the board and Smart Dispatch slow on the dev server, beyond the 5 s / 60 s waits. Mitigated: the long dispatch test is marked slow, the rejection step waits 20 s, and a reset local database ran the full suite at 102 passed / 0 failed. | Low | Reset the local database before release runs (SETUP §5). | Full suite. | No |
| O12 | Dispatch pages slow on a large dataset. | **Measured 2026-10-12:** with 475 trucks / 278 drivers, `/dispatch/resources` took ~11 s on the dev server but ~1 s in a production build; `/dispatch` ~2 s in production. Database queries are each under 20 ms; the cost is rendering hundreds of rows and computing Smart Dispatch. | Low now (real fleets are far smaller); Medium as companies grow | Paginate or virtualize the resource lists and cache Smart Dispatch inputs when a company passes ~200 units. | Timing check in e2e. | No |

## 9. Open decisions (do not invent answers)

1. Do company administrators invite employees by email and assign roles, or does Taviron create all accounts during onboarding?
2. Can dispatchers edit Smart Dispatch's proposed load breakdown before approval?
3. Should irregular material areas be multiple rectangular sections?
4. How do driver- or dispatcher-reported vehicle issues become maintenance requests and get triaged?
5. Which dispatch base does distance pricing use when a company has several yards?
6. Per-mile rates, distance bands, or both?
7. Does distance pricing apply automatically to quotes, with authorized overrides and contract rules?
8. Which order types support internal orders and transfers?
9. Final billing-quantity rule when tickets are missing or only partly accepted (ordered vs delivered).
10. Invoice numbering, issuance, partial billing and accounting-export rules (and whether Taviron issues invoices).
11. Customer data export formats and workflow.
12. Which compliance documents and obligations are in the initial scope.
13. Recurring billing on the go-live anniversary or the first of the month.
14. Features and limits per tier beyond trucks and bases.
15. Final legal terms, tax requirements, payment-processor configuration and the public-pricing approval process.
16. Driver pay formulas, periods, approvals and export format.
17. Cost data for profitability (fuel, wages, maintenance, material cost, equipment).
18. Urgent-order escalation beyond one time limit.
19. N15 rules awaiting confirmation: breakdown/inspection reports block a truck and equipment issues only warn;
    capacity overruns are refused; a delivery location is needed to schedule; the definition of "fully delivered".
20. **Partly decided 2026-10-13 (owner): Keep crews together is built as an optional Plan the day priority, off by default (docs/OPTIMIZATION.md §2 item 7).** Smart Dispatch preferences (2026-10-12: maintenance shop dates and safety restrictions now block assignments; hours of service remain unverified until an ELD/log source is chosen): driver availability and hours, driver–truck pairings, customer priorities,
    fairness, whether truck locations will be recorded.
21. ~~Lead statuses `qualified`, `onboarding`, `spam`~~ — decided 2026-10-11: folded into the six statuses (see §8 W5).
22. Maintenance defaults to confirm: who may clear a truck for service (default: owner only; grantable to mechanics), whether a mechanic may clear their own repair, warning windows (default 14 days / 500 mi / 25 h), and whether due preventive work orders should be generated automatically each day (needs a scheduler).
23. Fleet: which vehicle documents are required per vehicle type (registration, insurance, annual inspection, IFTA/IRP permits…), how far ahead to warn (default 30 days), and whether document files should be uploaded and stored in Taviron (needs a private storage bucket). **Enforcement
    (reviewed 2026-10-13; **decided and built 2026-10-13 evening by owner directive: the recommendation below, per kind and configurable — IMPLEMENTATION_PLAN §5ai**):** §6 states the direction "verified-expired documents block use", but today nothing blocks:
    `vehicle_documents` has no verification state, `assign_load` and Smart Dispatch never read documents, and Plan the
    day only adds a review note per expired registration, insurance, inspection or permit. **Recommendation, awaiting
    the owner:** (a) block assignment for an expired **insurance** or **registration** once a person has verified the
    record (needs a `verified_at`/`verified_by` on documents, a check in `assign_load` and the same check in Smart
    Dispatch and Plan the day, so proposals and the database agree); (b) keep **inspection** and **permit** as
    warnings until Q12's compliance scope is set; (c) an unverified or missing date stays a review note, never a silent
    pass or a block. Needs one migration and no new business data. Not built until decided.
24. **PTO model decided by the owner 2026-10-13: all three accrual methods (annual grant, hours worked, per pay period), full-/part-time policies, waiting periods, separate or combined banks, approval chains, balance validation, configurable carryover/expiration (use-it-or-lose-it only where legal). Built: banks, append-only ledger, balance checks, and accruals by all three methods with caps and plan-year carryover/forfeiture (IMPLEMENTATION_PLAN §5ai). Next: approval chains and payroll/ELD hours integration.** Original question: Time off: who approves (default owner; grantable), whether self-approval is ever allowed, approval chains or manager scopes, which PTO policy model applies (annual grant, hourly accrual, per pay period; banks; carryover), and whether partial days need work schedules.
25. Communications defaults to confirm (**decided by the owner 2026-10-12:** edit/own-delete window fixed at 5 minutes; message content kept 14 days unless legal hold; managers remove with a reason; in-app only for now — see COMMUNICATIONS.md): whether new group members see earlier history (default: from when they join), drivers on an active delivery (default: hold routine notifications and send one catch-up), auto-archive delay for finished workspaces (default 24 h), alert escalation intervals and roles (default owner), which alert types are enabled, and whether email/SMS/push delivery should be added (needs a provider and approval).

## 10. Subscription model (proposal / confirmed policies)

Prices in §5.1 are the founder's and shown on the gated pricing page. The policies below are the founder's stated rules; **none is implemented** and no
billing code may be written without explicit authorization.

- **Counting:** active company-managed hauling trucks tracked in Taviron, including temporarily inactive ones
  (maintenance, storage, reserve); excluding pickups and maintenance vehicles; a truck stops counting when
  removed, sold or retired. A dispatch base is a distinct operational dispatch location (several yards under one
  base count once; customer sites never count; planned bases count once operational; closed bases stop counting).
- **Discounts:** founding 20% for the first 10 customers, private, follows upgrades while continuous, lost on
  cancel-and-return; annual commitment (12 months, paid monthly) 10%; discounts do not stack.
- **Overage:** crossing either limit starts a 30-day grace period with notices at crossing, before the end and
  before a scheduled tier change; then the lowest tier satisfying both limits from the next billing date, no
  prorated upgrade charge. Downgrade only after 30 consecutive days within the lower limits, from the next billing
  date. Annual discount kept on upgrade. Every tier or price change is emailed with reason, tier, price,
  effective date and discount. No plan change takes effect silently.
- **Price increases:** 60 days' notice; annual subscribers keep their price through the current term; founding
  stays 20% off the current standard price.
- **Billing dates:** anniversary vs first-of-month is open (§9 Q13); if first-of-month, prorate from go-live. No
  subscription charges before go-live.
- **Taxes and payments:** prices before tax; tax by billing location, shown separately (validate before launch);
  cards at launch, ACH later; a payment processor holds card data — never stored in Taviron.
- **Failed payments:** prompt notice, processor retries, 7-day grace, reminders, then restrict paid features;
  never delete data for non-payment.
- **Self-service (confirmed):** billing history, email receipts, PDF invoices/receipts, update and choose the
  default payment method, see plan, price, counts, limits, grace status and next tier; request upgrades,
  downgrades (30-day rule) and Custom changes in-app with confirmation emails; billing history available during
  the 90-day post-cancellation window.
- **Refunds (confirmed):** no refunds of unused monthly or annual periods; annual renewal can be turned off but the
  commitment stands; onboarding fees nonrefundable unless Taviron cannot deliver onboarding; verified duplicate or
  incorrect charges corrected or refunded.
- **Annual renewal (confirmed):** auto-renews for 12 months unless turned off; reminders 30, 7 and 1 day before
  with term, tier, price and discount.
- **Onboarding (confirmed):** demo → choose plan → e-sign the service agreement → pay the onboarding fee → setup,
  configuration, testing, one live training session (extra sessions $49 per ≤60 min) → subscription billing from
  go-live. Extensive cleanup or unusual migrations quoted separately. Go-live is agreed jointly, can move earlier
  but not later; if Taviron is late, billing waits and the delay and reason are audited.
- **Support (confirmed):** email only, Mon–Fri 9–5 Central, excluding U.S. federal holidays, target first response
  within one business day; not a resolution guarantee or 24/7 service.
- **Cancellation and retention (confirmed):** monthly cancels any time, access to the end of the paid period;
  data kept 90 days after access ends for export, then deleted or anonymized under the final policy; export at no
  charge (customers, quotes, orders, tickets, invoices, fleet, maintenance, audit history; formats open).
- **Top Line Trucking** stays on its existing free beta arrangement.
- All customer-facing pricing, tax, refund and legal policies need legal review before launch.

## 11. Roadmap order (dependencies first)

1. **Website and demo readiness** — ~~W1 pricing page~~ (done), W3–W6 demo flow, W2 palette, W7 legal review; design pass
   with the installed design skills. Gate stays on until the founder approves launch.
2. **Staging verified end to end** — S1–S4 (owner actions).
3. **Order types and confirmation rules** (O1) → **distance pricing** with dispatch bases → **material calculator**.
4. **Maintenance and safety defects** feeding dispatch eligibility; compliance documents.
5. **Smart Dispatch Stage 2** and change-impact flags (O2), then Route & Conditions sources.
6. **Invoice approval/issue and accounting export** (after §9 Q9–Q10), QuickBooks verified with a test company.
7. **Payroll** (after pay rules), **customer portal**, **driver mobile**, **subscription billing** (after legal,
   tax and processor decisions).

## 12. Feature backlog (living; process in docs/DEVELOPMENT_WORKFLOW.md)

One row per independently deliverable feature. Status follows DEVELOPMENT_WORKFLOW §2 (requested → specified →
implemented → tested → committed → pushed → deployed → verified). Risk tier from §3 there. New requests are added
here without replacing earlier requirements; open questions go to §9. Last updated 2026-10-13.

| # | Feature | Status | Depends on / blockers | Risk tier · approvals | Acceptance and tests |
| --- | --- | --- | --- | --- | --- |
| B1 | Demo feature parity in every demo mode (shared idempotent samples) | committed (`df87ddb`), local checks pass; not yet pushed | Hosted `20261107000100`, `20261108000100` (owner) for Communications samples | review · owner applies migrations, runs Refresh on hosted prospect demos | DEMO_TENANTS §3/§5; `tests/db/demo-samples.test.ts`, `tests/e2e/demo-parity.spec.ts` |
| B2 | Demo experience: own photo in header, one-time welcome, Change view, presentation mode | committed (`f67009a`); focused browser tests pass | Hosted `20261109000100` (owner) for per-account memory; cookie fallback until then | review · migration apply | IMPLEMENTATION_PLAN §5ae; `tests/e2e/demo-experience.spec.ts` |
| B3 | Continuous development foundation: workflow, risk classifier, CI browser job, backlog, release reports | implemented; CI job unverified until it runs on GitHub | — | review (CI change) | DEVELOPMENT_WORKFLOW; `tests/unit/release-risk.test.ts`; CI run green |
| B4 | Premium 3D public website (truck hero, scroll story, real screenshots, release highlights) | **3D story implemented** (live on Production since 651c37b); **2026-10-13 contextual storytelling** — one scene per chapter (fleet planned together, delivery drive, checks, compared plans, dump delivery), scroll sync by step, tablet/phone fixes — local commit e80b9b7, not pushed (docs/WEBSITE_3D.md; tests/e2e/home-story.spec.ts). Release highlights registry still unused | Truck model: procedural or licence-verified free asset (no paid asset without approval); claims only from `src/lib/site/capabilities.ts` | auto (public site); new 3D dependency → review | Desktop/phone, reduced motion and static fallback, accessibility, asset size, existing site tests |
| B5 | AI Optimization Core, first slice: multi-load plan across trucks and drivers with hard constraints, configurable priorities, explanations, review and approve through `assign_load` | **first slice live** (Plan the day, Production 651c37b); **2026-10-13 iPad findings fixed locally** (46b01f4, c9f25bf, not pushed): Show plan button, loading state, blocked-load reasons per truck/trailer/driver, resources unavailable all day, empty day → next days with open loads, freight revenue from hauling lines, expired vehicle documents as review notes | Builds on Smart Dispatch Stage 1 (`src/lib/dispatch/smart.ts`); costs per §9 Q17 unknown (shown as missing); no routing provider (distances estimated and labelled) | review (dispatch workflow); nothing is assigned without a dispatcher | Deterministic tests: infeasible pairs blocked, confirmed work preserved, revalidation before commit; demo data in every dispatch mode |
| B6 | Shared AI platform (server-side model provider, tool registry, audit, global assistant) | **foundation implemented 2026-10-13 (local commit, not pushed)**: provider interface + OpenAI adapter, config, readiness gates, evaluation runner, usage ledger (migration `20261110000100`, local only), tool registry with read/propose/execute + approval, first capability "Explain this plan". Every capability Blocked until configured; no evaluation evidence yet. Global assistant not started | Owner: OpenAI key in Vercel, model choice, monthly token limit, hosted migration, a passing `npm run ai:eval` | approval (secret, paid service, migration) | docs/AI.md; `tests/unit/ai-foundation.test.ts`, `tests/db/ai-usage.test.ts`; live evaluation evidence before Ready |
| B7 | Smart Dispatch Stage 2: whole-plan proposals, disruption repair, new-load evaluation, decision history | requested | B5 | review | §6.1 |
| B8 | Load profitability and pre-acceptance | requested | Cost inputs (§9 Q17); B5 | review (financial) | Missing costs never assumed; estimates vs actuals kept apart |
| B9 | Customer operating intelligence (driver notes → proposed profile changes, freshness review) | requested | Driver notes capture; B6 for AI classification (deterministic rules first) | review | Human approval for every profile change; version history |
| B10 | Truck-aware route planner and GPS/ELD adapters | requested | Commercial truck-routing provider (paid → approval); never passenger routing | approval (paid service) | Provider-independent adapters; unverified restrictions flagged |
| B11 | Company onboarding and CSV import (mapping, validation, duplicates, preview, history, reversal) | requested; platform-operator imports exist (N13, IMPLEMENTATION_PLAN §5m) | Audit of N13 imports first | review (bulk data writes) | Malformed files, duplicates, invalid references, unauthorized access, partial failure tests |
| B12 | Scheduling views (calendar, timeline, board, map, coverage) on one data model | requested | Truck locations source (§9 Q20) for the map | review | Shared filters, validated drag-and-drop |
| B13 | Maintenance ticket board, tasks, notifications centre, adaptive dashboards, load entry from email/documents | requested | Notification delivery channels need a provider (approval) | review | Per feature |
| B14 | Customer self-service portal | **unresolved product decision** — do not build until scope is confirmed | §9 | — | — |
| B15 | AI readiness dashboard and audited adaptive learning (capability readiness, contextual warnings, decision history, personal preferences vs approved company rules) | requested 2026-10-13 | B5; migration for decision history and rules (owner applies) | review · migration apply | Capability statuses Ready / Limited / Needs review / Blocked from one evaluator; learning never overrides hard constraints |
| B16 | Data reliability: deterministic validation findings (missing, duplicate, stale, invalid relationships, suspected anomalies), evidence, downstream impact, correction review | requested 2026-10-13 | B11 readiness counts; corrections go through existing edit flows; AI explanations need B6 | review | Findings grounded in records; confirmed vs suspected kept apart; no silent overwrite |
| B17 | Privacy and data lifecycle governance (classification of every table, retention catalog, legal holds, privacy requests, governed deletion) | requested 2026-10-13 | Communications retention and legal hold exist (§5ac); legal review of periods (§9) | approval for any deletion policy in production | Every table classified (test-enforced); no deletion without hold and retention checks |
| B18 | Customer data portability (versioned exports with schema, assisted mapping, dry runs, reconciliation) | requested 2026-10-13 | Platform imports exist (§5m): staging = dry run, approve, revert; export formats open (§9 Q11) | review | Exports scoped to the company by RLS; schema versioned; reconciliation reported |
| B19 | Customer implementation management (plans, owners, migration coordination, training, sign-offs, go-live approval, stabilization) | requested 2026-10-13 | B11, B15, B18; platform onboarding (§5m) | review · approvals by people | Go-live blocked while mandatory prerequisites are unmet; sign-offs authorized and audited |
| B20 | Contract lifecycle and AI-assisted contract intelligence | requested 2026-10-13 | Private document storage; AI provider (B6) for extraction; subscription billing not built or authorized (§10) | approval (storage, AI provider) | Signed versions immutable; extracted terms evidence-linked and reviewed |
| B21 | Electronic signature workflows | requested 2026-10-13 | B20; an e-signature provider (paid service → approval); webhook secret | approval (paid service, secrets) | No "executed" without provider evidence and a verified digest |
| B22 | End-to-end document automation (templates, generation, approvals, delivery, reconciliation) | requested 2026-10-13 | Quote PDF generation exists; email provider; B21 for signatures | review | Template versions and source records preserved; bulk generation idempotent |
| B23 | Compliance management and operational enforcement | requested 2026-10-13 | Builds on driver qualifications, fleet documents, maintenance clearance and dispatch eligibility (exist); jurisdiction rules from authoritative sources (§9 Q12) | review (dispatch enforcement) | Missing evidence ≠ violation; enforcement at assignment server-side |
| B24 | Safety incidents, investigations and corrective actions | requested 2026-10-13 | Driver reports and maintenance exist; incident schema (migration) | review | Allegations, evidence and findings kept apart; restricted details protected |
| B25 | Driver performance and coaching | requested 2026-10-13 | Telematics/ELD provider (none connected; paid → approval); B24 | approval (provider) | Insufficient evidence is inconclusive, not poor performance |
| B26 | Workforce planning and staffing | requested 2026-10-13 | Hours-of-service data (ELD); time off and qualifications exist; B5 | review | Baseline planning until enough history; HOS never inferred |
| B27 | Driver compensation and settlements | requested 2026-10-13 | Each company's written pay rules (§9 Q16 — never invented); payroll export target | approval (financial) | Rules versioned; finalized settlements never recalculated silently |
| B28 | Fuel and expense intelligence | requested 2026-10-13 | Fuel-card / accounting providers (none connected; approval) | approval (provider) | Projected vs realized savings kept apart |
| B29 | Fleet lifecycle, TCO and investment analysis | requested 2026-10-13 | Acquisition, financing and cost data (not recorded); B28 | review | Assumptions labelled; no purchase without approval |
| B30 | Executive command center and cross-department intelligence | requested 2026-10-13 | Command Center and reports exist; depends on B8, B27–B29 data | review | KPI definitions documented; actuals vs forecasts distinct |
| B31 | Customer intelligence portal and business reviews | requested 2026-10-13 | B14 customer portal is an **unresolved product decision** — not started until confirmed | — | — |
| B32 | Customer success and account growth intelligence | requested 2026-10-13 | B20 contracts, support records (none yet), B31 | review | Insufficient-data states instead of false precision |
| B33 | Procurement and supplier intelligence | requested 2026-10-13 | Vendors, purchase orders, accounting (not built); B34 | review | Quotes compared like-for-like; no order without approval |
| B34 | Inventory and parts intelligence | requested 2026-10-13 | Maintenance work orders exist; parts ledger (migration) | review | Movement ledger; no negative stock; ordering a part never clears a defect |
| B35 | Warehouse, dock and yard scheduling | requested 2026-10-13 | Facilities/docks model (not built); ETA sources need GPS/ELD (B10) | review | No confirmed reservation or completion without confirmation; no fabricated ETAs |
| B36 | Revenue, rate and pricing intelligence | requested 2026-10-13 | Effective-dated price lists and quotes exist; cost data (§9 Q17), market-rate source (approval) | review | Historical transactions never repriced; margin only from actual costs |
| B37 | Whole-fleet load matching, sequencing and backhauls | requested 2026-10-13 | B5 (Plan the day) is the engine to extend; locations and routing (B10); HOS (ELD) | review | Pickup-before-delivery, windows, capacity enforced; no silent reassignment |
| B38 | Network design and strategic capacity | requested 2026-10-13 | Lane history, costs and terminal data (not recorded); B36, B37 | review | Scenario planning when history is insufficient; "optimal" only within a stated method |
| B39 | Connected freight ecosystem (partners, EDI/API, mappings, reconciliation, extensions) | requested 2026-10-13 | No partner integrations exist; each partner/provider is an approval | approval (credentials, live connections) | Receipt ≠ acceptance ≠ fulfilment; idempotent processing; scoped credentials |
| B40 | Governed data and analytics platform (metric registry, versioned API, controlled exports, external BI) | requested 2026-10-13 | Reports exist; B18 export first; API tokens and BI connections are approvals | review / approval (external access) | One metric definition per KPI; permissions on every request; exports scoped and audited |
| B41 | SaaS operations and customer lifecycle (guided onboarding, configuration validation, adoption, support escalation, service health, controlled automation) | requested 2026-10-13 | Extends `/setup` (B11) and B19; support and monitoring systems not built; subscriptions not authorized (§10) | review / approval (access, billing) | Checklist ≠ verified readiness; recovery verified by checks |
| B42 | Order-to-Cash Control Center: one control center + contextual lifecycle panels over orders, dispatch, documents, billing, AR and the customer portal; separate state dimensions (order, load, operational completion, billing eligibility, invoice draft/approval/issuance, external acceptance, posting, payment receipt, reconciliation, disputes, financial closure); full-order billing-eligibility invariant; versioned company policies; guarded automation, reconciliation and collections; metrics | **queued 2026-10-13 — do not start until explicitly started**; readiness map: `docs/proposals/B42_ORDER_TO_CASH_READINESS.md` (after Plan the day, tablet navigation, 3D homepage and the release verification) | Repository audit first (§2 of the request): AR, payments, accounting adapters, contracts, customer portal, policy engine and task/SLA infrastructure are largely **not built** today — each must be mapped to existing code, a minimal foundation, or a documented blocker | approval (schema, financial workflows, external communications, integrations); no push, deploy or hosted migration without separate approval | Request §22 acceptance tests; demo scenarios §21; final report §26 |
| B43 | Premium marketing experience and automatic feature showcases: one feature catalog (status vs publication), real-app screenshots through a quality-gated capture pipeline, catalog-driven platform page and homepage index, checks that catch new app pages, stale or orphaned screenshots and unsupported claims | **first increment implemented 2026-10-13 (local commits 6b1a3b6, f853b16, 3453d68, 051dbda; not pushed)**: catalog of 15 features (13 published), 10 verified screenshots (5 new), /platform rebuilt, homepage capability index, docs/MARKETING.md | Demo data that shows each feature well; publication remains a person's decision; pricing/legal/positioning claims follow the release checklist | auto (public site) / review (capture tooling) | tests/unit/feature-catalog.test.ts, tests/e2e/marketing.spec.ts; screenshots pass the gate and a visual review |
| B44 | Release-readiness sprint 2026-10-13 (until 5 PM): reproduce every gate; demo persona name in driver lists; expired-document enforcement reviewed (recommendation in §9 Q23, not built); dispatch edge cases (primary truck unavailable on the Resources page; plain error and replaced-day notice on Plan the day); B42 readiness map | **implemented 2026-10-13 (local commits, IMPLEMENTATION_PLAN §5ah)** — also: demo samples for every billing state, sent quote, assigned item, order waiting for a date; planner ~20× faster at 80 loads and ~5× with 200+ trucks (identical plans); demo persona in the Command Center and history; long names no longer widen phone pages; dark-mode alert text; plain error messages; proposals for hosted JIT and crew continuity; no push, deploy or hosted migration (owner instruction) | Migrations `20261111000100_demo_driver_names`, `20261111000200_demo_people_names`, `20261111000300_demo_history_names` (owner applies; reversible; code works without them — hosted-state check 26/26) | review (view/function migrations); app changes app-ui | DB tests `fleet.test.ts`, `demo-samples.test.ts`; unit `optimization-feasibility.test.ts`, `theme-variants.test.ts`; e2e `dispatch-availability`, `plan-the-day`, `long-names`, `demo-parity`; full release suite before handoff |
