# Session handoff — Taviron

Last updated: 2026-10-11, after N15. Contains **no secrets**: no codes, keys, passwords or
project credentials. Read it together with:
- `CLAUDE.md` and `docs/TAVIRON_MASTER_PLAN.md`: rules, decisions and open business questions.
- `docs/IMPLEMENTATION_PLAN.md`: §5m (N13), §5n (N14), §5o (N15: Smart Dispatch algorithm, hard blocks vs warnings, branding, fulfillment), "Recommended next task", and roadmap §8 A–H.
- `docs/RELEASE_CHECKLIST.md`: what to check before calling a release done.
- `docs/DEPLOYMENT.md`: hosting steps, including §2a (database updates) and §3a (platform access).

## 0. Latest checkpoint (2026-10-12) — read first

- **Prospect demo tenant for Colby Chapman — Prairie Lantern Freight** (IMPLEMENTATION_PLAN §5ab, DEPLOYMENT §3c):
  code ready; created and checked only in the local dev database. **Needs migration `20261106000100`** (after the
  Communications ones). **Colby's login does not exist:** his verified email address is needed from the owner, then
  setup-link (he sets his own password) → demo-owner → verify his sign-in. Each is an owner-approved action.
- **Employee Communications** (IMPLEMENTATION_PLAN §5aa, docs/COMMUNICATIONS.md): messages, groups, channels,
  dispatch-linked operational workspaces, operational alerts with safety minimums and escalation, announcements with
  acknowledgment, presence and work status, driver-on-delivery safety notice and deferral, preferences, quiet hours,
  mutes, search (audited admin search), private attachments, retention. In-app only — nothing is emailed or texted.
  **Needs four hosted migrations, in order, after the pending ones:** `20261105000100` → `20261105000200` →
  `20261105000300` → `20261105000400` (owner action, DEPLOYMENT §2a). Until then every Communications page says
  "Not available yet". Open decisions: master plan §9 Q25.
- **Driver time off** (IMPLEMENTATION_PLAN §5z): `/time-off` requests and approvals; approved leave blocks drivers in
  dispatch at the moment of assignment. **Needs migration `20261104000100_time_off.sql`** after the three pending
  ones (20261101000100 → 20261102000100 → 20261103000100). No balances or accruals yet. Open decisions: master plan §9 Q24.
- **Smart Dispatch maintenance awareness + Driver & truck availability** (IMPLEMENTATION_PLAN §5y). **Needs
  migration `20261103000100_dispatch_maintenance.sql`**, after `20261101000100` and `20261102000100` (owner action,
  DEPLOYMENT §2a). Without it dispatch works as before and says shop visits are not checked. Hours of service are
  never verified (no ELD data); PTO is not recorded.
- **Fleet Management (code released to Production with this checkpoint under the standing release rule in CLAUDE.md; hosted migrations still pending):** vehicle documents with expiry warnings (metadata, no
  upload), ownership, driver assignment with history and atomic reassign, availability derived from service status
  and maintenance, maintenance/readings/costs/downtime on truck profiles, new overview cards and directory filters
  (IMPLEMENTATION_PLAN §5x). **Needs migration `20261102000100_fleet_management.sql`** after
  `20261101000100_maintenance.sql` (owner action, DEPLOYMENT §2a). Without it Fleet works as before and the new
  sections say they are not available yet. Open decisions: master plan §9 Q23.
- **Mechanics & Maintenance (code on Preview and Production since `528098c`; hosted migration pending):** `/maintenance` with work orders, clearance queue,
  preventive schedules, readings, cost lines and a driver notice on My Day (IMPLEMENTATION_PLAN §5w). **Needs
  migration `20261101000100_maintenance.sql` on each hosted database** (owner action after a backup, DEPLOYMENT
  §2a; rollback script in `supabase/rollbacks/`). Until then the Maintenance entry is hidden (no permission) and
  My Day shows no maintenance notices. Open defaults to confirm: master plan §9 Q22.
