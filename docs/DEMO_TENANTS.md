# Demo tenants

Permanent requirement (owner, 2026-10-12): every demo company is a realistic, continuously updated demonstration of
the **current** Taviron product, without separate feature development or manual synchronization after a release.
Demo compatibility is part of the definition of done for every feature and UI change (CLAUDE.md).

## 1. How demos stay in sync

- **One application.** Demo companies are ordinary companies with `companies.is_demo = true` and
  `demo_kind` = `presenter` (the rolling "Start the demo" company) or `prospect` (a standing demo for one prospect,
  e.g. Prairie Lantern Freight for Colby Chapman). They use the same code, pages, components, navigation, database
  functions and row-level security as every other company. Every release therefore reaches every demo at once, and
  every hosted migration applies to demos in the same `db push`.
- **What a demo has of its own** is only its data: branding (logo, colours), fictional records, and its members.
- **Sample data** is created once by the seed (`src/server/demo/seed.ts` for the presenter demo,
  `src/server/demo/prairie-lantern.ts` for Prairie Lantern Freight) and kept current by **Refresh demo data**
  (`src/server/demo/prairie-lantern-refresh.ts`, `/admin/demo`): additive only, it fills empty recent days,
  today and tomorrow with loads and re-adds missing sample records, never changing or deleting the prospect's work.
  The presenter demo (Northfield Aggregates) has the same **Refresh demo data** (`src/server/demo/northfield-refresh.ts`,
  owner 2026-10-14) and the same shape as Prairie Lantern: 10 trucks including tractors with end-dump and belly-dump
  trailers, 10 drivers, hourly charge items and Communications samples, so the two demos match.
- **Colby Chapman's demo** (Prairie Lantern Freight is his own view, owner 2026-10-14): `src/server/demo/prairie-lantern-colby.ts`
  adds touches from his life to the fictional company — a Rensselaer → Southfield, MI lane (where he studies), a
  seasonal Sarasota, FL run (where he lived), a hardwood-court customer (he plays basketball) and his friend
  **Cam Webster as a driver**. Cam Webster is the only real person's name in any demo, added at the owner's explicit
  request; customers stay invented businesses (real towns as locations only). Seed and Refresh both call it.
- **Feature samples shared by every demo** live in `src/server/demo/samples.ts` (`ensureFeatureSamples`): both seeds
  and Refresh call it, every step checks before it adds, and it refuses any company that is not a demo. A release
  that adds samples there reaches existing demos at their next Refresh (presenter demo: next Start/Reset), without
  recreating the company, duplicating records or removing users and demo owners. See §3 and the per-mode matrix in §5.

## 2. Intentional differences (the complete list)

Each is enforced by `tests/unit/demo-parity.test.ts`: adding any other `isDemo` / `is_demo` / `demo_kind` branch to
`src/` fails the test until it is added here with its reason.

