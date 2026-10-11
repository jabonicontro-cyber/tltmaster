# Session handoff — Taviron

Last updated: 2026-10-11, after N15. Contains **no secrets**: no codes, keys, passwords or
project credentials. Read it together with:
- `CLAUDE.md` and `docs/TAVIRON_MASTER_PLAN.md`: rules, decisions and open business questions.
- `docs/IMPLEMENTATION_PLAN.md`: §5m (N13), §5n (N14), §5o (N15: Smart Dispatch algorithm, hard blocks vs warnings, branding, fulfillment), "Recommended next task", and roadmap §8 A–H.
- `docs/RELEASE_CHECKLIST.md`: what to check before calling a release done.
- `docs/DEPLOYMENT.md`: hosting steps, including §2a (database updates) and §3a (platform access).

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