- **Branches:** work and pushes on `claude/ui-and-signin-checkpoint` (Preview). Production
  (`claude/top-line-trucking-manager-vmw04i`, mytaviron.com) is still at `16fc188`; Release 1
  (`3b33dfc`: new layout, Load Build, sign-in fixes; no migration) awaits the owner's go-ahead.
- **Admin accounts:** `scripts/platform-admin.mjs setup-link <email> --base-url https://mytaviron.com`
  prints a one-time password-setup link (creates the login if needed); then `grant`. The documented
  placeholder `you@example.com` must be revoked on staging if it was ever created (owner).
- **Email:** Resend domain `mytaviron.com` verified (owner). App emails (leads, quotes) use
  `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `LEAD_NOTIFY_EMAIL`,
  `EMAIL_TEST_RECIPIENT` (test mode: lead and quote emails only go to that inbox), `APP_BASE_URL`.
  A malformed value in any of these stops the server rendering pages (env validation). Supabase Auth
  emails (invitations, resets, confirmations) do **not** use these: they need Supabase → Authentication
  → SMTP (Resend SMTP) and URL Configuration (owner, not done). No delivery verified from a session.
  Branded HTML lead emails: `5c7ac2c` (Preview only).
- **Sidebar, greeting, profile self-service (Preview, not Production):** collapsible desktop rail
  (hover/keyboard expand, pin stored in a cookie), "Hi, <first name>!" / "Welcome back!", `/profile`
  (photo resized in the browser, display name, phone). **Needs migration
  `20261030000100_profile_self_service.sql` on staging before it works there** (back up first,
  DEPLOYMENT §2a; rollback script in `supabase/rollbacks/`). Without it the app works and `/profile`
  says editing is not available yet (tested). No PTO exists, so none is shown.
- **Email settings fail safe (b51a5d4):** only the Supabase URL and anon key are required to start. A
  malformed optional setting is ignored and named (never its value) in the server log; any malformed
  email setting (including `EMAIL_TEST_RECIPIENT`, `LEAD_NOTIFY_EMAIL`, `APP_BASE_URL`) turns sending
  off entirely. In test mode, invitations (Supabase Auth) are refused except to the test inbox; password
  resets and sign-up confirmations are self-initiated and still go to the requester's own address.
- **Phone fields** format US numbers as typed; `+` numbers and extensions kept; profile requires a
  complete number. **Navigation:** breadcrumbs return to the remembered list view; phones show one
  back link; forms marked `data-guard-unsaved` warn before leaving with edits.
- **Production released 2026-10-11 20:45 UTC: `96d3ee8`** (Vercel deployment success; live check
  not possible from the session — network policy). Migration `20261030000100` still unapplied on
  staging (app degrades gracefully).
- **Employees (Preview):** `/employees` directory (search, status/department/driver filters),
  profiles, add/edit, confidential pay (`employees.compensation`), drivers' primary trucks
  (`fleet.assign`). **Needs migration `20261031000100_employees.sql` on staging** (after
  `20261030000100`); without it `/employees` errors, so do not release it before the migration.
- **Northfield demo (Preview):** "Start the demo" (`/admin/demo`) seeds through the real app
  functions: Northfield Aggregates branding and logo (`src/server/demo/northfield-logo.svg` → PNG),
  presenter shown as the fictional **Daniel Mitchell** inside demo companies only (their real account
  name is never changed), 8 customers, 7 trucks (106 out of service), 6 drivers on their primary
  trucks, 5 staff, confidential pay, two weeks of delivery history. Migration
  `20261031000200_driver_home_own_tickets.sql`: My Day lists tickets for the driver's own loads only.
  Reset = start a fresh demo (the previous one is deactivated, never deleted).
- **Avatars:** 20 original illustrated trucking/aggregate professionals (`public/avatars`, made by
  `scripts/generate-avatars.mjs`). People can choose one on `/profile` instead of uploading a photo
  (saved through the normal photo checks); employee records get one via migration
  `20261031000300_employee_avatars.sql` (for people without a login). Demo people each have one.
  Real photos / AI portraits: the session's network blocks stock-photo hosts.
- **Hosted migrations still to apply, in order:** `20261030000100`, `20261031000100`, `20261031000200`,
  `20261031000300` (back up first; DEPLOYMENT §2a).
- **Known flaky locally:** `tests/db/command-center.test.ts` first test runs ~19 s against the large
  local test database and can hit the 20 s timeout in a full run; passes alone.

## 1. Repository state (verified)

- **Branch:** `claude/top-line-trucking-manager-vmw04i`. This is the only development branch, and Vercel
  deploys the staging site from it. Run `git log --oneline -5` to see the current head.
- **Migrations:** 26 in `supabase/migrations/`, the latest being `20261028000100_demo_lead_workflow.sql` (demo-request workflow).
  Never edit an applied migration; add new ones.
- **Lint, typecheck and build:** clean at handoff.

## 2. Milestones

| Milestone | Delivered | Plan section |
| --- | --- | --- |
| N9 | Accounts, company onboarding, sign-up access codes, company switcher. | §5i |
| N10 | Unified Command Center, urgent orders, personal layout, ticket review queue, order progress. | §5j |
| N11 | Office scans, review context, bulk accept, delivered-so-far, `verified_delivery_inputs`. | §5k |
| N12 | Early Access page and server-enforced gate, operator script, deployment checker, `docs/DEPLOYMENT.md`. | §5l |
| N13 | See the breakdown below this table. | §5m |
| N14 | "Needs scheduling" queue (Dispatch and Command Center) for confirmed orders without a date; invoice draft from verified deliveries; measured Reports page. | §5n |
| N15 | Smart Dispatch (proposals with reasons and alternatives; approval re-checked; rejections audited); safety-report and capacity blocks in assignments; quote acceptance creates the order; delivery location required to schedule; fulfillment-based billing readiness; date-entry fix; company branding; website capability registry and release checklist. | §5o |

N13 delivered:
- **Public website:** 9 pages, five-tier pricing, a 3D hero built from real screens, and lead forms.
- **Platform owner role:** granted by an operator only, and audited.
- **`/admin` launchpad and lead workspace.**
- **Live demo company:** role previews, with nothing sent outside Taviron.
- **Team-led CSV onboarding:** review, approval and reversal.

## 3. Test results (run in this session's sandbox, N15)

| Check | Result |
| --- | --- |
| vitest: unit, DB and storage | 350/350 (45 files) |
| Browser suite, dev server | 55 passed, 5 skipped. The skipped tests are the gate spec, which runs separately below. |
| Gate spec against a production build with the gate on | 5/5 |
| Outside-in checker against that build | All checks passed |
| Lint, typecheck, production build | Clean |

**Migrations:** the two N15 migrations were applied to a second database that already held the 23 earlier ones.
- Its schema is identical to dev.
- DB tests there: 167 passed, 7 skipped (the skipped tests need the storage server).

**Test fixes made along the way** (not product changes): three older browser tests assumed shared queues were nearly
empty or used loose locators that also matched the new Smart Dispatch panel; they now scope to their own records.

**None of this ran against the live site.** The sandbox's network policy blocks `*.vercel.app`.

## 4. Deployment and Supabase status

**Verified from GitHub's deployment records** (the public GitHub API; Vercel reports each deploy there):
- Every push to this branch is deployed by Vercel to the project's **Production** environment.
- Commit `867db9e` (N14) deployed with state `success` (2026-10-11), deployment URL `https://tltmaster-feu4o4jpb-taviron.vercel.app`. Earlier: `a652bbb` (N13) and `5d06ca1` (docs).
- Vercel team `taviron`, project `tltmaster`.
- There are no Preview deployments.