| Where | Difference | Why |
| --- | --- | --- |
| `src/server/auth.ts` | Reads `is_demo` into `access.isDemo`; role previews only in demos, only narrowing. | Marks the tenant; lets a presenter show other roles without granting anything. |
| `src/components/layout/app-shell.tsx`, `src/app/(app)/layout.tsx`, `src/app/(app)/demo-actions.ts` | A one-time welcome dialog ("fictional sample data … nothing is sent outside Taviron"; `demo-welcome.tsx`), remembered per person and demo company; a small "Demo" badge on the account button and a demo line in the profile menu (with **About this demo** to reopen the welcome); **Change view** in the profile menu (`change-view-dialog.tsx`, the role preview); **Presentation mode** in the profile menu (hides the badge and the welcome). No persistent demo bar. | Users must know the data is fictional without a bar taking space on every page; screenshots and live demos. |
| `src/server/data/profile.ts`, `src/app/(app)/layout.tsx`, `src/app/(app)/driver/page.tsx` | A login linked to a demo employee record is shown by that record's name: the platform presenter as the fictional persona (Daniel Mitchell), a prospect owner as their own record (e.g. Colby Chapman). The header picture follows the same rule as every page: the person's own profile photo, else the record's illustrated avatar, else initials. | Never show the presenter's real name inside a demo; a person's own photo is theirs everywhere (a presenter who does not want their photo in a demo removes it on **My profile**). |
| `src/lib/ai/capabilities.ts`, `src/server/ai/gates.ts` | AI capabilities (docs/AI.md) are Blocked in demo companies unless the owner sets `AI_IN_DEMOS=on`; demos then show the normal "AI explanations are not available" state on Plan the day and Company setup, and the deterministic plan works as everywhere. | Calling a model spends real money and sends (pseudonymous) data to a third party; that must be a deliberate owner choice, not a side effect of a demo. When on, demos use the same code, gates, budget and checks as every company. |
| `src/server/routing/service.ts` | Truck routing (HERE) is off in demo companies unless the owner sets `ROUTING_IN_DEMOS=on`; demos then show the Route Planner with straight-line distances and the normal "routing is off in demo companies" note. Everything else on the page works as everywhere. | Each routing call counts against the owner's HERE account and sends coordinates to a third party; that is the owner's choice, as for AI. |
| `src/server/accounting/send.ts`, `src/app/api/accounting/qbo/connect/route.ts`, `src/app/api/accounting/qbo/callback/route.ts`, `src/app/(app)/billing/setup/page.tsx`, `src/components/billing/accounting-setup.tsx`, `src/app/(app)/billing/accounting-actions.ts`, `src/server/data/accounting.ts` | QuickBooks Online (master plan B82): a demo company cannot connect to QuickBooks, and **Send to QuickBooks** records a simulated send ("Demo: simulated … Nothing was sent") through the same claim and history as a real send. | The demo company never sends anything (CLAUDE.md); prospects still see the whole flow. |
| `src/app/(app)/quotes/actions.ts` | Quote emails are always previews, never sent. | Demos never send anything. |
| `src/server/people/invite.ts` | Sending a sign-in (People: add person, Send a sign-in, Invite user) is refused; the person record is still saved. | Demos never send email; prospect owners are added by the operator (DEPLOYMENT §3c). |
| `src/app/admin/companies/[id]/page.tsx` | The platform company page shows no Subscription section for a demo company (the database refuses a lifecycle for demos, `20261118000300`). | Demos are never customers: no plan, fee, go-live or revenue. Operator tooling, not part of the tenant's app. |
| `src/app/admin/actions.ts`, `src/app/admin/demo/page.tsx` | Platform tools to create, refresh and retire prospect demos. | Operator tooling, not part of the tenant's app. |
| `src/app/(app)/layout.tsx`, `src/server/demo/auto-refresh.ts`, database `demo_auto_refresh_claim` / `_finish` (migration `20261120002800`) | When the demo's owner (the platform team or a prospect's owner login) opens a demo company, the same additive refresh as **Refresh demo data** runs after the page is sent: once per deployed version, per day and per six-hour window (so a database update applied after the deployment reaches the demos within six hours). The database decides (demo, owner, not yet current, nothing running; a failure waits an hour) and logs it to platform activity as "Automatic". Refused for real companies. | New features and today's loads reach every demo after each release without anyone clicking Refresh (owner 2026-10-25). The button still works for an immediate refresh; it takes the same lock (`demo_refresh_begin` / `_end`, migration `20261120003200`) and waits up to 45 s for a running automatic refresh, so the two never add the same samples at once. |
| Database: `public.comm_seed_demo_samples()` (migration `20261108000100`) | Adds fictional sample Communications content (a "Dispatch desk" channel with pinned sample instructions); refused for real companies; never adds platform operators as members. Called by the seed and Refresh. | Communications needs content to look alive; fictional people cannot post without logins, so samples are system notes marked "Sample". |
| Database: `public.dismiss_demo_welcome()`, `user_preferences` key `demo_welcome` (migration `20261109000100`) | Remembers that a person saw the welcome in a demo company; refused for real companies. Until the migration is applied, an http-only browser cookie (`taviron-demo-welcome`) remembers it on that browser. | The welcome should appear once per person, not on every sign-in or device. |
| Database: `private.comm_user_name` (migration `20261108000100`) | In a demo company, Communications names a login linked to an employee record by that record's name. | The presenter appears as the persona (Daniel Mitchell), never under their own name, as everywhere else in the demo. |
| Database: `public.driver_list` (migration `20261111000100`) | In a demo company, a driver linked to a login is named by the driver record (the persona), not the login's account name. Real companies keep the login's name first. | Plan the day, Dispatch, Delivery Tickets and the driver directory show the presenter as the persona (Daniel Mitchell), matching the header and Communications. Until the migration is applied on a hosted database, those lists still show the login's own name there. |
| Database: Command Center names (migration `20261111000200`) | `command_center_exceptions`, `exception_assignee_options` and `assign_exception` name people through `private.comm_user_name`: the persona in a demo company. | "Next action", Reassign and the assignment confirmation show Daniel Mitchell, not the presenter's login. In real companies a person's own display name (when set) is now preferred to their full name, as in Communications and the header. Until applied on a hosted database, demos show the login's name there. |
| Database: demo person names (migration `20261111000300`, helper `private.demo_person_name`) | In a demo company, history lines (`user_directory`), a field report's driver name, the driver's My Day, who flagged/acknowledged an urgent order and assignment history name a login by its linked employee (or driver) record. Real companies get exactly the same values as before. Company settings' user list still shows the real login and email on purpose: that is where accounts are managed. | No page of the presenter demo shows the presenter's own name except account management (checked by scanning 50 demo pages, 2026-10-13). Until applied on a hosted database, those places show the login's name. |
| Platform console: `src/app/admin/support/page.tsx` | Support requests sent from a demo company carry a "Demo" badge in the platform team's Support list. | The team can tell a prospect trying Help from a customer asking for help; the demo itself works exactly like a real company. |
| Platform console: `src/components/admin/company-lifecycle-controls.tsx` | Classification, archive and permanent delete are not offered for demo companies (they are managed in Demo Management: retire, refresh, plan shown). | A demo can never be deleted from the company page; it cannot be classified as a customer or practice company. |
| Customer portal: `src/app/portal/[slug]/layout.tsx` (type in `src/lib/portal.ts`) | A demo company's customer portal shows a line "Demo portal: fictional company and records. Nothing here is sent or charged." The portal itself (orders, quotes, support, help) is the same code and database functions as for a real company. | Anyone opening a demo portal must know the records are fictional. |
| Username sign-ins (migration `20261120001200`): `src/server/accounts.ts`, `src/app/(app)/employees/account-actions.ts`, `src/app/(app)/employees/new-sign-in/page.tsx`, `src/app/(app)/employees/page.tsx`, `src/app/(app)/employees/[id]/page.tsx`, `src/app/(app)/customer-portal/account-actions.ts`, `src/app/(app)/customer-portal/page.tsx` | A demo company does not create, reset or email employee or customer-portal sign-ins: the create pages show "Not in a demo company" and the database refuses (`account_provision_begin`, `account_issue_allowed`, `portal_create_login`). Email of setup links is reported as unavailable ("Demo companies never send email"). Role previews and the Testing Lab's portal preview show those experiences instead. | Creating a sign-in makes a real Auth account and a real credential; nothing real is created or sent from a demo. |
| Go-live sign-off (migration `20261120001500`): `src/app/(app)/setup/kit/page.tsx` | In a demo company the Onboarding Kit works fully (questionnaire, worksheet, testing, acceptance results) but the owner's go-live sign-off panel is not offered, and the database refuses `onboarding_go_live_sign` for demo companies. | A signature is a legal-style commitment by a real person; a fictional company never signs one.
| Platform console: `src/app/admin/testing-lab/page.tsx` | The Testing Lab lists and opens demo companies only; the database allows customer-portal previews and test checks for demo companies only (`20261120000800`). | Operator tooling: the owner inspects real experiences without touching a real customer's data. |
| Customer portal page: `src/app/portal/[slug]/page.tsx` | When the platform owner opens a demo company's portal while signed in as staff (no portal account), the page offers the Testing Lab's "Preview as customer" for that demo's customers instead of "no access" (owner 2026-10-26). Same database function and limits: demo companies and the platform owner only, one hour, audited. | So the owner sees the portal with fictional customer data without going through the Testing Lab. |
| Demo speed history (migration `20261120003600`, called from `src/server/demo/samples.ts` `speedHistory`) | Refresh demo data moves the times — only the times — of a demo's past seeded assignments (made the afternoon before) and clean accepted tickets (entered after delivery, accepted in Tuesday/Friday review sittings), with the matching ticket history entries. The guards on assignments, tickets and ticket history allow that time-only change only inside `public.demo_speed_history()` and only for demo companies; real companies are refused. Owner decision 2026-10-26. | Seeded records are written in seconds, so Command Center "Speed" (B86) would have nothing to measure in a demo. Who, what, quantities and statuses never change; a second run moves nothing. |