`tltmaster.vercel.app` is that project's Production alias. A Production variable such as `PUBLIC_SITE` affects it, and would also affect
any custom domain added to the project later (none is known).

**What this sandbox cannot do:**
- Reach `*.vercel.app`: the network policy refuses the connection.
- Read Vercel settings, environment variables or domains.
- Reach the staging Supabase project: no credentials are present, by design.

| Item | Status |
| --- | --- |
| **Migrations through `20261028000100`** | **Applied to staging 2026-10-11 by the owner** (`migration list`: local = remote). Earlier note follows. No credentials here; it is the owner's action, in DEPLOYMENT §2a (which also says what the app does until they are applied). |
| What staging does until the migration is applied | The app keeps working. The demo/contact form says it cannot save. `/admin` answers 404. This comes from reading the code; it was not observed live. |
| `PUBLIC_SITE` | Not set as far as known, so the website is behind the gate. Devices admitted with a site code, and signed-in users, still see every page; this was verified locally on a production build of `a652bbb`. |
| `SITE_INDEXING` | Not set as far as known, so nothing is indexed. |
| `SITE_ACCESS_SECRET` | **Must be rotated.** An earlier value appeared in a screenshot. |
| Site code, company, owner login, phone sign-in, platform role | Not yet confirmed. |
| Auth URLs, templates, SMTP, `ticket-photos` bucket, backups | Not confirmed. See DEPLOYMENT §1. |

## 5. Outstanding manual actions (owner)

1. **Back up the staging database, then apply the new migrations (N13, N14 and N15).** Follow DEPLOYMENT §2a step by step: confirm the linked project, back up,
   run `db push --dry-run`, run `db push`, then confirm with `migration list`.
2. **Rotate `SITE_ACCESS_SECRET`** in Vercel, then redeploy.
3. **Run the outside-in check.** Expect every check to pass:
   ```bash
   node scripts/check-deployment.mjs https://tltmaster.vercel.app
   ```
4. **Create your access and account:** a site code, a company and an owner login (DEPLOYMENT §3), then sign in from your phone.
5. **Grant yourself the platform role**, then open `/admin` and start the live demo (DEPLOYMENT §3a):
   ```bash
   node --env-file=.env.staging scripts/platform-admin.mjs grant <your email> --note "Founder"
   ```
6. **When ready to show the public website:** get the Privacy and Terms drafts reviewed (pricing is in place). Then set
   `PUBLIC_SITE=on` in Vercel and redeploy. Set `SITE_INDEXING=on` only for the real launch domain.
7. **Supabase Auth setup:** URL configuration, email templates and SMTP (DEPLOYMENT §1).
9. **Domains:** in Vercel → Project → Settings → Domains, confirm where `mytaviron.com` is attached. If it is on this
   project, decide whether it should serve the current (gated) build now; a separate project or a Preview-branch setup
   is needed for a real preview/production split. Add the domain to Supabase → Authentication → URL Configuration.
8. **Shared Early Access password (DEPLOYMENT §3b):** back up staging, apply migration
   `20261029000100_shared_early_access_password.sql` (§2a), then add `EARLY_ACCESS_PASSWORD` (Sensitive) in Vercel and
   redeploy. Until both are done the shared password does not work — "not valid" without the variable, "temporarily
   unavailable" without the migration — and no access is granted; personal codes keep working. If a custom domain is attached, add it to Supabase → Authentication → URL Configuration → Redirect URLs.

## 6. Known issues and decisions pending

- **N15 rules implemented but awaiting the business's confirmation** (TAVIRON_MASTER_PLAN §3): breakdown/inspection reports block a
  truck, equipment issues only warn; capacity overruns are refused; scheduling needs a delivery location; the fulfillment definition.
- **Smart Dispatch limits:** no truck locations (no distance or drive time), no driver availability or hours data, no trailer
  selection. It proposes only; it never assigns on its own.