Everything else (Communications, Dispatch, Maintenance, Fleet, Employees, Reports, Billing previews, …) behaves
exactly as for a real company. Features that cannot act for real anyway (e.g. invoices are previews, Smart Dispatch
only proposes) need no demo branch.

## 3. Checklist for every new feature or UI change (definition of done)

Demo parity is never an optional follow-up: a feature, module, workflow, page, dashboard, setting, permission or
major UI change is not done until every applicable demo mode shows it working on realistic sample data.

1. **Applies to demos?** Yes by default when it can run on fictional data. If not, document the exception in §2.
2. **Demo modes affected.** Name each role preview that sees the feature: Owner, Dispatcher, Drives too (multi-role),
   Office administrator, Driver, Mechanic, and any future role (`src/lib/platform/preview.ts`). Each must work with
   that role's real permissions; never grant extra permissions to make it visible. Add the row to §5.
3. **Sample data.** If the feature needs records to look alive, add them to the shared, idempotent helper
   `src/server/demo/samples.ts` (`ensureFeatureSamples`), which both seeds and Refresh call, so new and existing
   demos both get them. Each step checks before it adds; the helper refuses real companies (`is_demo` only). Use only
   invented names, 555-01xx numbers, `.example` addresses; no VINs, plates, DOT/MC numbers or real businesses.
4. **Existing demos receive it** through **Refresh demo data** (`/admin/demo`) after the release, without being
   recreated: Refresh is additive, a second run adds nothing, and it never deletes records, accounts or demo owners.
   The presenter demo gets it at the next **Start the demo / Reset**.
5. **Dependencies?** Name migrations, env vars and services. Without them the feature shows its normal "not
   available yet" state in demos too.
6. **Safety:** nothing real leaves a demo — email, SMS, push, dispatch to a real driver, payment, accounting export
   or third-party call is simulated or refused (follow quote emails and invitations). No extra permissions to make a
   feature appear functional. Tenant isolation and RLS unchanged.
7. **Tests:** `tests/e2e/demo-parity.spec.ts` checks every navigation page loads in a demo with the same navigation as
   a standard company, opens every page in every demo mode and checks each feature shows sample data;
   `tests/db/demo-samples.test.ts` checks the samples exist, a repeat adds nothing, demo users are kept and a real
   company is refused. Add a feature-specific check when the feature has demo-relevant behaviour.
8. **Report** in every plan and release summary: the demo modes affected, the sample data, how existing demos
   receive it, the tests, and any intentional difference.

## 4. Known gaps (to close as features are touched)

- Communications samples need migration `20261108000100`; until it is applied the seed, Refresh and the shared
  samples skip them (the workspace and channel), and Communications shows its normal empty state in demos.
- Communications samples are system notes and an operation workspace; fictional people do not chat (they would need
  logins). Sample notes expire after 14 days like all message content; Refresh adds them again. A prospect owner
  added with `demo-owner` joins the sample channel and the operation workspaces at once.
- Driver Reports (field reports) have no samples: a report is filed by a driver login, and fictional drivers have
  none. The page shows its normal empty state.
- Prairie Lantern Freight prices with charge items rather than materials, so Materials & Pricing is empty there by
  design of its data; the presenter demo has materials.
- Refresh exists for Prairie Lantern Freight; the shared samples (`samples.ts`) work for any demo company, but a new
  prospect demo with different base data needs its own seed and Refresh. The presenter demo is rebuilt by
  **Start the demo / Reset** instead.
- No scheduler: Refresh is a button (`/admin/demo`), not a nightly job.

## 5. Demo modes and the sample data behind each feature

Role previews (`src/lib/platform/preview.ts`) only narrow the viewer's real permissions; each mode sees the pages its
role's permissions allow. "✓" = the mode opens the feature with sample data; "—" = the role has no access.
Samples come from the seed, Refresh and `src/server/demo/samples.ts`.