- **Unticketed lines** (e.g. hauling with no ticket of its own): the invoice draft still uses the ordered quantity and flags it
  "confirm". Whether to bill ordered or delivered quantity is the business's decision.
- **Branding:** dialogs and toasts keep the default red; quote PDFs and the public website do not use company branding.
- **Local test database growth:** earlier e2e runs leave records (nothing is deleted). Tests that read shared queues now search or
  page for their own records.

- **Pricing:** the founder's five tiers are on `/pricing` (behind the gate). Founding-customer discounts are private and not shown.
  No billing or checkout code exists, and none may be added without explicit authorization.
- **Privacy and Terms** are drafts, marked on the page.
- **Imports are CSV only.** XLSX is not supported, and the uploader tells you to save as CSV.
- **No lead email notifications:** check `/admin/leads`.
- **The demo company keeps old demos.** Each "Reset" deactivates the old demo company and keeps it; nothing is deleted. Old demos are
  harmless, and a cleanup tool is planned.
- **The sandbox cannot reach the live site.** Add `tltmaster.vercel.app` to the cloud environment's allowed domains so a session can
  verify it.
- **Unreviewed `npm audit` findings:** 5 high-severity advisories on the owner's Mac. Do not run `npm audit fix --force`.
- **Hosting plans:** Vercel Hobby is non-commercial only, and Supabase Free has no backups. Upgrading is the owner's decision.
- **Product name:** "Taviron" is a working name, not cleared.

## 7. Next recommended task

**Website showcase + screenshots (2026-10-11):** homepage product showcase with an original dump-truck
illustration; all product screenshots recaptured from the new UI (IMPLEMENTATION_PLAN §5s).

**Smart Load Build increment 2 — travel-time approach decided (2026-10-11):** dispatcher-entered times first, no
routing service (SMART_LOAD_BUILD.md §10). Proposed tables `sources`, `route_times`, `site_unload_times` in
`docs/proposals/route_times.sql` — NOT in `supabase/migrations/` (so the pending `db push` for the Early Access fix
cannot apply it); tested on a scratch copy only. Next decision: is the loading source chosen per order, per material
or per load (§9.7-2)? Open item: the founder mentioned "six synchronized Smart Dispatch views" — no definition exists in
the docs or code yet; ask the founder for the list before recording it.

**Smart Load Build increment 2 — prepared (2026-10-11):** audit, data model proposal, staged plan and decisions in
docs/SMART_LOAD_BUILD.md §9. Implemented only pure trip/cycle-time logic (`src/lib/dispatch/trip-plan.ts`, 10 unit
tests), not wired to any page — no behaviour change, no migration, not deployed. Next decision: where trip times come
from (§9.7 question 1).

**Status check (2026-10-11, later session):** verified — Preview branch `claude/ui-and-signin-checkpoint` at `aadf07d`
(clean, equal to origin; Vercel Preview success); production branch at `16fc188`, still the only Production build
(16:07 UTC, no later Production record). Migration `20261029000100` on the Production Supabase project: **not
checked** — this sandbox has no linked project, no remote credentials, and the Supabase API is blocked, so which project
Production uses cannot be confirmed here. Early Access logs record only fixed text and error codes (never the
password, its value or the visitor's input). Smart Load Build open decisions (trip/cycle-time data, firm vs flexible
dates, driver-hour rules, mixed-material loads, alternative quarries, shared trips, cost) are in
docs/SMART_LOAD_BUILD.md §3 and §8. Employee Management requirements are recorded in the master plan (not started).