| Feature | Sample data | Owner | Dispatcher | Drives too | Office | Driver | Mechanic |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Command Center | Orders and loads for recent days, today and tomorrow (Refresh fills empty days); one open review item assigned to the person viewing the demo, so "Assigned to you" is not empty (2026-10-13) | ✓ | ✓ | ✓ | ✓ | — (opens My Day) | ✓ |
| Orders, Dispatch, Smart Dispatch | Same loads; trucks, trailers and drivers; a confirmed order waiting for a delivery date (Needs scheduling, 2026-10-13) | ✓ | ✓ | ✓ | ✓ | — | — |
| My Day | The demo owner's own driver record (linked employee), qualifications and a load today or tomorrow | ✓ | — | ✓ | — | ✓ | — |
| Delivery tickets | Tickets on delivered loads | ✓ | ✓ | ✓ | ✓ | — | — |
| Billing readiness | Every state: missing tickets, tickets to review, exceptions (presenter scenario 1), one order **Ready to bill** and one **Handed off** in an internal batch (`samples.ts` `billing()`, 2026-10-13: before it no demo showed either). Nothing is sent, exported or invoiced | ✓ | — | — | ✓ | — | — |
| Dispatch bases (B62/B63) | One Main base in every demo. Demo Management → **Plan Shown** makes a demo Growth (North Yard) or Professional (North Yard, South Terminal) and spreads its fictional trucks, drivers and orders across the bases once; switching back to Essential returns them. Cross-base dispatch is on for multi-base demos so Smart Dispatch keeps proposing (with the cross-base warning). Refresh never changes bases | ✓ | ✓ (reads; filters) | ✓ | ✓ | — | — |
| Quotes | A draft quote copied from a sample order line, and a second quote marked handed to the customer outside Taviron (locked v1, status Sent; nothing is sent — 2026-10-13) | ✓ | ✓ | ✓ | ✓ | — | — |
| Fleet and documents | Registrations (one expiring), an inspection due, an expired trailer registration | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| Maintenance | A safety-critical brake work order on an idle truck, tire and electrical work orders, oil and annual inspection schedules, a trailer inspection scheduled in three days (trailer work orders; added on Refresh once `20261115000100` is applied) | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| Job site directions (B51) | Fictional directions on three job sites with upcoming loads: safety/access critical and **not verified** (flagged on the customer, the order and My Day), critical and verified (audited, through the real function), standard and not verified; their upcoming orders are linked to the saved site through the normal order edit. On later Refreshes, a driver who signs in (the owner's relief load) gets the flagged sample on their load's site if it has no directions. Needs `20261115000200` | ✓ | ✓ (sees, cannot verify) | ✓ | ✓ | ✓ (My Day) | — |
| Time off | An approved vacation, a pending personal day, and a pending request for the viewer's own employee record | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Time-off balances | One "Paid time off" bank (vacation + personal; full- and part-time) and a fictional opening grant per current employee ("Demo: opening balance"); sample requests use hours; an every-two-weeks accrual policy for full-time employees with accrued history | ✓ (Banks and balances) | My balances | My balances | My balances | My balances | My balances |
| Communications | "Dispatch desk" channel with pinned sample notes; an operation workspace for a scheduled order (needs `20261108000100`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Employees | Fictional employees with departments and qualifications | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| Customer CRM (B59) | On the three customers with the latest orders: an opportunity in Quoting valued at that customer's own latest order total, one in Negotiation without a value, an overdue follow-up and one due this week (assigned to the viewer), and a logged call each (`samples.ts` `crm`; needs `20261119000100`) | ✓ | ✓ (read) | ✓ (read) | ✓ | — | — |
| Payroll (B27, docs/PAYROLL.md) | One open payroll period over the last two weeks, showing the demo's verified tickets waiting for payroll (`samples.ts` `payrollPeriod`). **No pay rule is seeded**: pay rules are each company's own and never invented, so the period shows "Calculation is off" until someone in the demo writes one (needs `20261118000200`) | ✓ | — | — | — | — | — |
| Guided onboarding (B68, docs/ONBOARDING.md §4) | A fictional mid-onboarding checklist generated from the demo's own plan, fleet and bases: finished tasks, one submitted for review, one with changes requested (reason shown), one blocked and overdue, one awaiting the customer, the rest not started, plus a Taviron message (`samples.ts` `guidedOnboarding` → `onboarding_demo_samples`, `is_demo` only, once; needs `20261120001000`). Nothing is sent | ✓ | — | — | — | — | — |
| Explain this plan (AI, docs/AI.md) | None needed (uses the planning-day samples). Blocked in demos unless `AI_IN_DEMOS=on` — the page shows the normal "not available" state; Company setup shows the gate | ✓ (state) | ✓ (state) | ✓ (state) | ✓ (state) | — | — |
| Ask Taviron (AI, docs/AI.md §15) | None needed (reads the demo's existing sample orders, queue and maintenance). Blocked in demos unless `AI_IN_DEMOS=on` — `/assistant` shows the normal "not available" state | ✓ (state) | ✓ (state) | ✓ (state) | ✓ (state) | — (no entry) | ✓ (state) |

Proof: `tests/e2e/demo-parity.spec.ts` opens every navigation page in every demo mode, for the presenter demo and for
a prospect demo after **Refresh demo data**, and checks Maintenance, Time off, Quotes, Communications, My Day (including the site directions status) and a
flagged job site show sample data; `tests/db/demo-samples.test.ts` checks the samples, that a second run adds nothing and keeps every demo
user, and that a real company is refused.