**Shared Early Access password refused on mytaviron.com (2026-10-11) — diagnosis:** Production still runs the single
build of `16fc188` from 2026-10-11 16:07 UTC (GitHub deployment records). The owner set `EARLY_ACCESS_PASSWORD` in
Vercel after that; Vercel applies variable changes only to deployments built afterwards, so the running deployment has
no shared password and treats the entry as a personal code → "That password isn't valid" (reproduced earlier by the
gate test without the variable). Other possibilities (less likely): the value differs from what is typed (exact,
case-sensitive), or it is under 12 characters. Owner actions (Production — need explicit approval): (1) check that
migration `20261029000100` is applied on the Supabase project Production uses (`npx supabase migration list`), and
apply it after a backup if not — otherwise a correct password shows "temporarily unavailable"; (2) Vercel →
Deployments → the current Production deployment → ⋯ → **Redeploy** (same commit, picks up the variable). The Preview
branch now logs "EARLY_ACCESS_PASSWORD is not set on this deployment" when that is the case (never the value).

**Smart Load Build increment 1 (2026-10-11):** `/orders/[id]/load-build` — see docs/SMART_LOAD_BUILD.md. Engine
`src/lib/dispatch/load-build.ts`, loader `src/server/data/load-build.ts`, approval action next to the page. No
migration. Tested locally (unit + browser); on the Preview branch.

**Checkpoint backup and Preview path (2026-10-11):** with the owner's approval, commits `e692c05`, `428fd4f`,
`8e49dab`, `7586464` were pushed to the new branch `claude/ui-and-signin-checkpoint` (the production branch
`claude/top-line-trucking-manager-vmw04i` stays at `16fc188`). Vercel recorded it as **Preview** (success,
`tltmaster-ck789m9xh-taviron.vercel.app`); Production untouched. Further work goes on that branch (CLAUDE.md policy).
Preview's environment variables are unknown — the preview may answer 503 until they are set (DEPLOYMENT §2b step 4).

**Sign-in fails on mytaviron.com but works on tltmaster.vercel.app (owner report, 2026-10-11) — not yet resolved:**
- Both run code where "Email or password is incorrect." means Supabase answered 400 (wrong password, unconfirmed
  email, or no such user in the project asked). A password sign-in is a server-to-Supabase call; it does not depend
  on the website's domain. So if both domains used the same Vercel deployment and variables, the same credentials
  would behave the same way. Something differs; the candidates, most likely first:
  1. **A different password is sent** — browsers keep saved passwords per site, so `mytaviron.com` may autofill an
     old or different one (e.g. the Early Access password). Check: type the password by hand there.
  2. **`mytaviron.com` uses another Supabase project** — it is attached to a different Vercel project or environment
     whose `NEXT_PUBLIC_SUPABASE_URL` differs (the account would not exist there). Check: Vercel → Project
     `tltmaster` → Settings → Domains (is it listed, on which environment/branch?), and compare
     `NEXT_PUBLIC_SUPABASE_URL` per environment (a public value).
  3. **Auth logs:** Supabase (taviron-staging) → Logs → Auth, at the time of the failed attempt: an
     `invalid_credentials` / `email_not_confirmed` entry means the right project with a wrong password / unconfirmed
     email; no entry means the request went to another project.
- Claude could not check any of this: the sandbox's network policy blocks both domains and the Vercel/Supabase APIs.
- Code side: `8e49dab` names unconfirmed emails; the backup branch also logs the error code (never the email or
  password) on every refused sign-in, so once that code serves a domain, Vercel's runtime logs show which case it is.

**Sign-in and platform access (2026-10-11, local only, not pushed):** two defects fixed and tested locally. (1) With the
right password on an account whose email was never confirmed, Supabase answers `email_not_confirmed` (it checks the
password first), but the page said "Email or password is incorrect." It now says the email is unconfirmed; wrong passwords
keep the generic message. Likely cause for an owner whose sign-up confirmation email never arrived (no SMTP yet). (2) A
platform owner working inside a company had no in-app way to `/admin` (only the demo bar linked there); the user menu now
shows "Platform administration" when the server confirms the role, and `/admin` still checks it. Not verified on staging:
whether the owner's account exists, is confirmed and holds the platform role is visible only in Supabase (owner action).

**Internal UI checkpoint 2 (local only, not pushed):** Dispatch — "Needs scheduling" is a bounded, scrollable panel with
tighter rows, so the board and Smart Dispatch are on the first screen (every order still listed). Billing — the "Why · what
to do" column is now "Reason" plus a short "Next step" link to the order (the full explanation stays on the order's page),
and the reason no longer repeats "still to run". Checked at 1440 and 390 px, light and dark.

**Internal UI checkpoint 1 (local only, not pushed):** shared shell and Command Center refinements — sidebar grouped
under Sales / Operations / Finance / Company headings (same links and permissions), page descriptions capped at a
readable width so page actions sit beside the title, a quiet outlined SAMPLE badge, a secondary-weight Apply in filter
bars, press feedback on buttons (none with reduced motion), and Command Center section labels as small group headings
above the cards, with "Arrange sections" on the first section's line. No data, logic, permissions or routes changed.
Next candidates: Billing's long "why" column, table density, Dispatch board header. Held back from pushing until the
preview/production split is verified (DEPLOYMENT §2b): today every push still deploys to Production.

**Preview vs production (2026-10-11):** verified from GitHub — one branch (the default), and all 19 Vercel deployments
are Production; there is no preview today, so every push reaches every domain on this project (`tltmaster.vercel.app`, and
`mytaviron.com` if attached here — unverified, Claude's network policy blocks both hosts and the Vercel/Supabase APIs). No code
change is needed for a split. Proposed setup and promotion workflow: DEPLOYMENT §2b (owner approval needed; nothing changed yet).
Until the split is made, treat every push as a production deployment.

**Domains, sign-in logo and redirects (2026-10-11):**
- **Sign-in logo:** on the sign-in pages (login, sign-up, password reset) the Taviron logo now links to
  `https://mytaviron.com` in the same tab (`src/lib/site/urls.ts`); tested by mouse and keyboard. Other logos unchanged.
- **Open-redirect fix:** `safeNextPath` now refuses control characters; before, `?next=/%09/evil.example` sent a user to
  another site after sign-in (confirmed by a test against the old code). Fixed and tested.
- **Domains — not verified:** this session's network policy blocks `mytaviron.com`, `tltmaster.vercel.app`, public DNS and
  the Vercel/Supabase APIs, so DNS, HTTPS and domain assignment are unconfirmed. GitHub's deployment records show every
  push deploying to Vercel's **Production** environment (the one `tltmaster.vercel.app` serves). If `mytaviron.com` is
  attached to this same project, it serves the same build, variables and Supabase project — there is no separate
  preview today. The gate keeps both private. No canonical URLs, sitemap or hardcoded preview address exist; absolute
  links come only from `APP_BASE_URL` (per Vercel environment).
- **Shared password:** the owner has chosen it (not recorded anywhere in the repository). It works only after the
  staging migration `20261029000100` is applied and `EARLY_ACCESS_PASSWORD` is set in the Vercel environment that
  serves the address in use, then redeployed. Not verified live.

**Shared Early Access password (2026-10-11):** the Early Access page is now a branded Taviron page
(`src/app/early-access/`) that accepts one shared password from the server environment as well as personal site
codes; each entry still gets its own revocable device grant, and sign-in, roles and RLS are unchanged
(IMPLEMENTATION_PLAN §5v). Tested locally against a gated production build. Staging needs the owner's migration and
environment variable (§5 item 8); the live flow has not been verified.

**Pricing and light/dark mode (2026-10-11):** `/pricing` shows the founder's five tiers (founding discount stays
private; IMPLEMENTATION_PLAN §5t). The app has an Appearance choice in the user menu — Light, Dark, Match my device —
stored per browser (§5u). Both are behind the Early Access gate like the rest of the site.

**App overhaul Phase 1 (2026-10-11):** shell + Command Center restyled, urgency colour fixed, presentation mode
for clean screenshots (IMPLEMENTATION_PLAN §5r, `docs/SCREENSHOTS.md`). The public-page redesign is paused until
the app modules are done; next app module per the founder's review.

**Website redesign Phase 1 (2026-10-11):** the homepage is redesigned on the Taviron palette (IMPLEMENTATION_PLAN
§5q). Phase 2 = the other public pages (Platform, Solutions, Pricing — pricing content waits for the founder's
approval —, About, Demo, Contact, legal).

**Staging update, 2026-10-11 (owner, on their Mac):** backup made with the Supabase CLI (schema 563 KB, data
298 KB, in the owner's Documents folder — the first `pg_dump` attempt produced a 0-byte file and was discarded);
`npx supabase db push` applied the five pending migrations (`20261025000100` … `20261028000100`) to the linked
project taviron-staging with no errors; `migration list` shows all migrations local = remote. The owner then ran
the read-only SQL check and the five-step demo check (DEPLOYMENT §2a) on `tltmaster.vercel.app` and reported all
of it working. These results were observed by the owner, not by a Claude session.

**Earlier the same day (session view):** the code (`6177920`) is deployed — GitHub's deployment
record for that commit says `success` (Vercel Production, aliased to `tltmaster.vercel.app`). Nothing was verified
*on* staging: this session's network policy refuses `*.vercel.app`, `api.supabase.com` and `api.vercel.com`, there
are no Supabase/Vercel credentials, and no staging backup exists here. The owner applies the migrations
(DEPLOYMENT §2a, with `scripts/staging-check.sql` before and after) and runs the five-step demo check there; or
adds `tltmaster.vercel.app` to the environment's allowed domains so a session can check the website side.


**2026-10-11 consolidation:** `docs/TAVIRON_MASTER_PLAN.md` now holds the founder's full master context (status by
area, branding palette, pricing proposal, demo-lead requirements, Outstanding Fixes and Operational Risks §8,
open decisions §9, roadmap order §11). Design skills from `emilkowalski/skills` are installed in `.claude/skills/`.
The first item on the roadmap is website and demo readiness (master plan §11.1). The demo-request flow is done
locally (IMPLEMENTATION_PLAN §5p); next come the reminders (§8 W6) and the pricing page (§8 W1), each after the
founder reviews the previous step.


Finish B3 staging, which now includes N13, N14 and N15 (section 5 above), then answer the open questions in TAVIRON_MASTER_PLAN §4. After that:
1. The first real team-led onboarding.
2. Payroll readiness, once pay rules are written down.
3. Company billing requirements.
4. Fleet maintenance.

See IMPLEMENTATION_PLAN "Recommended next task".

## 8. Instructions for a fresh Claude Code session

1. **Read the docs:**
   - This file.
   - `docs/IMPLEMENTATION_PLAN.md` (§5i–§5m, "Recommended next task", §8).
   - `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md` and `AGENTS.md`.
   - The Next.js docs in `node_modules/next/dist/docs/`, before writing any Next.js code.
2. **Check the repository:** run `git status` and `git log --oneline -5`, and confirm the branch matches `origin`. Do not redo milestones N9–N15.
3. **Rules that stay in force:**
   - Never reset or delete data, edit applied migrations, deploy to production, buy services or change DNS without approval.
   - Never print or commit secrets, and never ask the owner to paste keys or codes.
   - Preserve RLS, server-side checks and tenant isolation. The platform role grants no company data except through audited platform functions.
   - Fictional data only. No invented contacts, testimonials or customers.
   - Back up a dev database before schema changes.
   - Commit messages end with the session's co-author trailer.
   - Push only to this branch, and open no PR unless asked.
4. **Local stack:** rebuild it per `docs/SETUP.md` §6. Postgres data lives in `/var/lib/tlt-pg/data` on port 54322: start it with
   `pg_ctl`, then run `scripts/dev-stack/stack.sh up`. Start Next with `npx next dev -p 3000`.
