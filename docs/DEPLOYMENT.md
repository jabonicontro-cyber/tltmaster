# Deploying Taviron (staging / early access)

This puts Taviron on a real HTTPS address with the Early Access gate in front of it.
It uses two services that both have free tiers and need **accounts in your name**:

| Piece | Service | Free tier notes (verify current terms before relying on them) |
| --- | --- | --- |
| Web app (Next.js) | **Vercel** | Hobby plan: free, HTTPS on `*.vercel.app`, **personal / non-commercial use only**. Using it for a business (including a paid beta) needs the Pro plan (paid) — decide before customers use it. |
| Database, sign-in, file storage | **Supabase** | Free plan: 2 projects, small database and storage limits, projects **pause after a week without activity**, no automatic backups. The Pro plan (paid) adds daily backups. |

Nothing here costs money on the free tiers. Upgrading either plan is a paid decision for you.

Environments stay separate: your computer uses the local stack; this guide creates a
**staging** Supabase project and a **staging** Vercel project. A future production setup
repeats the same steps with new projects — never point staging at production data.

---

## 1. Supabase (staging database, sign-in and storage)

1. Sign in at supabase.com → **New project** → name `taviron-staging`, a strong database
   password (keep it in your password manager), a US region near your users.
2. **Project Settings → API**: note the *Project URL*, the *anon public* key and the
   *service_role* key (secret — server only).
3. Apply the database from this repository (from your computer, in the project folder):
   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push          # applies every file in supabase/migrations, in order
   ```
   Do **not** load `supabase/seed.sql` (sample data) into anything but a throwaway test.
   The migrations create an empty company named "Top Line Trucking" (historical); in
   **Table Editor → companies** you may rename or deactivate it.
4. Check storage: **SQL Editor** →
   ```sql
   select id, public from storage.buckets where id = 'ticket-photos';
   ```
   Expect one row with `public = false`. If it is missing, run
   `select private.setup_ticket_photo_storage();`.
5. **Authentication → Sign In / Providers**: Email on; **"Allow new users to sign up" off**;
   **"Confirm email" on**.
6. **Authentication → URL Configuration**: *Site URL* = your Vercel address from step 2.4
   (come back after deploying), *Redirect URLs* = `<address>/auth/confirm` and
   `<address>/auth/confirm**`.
7. **Authentication → Email Templates**: paste `supabase/templates/confirmation.html`,
   `invite.html` and `recovery.html` into *Confirm signup*, *Invite user* and *Reset
   password*.
8. **Authentication → SMTP**: the built-in sender only sends a few emails per hour and is
   meant for testing. For invitations to real people, configure SMTP (e.g. Resend, which has
   a free tier) — optional for a first look.

## 2. Vercel (the web address)

1. Sign in at vercel.com with GitHub → **Add New → Project** → import
   `jabonicontro-cyber/tltmaster`.
2. **Settings → Git → Production Branch**: set it to the branch you want staging to run
   (for now `claude/top-line-trucking-manager-vmw04i`). This is the *staging* project; a
   real production project later gets its own branch, database and settings.
3. **Settings → Environment Variables** (Environment: Production; also Preview if you use
   preview URLs). Names and purpose — values come from your own accounts:

   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon public key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key (**mark Sensitive**) |
   | `APP_BASE_URL` | `https://<your-project>.vercel.app` (or your domain later) |
   | `EARLY_ACCESS_GATE` | `on` |
   | `SITE_ACCESS_SECRET` | 32+ random characters — generate with `openssl rand -base64 32` (**Sensitive**) |
   | `EARLY_ACCESS_DAYS` | `30` (optional) |
   | `EARLY_ACCESS_PASSWORD` | the shared Early Access password you give to prospects: 12–128 characters, e.g. four random words (**Sensitive**). Empty: only personal site codes work (§3b) |
   | `EARLY_ACCESS_PASSWORD_MAX_DEVICES` | `500` (optional): devices admitted with the password at the same time, 1–1000 |
   | `EMAIL_PROVIDER` | `preview` (quote emails are shown, not sent, until Resend is set up) |
   | `PUBLIC_SITE` | `on` when you decide the public website (home, pricing, demo request…) should be open to everyone. Empty (default): it stays behind the Early Access page like the rest |
   | `SITE_INDEXING` | leave empty on staging (search engines are told not to index anything). `on` lets them index the nine public pages only — decide before launch |

   Without `SITE_ACCESS_SECRET` the app deliberately answers **503** to everything.
4. **Settings → Deployment Protection**: turn *Vercel Authentication* off for this project
   (otherwise visitors see a Vercel login before the Early Access page).
5. **Deploy**. Vercel gives you `https://<your-project>.vercel.app` with HTTPS.
6. Back in Supabase step 1.6, set the Site URL and redirect URLs to that address.
7. Check it from anywhere (no credentials needed):
   ```bash
   node scripts/check-deployment.mjs https://<your-project>.vercel.app
   ```
   It notes whether the public website is open (`PUBLIC_SITE=on`) or behind the gate; when
   open, it checks the form endpoint answers (one unreadable submission; nothing is saved).
   Either way everything else must be behind the gate.

## 2b. Preview and production (proposed — owner approval needed)

**Today (verified from GitHub's deployment records, 2026-10-11):** the repository has one branch,
`claude/top-line-trucking-manager-vmw04i`, which is also its default branch. All 19 Vercel deployments
so far are **Production** deployments of that branch; there has never been a Preview deployment. So every
push goes straight to whatever domains the project's Production environment serves —
`tltmaster.vercel.app`, and `mytaviron.com` too if it is attached to this project (not verifiable from
Claude's sandbox).

**Update (verified 2026-10-11):** a push of the new branch `claude/ui-and-signin-checkpoint` (commit `7586464`)
was recorded by Vercel as a **Preview** deployment (build succeeded; Production stayed on `16fc188`). So any branch
other than the production branch already deploys to Preview; what is still missing is `main` as the production
branch, the domain assignments and the Preview variables below. Until then Claude pushes only to non-production
branches (CLAUDE.md → Workflow).

**Target:** `mytaviron.com` = Production, built only from `main`; `tltmaster.vercel.app` = Preview of the
working branch. No new project, no paid service, no code change (the app behaves the same in both; the
gate is on for every Vercel build).

Owner steps, in this order (each is reversible):
1. **Create `main`** at the commit that should be live (GitHub → branch selector → type `main` → "Create
   branch from claude/top-line-trucking-manager-vmw04i"), or ask Claude to push it. Optionally make it the
   repository's default branch (Settings → General → Default branch).
2. **Production Branch → `main`:** Vercel → Project → Settings → Environments → Production → Branch
   Tracking (older dashboards: Settings → Git → Production Branch). From now on only `main` deploys to
   Production; pushes to the working branch create **Preview** deployments.
3. **Domains:** Settings → Domains → `mytaviron.com` (and `www`) → environment **Production**.
   `tltmaster.vercel.app` → Edit → **Preview** with Git branch `claude/top-line-trucking-manager-vmw04i`,
   so it always shows the latest preview of the working branch.
4. **Environment variables are per environment** — copy every variable in §2 to **Preview** too (they are
   not shared automatically), with `APP_BASE_URL` = `https://tltmaster.vercel.app` for Preview and
   `https://mytaviron.com` for Production. `EARLY_ACCESS_GATE=on` in both. Use a different
   `SITE_ACCESS_SECRET` per environment. `EARLY_ACCESS_PASSWORD` in each environment where the shared
   password should work (it can differ). Leave `PUBLIC_SITE` and `SITE_INDEXING` off in Preview.
5. **Database:** until a production Supabase project exists, both environments can point at
   `taviron-staging` (no real customers yet) — but then preview tests and the official site share one
   database. Before real customers: a second Supabase project for Production (free plan allows two), its
   own keys in the Production variables, all migrations applied there (§2a), and its Auth URL
   configuration set to `https://mytaviron.com`. Whichever project each environment uses, add that
   environment's address under Supabase → Authentication → URL Configuration → Redirect URLs.
6. **Redeploy** each environment after changing its variables.

**Promotion (after the split):** work happens on the working branch → Vercel builds a Preview →
check it on `tltmaster.vercel.app` → when approved, merge the working branch into `main` (a pull request or
a fast-forward). That merge is the only thing that changes `mytaviron.com`. Claude pushes only to the working
branch and never to `main` without the owner's explicit approval. Database migrations stay a separate
owner step per Supabase project (apply to staging, verify on preview, then to production before merging code
that needs them). Rollback: Vercel → Deployments → previous Production deployment → Instant Rollback.

## 2a. Updating the database after a new release

Each release that adds a file to `supabase/migrations/` needs it applied to the staging
database **before or right after** the new app version deploys. Run these from the project
folder on your computer (linked in step 1.3), one at a time, reading each result:

```bash
git pull
npx supabase projects list        # the linked project is marked ●; it must be the STAGING project
npx supabase migration list       # Local vs Remote: every row but the new one(s) should show both
```

Back up first — the free plan has no backups. Either:

```bash
npx supabase db dump -f staging-schema-$(date +%F).sql               # needs Docker Desktop running
npx supabase db dump --data-only -f staging-data-$(date +%F).sql
```

or, without Docker, with PostgreSQL's own tool (`brew install postgresql@17`), using the
**Session pooler** connection string from Supabase → **Connect** (type the database
password when asked; never paste it into chat or a file in the repository):

```bash
pg_dump "<session pooler connection string>" -Fc -f staging-$(date +%F).dump
```

Check the backup file exists and is not empty (`ls -lh staging-*`). A 0-byte file means the backup failed —
delete it and use the Supabase CLI dump instead (Docker Desktop running).

**See what staging already has (read-only):** open Supabase → **SQL Editor** for the staging project,
paste `scripts/staging-check.sql` and run it. The first table shows, per recent migration, whether its
objects exist (`true`/`false`); the second lists what the CLI recorded as applied. Every `false` row
should appear in the dry run below — if the two disagree, stop and ask before pushing. Then:

```bash
npx supabase db push --dry-run    # lists what WOULD be applied; expect only the new migration(s)
npx supabase db push              # applies them; answer Y to the prompt
npx supabase migration list       # the new row now shows a Remote version too
```

Migrations are additive and never delete data. If `db push` reports an error, stop, keep
the output, and do not retry or edit anything until it has been looked at.

**Checking the demo-request flow on staging after the push** (creates one test lead; nothing is
emailed while `EMAIL_PROVIDER` is preview):
1. Run `scripts/staging-check.sql` again — every row `true`.
2. Open `/demo` (with your site-access code). Press **Request a demo** with the form empty: name,
   email, company, trucks and bases are flagged. Enter bases `0`: refused. Trucks `0` and bases `1`
   with a name like "Staging check (test)": accepted.
3. Sign in, open `/admin/leads`: the lead shows "0 trucks · 1 base". Open it: the **Emails** card lists
   two attempts marked **Not sent**; the Status list shows exactly New, Contacted, Demo Scheduled,
   Demo Completed, Converted, Not Proceeding.
4. Set Contacted, add a note: both appear in History. Tick **Spam** while Contacted: refused. Set
   Not Proceeding + Spam: the lead leaves the default list and appears under "Flagged as spam".
5. Signed in as a company user (not the platform role), `/admin/leads` answers "not found".

The demo-request update adds `20261028000100_demo_lead_workflow.sql` (apply after N15). It folds
the earlier lead statuses into the six agreed ones — qualified → Contacted, onboarding → Converted
(onboarding in progress), won → Converted, lost → Not Proceeding, spam → Not Proceeding flagged as
spam — and records each change in the lead's history; no lead or history entry is removed. Until it
is applied, the website form still saves leads but the truck and base counts are dropped, no email
attempt is recorded, and changing a lead's status in `/admin/leads` fails.
Reversal, only if needed and after a backup: run `supabase/rollbacks/20261028000100_demo_lead_workflow.down.sql`
in the SQL editor (it restores the earlier statuses and functions and keeps all data). Lead emails
stay off until you choose an email provider: with `EMAIL_PROVIDER=preview` every attempt is
recorded on the lead as "not sent".

N15 adds `20261027000100_smart_dispatch_workflow_branding.sql` and
`20261027000200_branding_settings_grant.sql` (Smart Dispatch rejections, safety-report and
capacity checks in assignments, automatic order on quote acceptance, the delivery-location
rule for scheduling, fulfillment-based billing readiness, and company branding). They must be
applied after the N13 and N14 files above; whether any of those four earlier files is on
staging has **not** been verified from here — `npx supabase migration list` shows it. Until
the N15 files are pushed: the Smart Dispatch panel shows "could not be produced", Settings →
Branding cannot save, quote acceptance does not create the order (convert it by hand as
before), and order billing steps may show as unavailable; the rest keeps working.
After pushing, check in the app: accept a test quote (an order appears), open Dispatch (the
Smart Dispatch panel lists open loads), and save and then clear a brand color in Settings.

N14 adds `20261025000100_order_scheduling_queue.sql` and `20261026000100_operations_report.sql`
(the Command Center's "needs a delivery date" items and the Reports page). Until they are
pushed: the Dispatch "Needs scheduling" queue still works (it reads existing columns), the
Command Center simply lacks the new item type, and Reports says the report could not be
produced. A `--dry-run` should list every migration not yet applied, in order.

N13 (public website, platform area) adds `20261024000100_platform_owner.sql`. Until it is
pushed, the demo/contact form answers "could not be saved" and the platform area is
unavailable; the rest of the app keeps working. The public website stays behind the gate
until you set `PUBLIC_SITE=on` in Vercel (and redeploy) — do that once the pricing and the
draft legal pages are confirmed.

**Seeing the website without making it public:** a device admitted with a site-access code
(step 3), or a signed-in user, sees every public page while `PUBLIC_SITE` is off. That is
the way to review it before opening it to everyone.

**Which Vercel environment is this?** In Vercel's terms the staging site is the project's
**Production** environment: every push to the production branch deploys there and is
aliased to `tltmaster.vercel.app` (GitHub records each one as a "Production" deployment).
So a variable set for *Production* in this project affects `tltmaster.vercel.app` — and any
custom domain you add to the project later. Before setting `PUBLIC_SITE=on`, check
**Settings → Domains**: if only `tltmaster.vercel.app` is listed, the change affects this
staging address only. A real launch should use its own project and database.

**Communications hardening (`20261108000100_comm_hardening.sql`, after `20261107000100`).** Fixed 5-minute
edit/delete window, manager removal with a reason, 14-day message content retention (legal hold overrides), the
all-companies housekeeping function, the archive veto and the driver handoff (docs/COMMUNICATIONS.md). Optional, before
pushing it: Supabase → Database → Extensions → enable **pg_cron** if you want the cleanup every 15 minutes (the
migration then schedules it). Then, separately and only with your approval each time:
- Vercel → Settings → Environment Variables → add `CRON_SECRET` (at least 16 random characters, e.g.
  `openssl rand -hex 24`) for Production (and Preview if wanted), then redeploy. Vercel Cron (`vercel.json`) calls
  `/api/cron/comm-housekeeping` daily with it. Without the variable the route refuses every call and only the
  read-time expiry and the per-company cleanup while people use Communications apply.
- Check after the next run: Vercel → Logs for `/api/cron/comm-housekeeping` (200 with `ok: true`).
Rollback: `supabase/rollbacks/20261108000100_comm_hardening.down.sql` (expired messages stay as deleted tombstones).

**Demo welcome (`20261109000100_demo_welcome.sql`, after `20261108000100`).** Remembers, per person and demo company,
that the demo welcome dialog was seen (`user_preferences` key `demo_welcome`, `public.dismiss_demo_welcome()`; refused
for real companies). Additive. Until it is applied, the app remembers the dismissal in a browser cookie, so a demo
user who signs in on another browser sees the welcome once more there. Rollback:
`supabase/rollbacks/20261109000100_demo_welcome.down.sql`.

**AI usage ledger (`20261110000100_ai_usage.sql`, after `20261109000100`).** Adds `public.ai_usage_events` (counts,
timings and outcomes per AI call; no prompts or answers), `public.record_ai_usage(...)` and
`public.ai_usage_summary()` (docs/AI.md §6). Additive and needed only when an AI capability is turned on. Until it is
applied every AI capability is Blocked ("usage ledger not available") and nothing is sent to a model. Rollback:
`supabase/rollbacks/20261110000100_ai_usage.down.sql`.

**Demo driver names (`20261111000100_demo_driver_names.sql`, independent of the AI ledger).** Redefines the
`public.driver_list` view so that, in a demo company only, a driver linked to a login is named by the driver record (the
persona, e.g. Daniel Mitchell) instead of the login's account name. Same columns and grants; real companies are
unchanged. Safe to skip: until it is applied, demo lists show the presenter's own name next to the persona. Rollback:
`supabase/rollbacks/20261111000100_demo_driver_names.down.sql` (tested locally 2026-10-13).

**Demo people names in the Command Center (`20261111000200_demo_people_names.sql`, after `20261111000100`).**
Redefines `command_center_exceptions`, `exception_assignee_options` and `assign_exception` with only the name
expression changed to `private.comm_user_name` (needs `20261108000100`, already applied): the persona in demo
companies; elsewhere the person's display name, then full name. Safe to skip (demos then show the presenter's login
name as an item's assignee). Rollback: `supabase/rollbacks/20261111000200_demo_people_names.down.sql` (tested locally
2026-10-13).

## 3. Let yourself (and testers) in

From your computer, with a `.env.staging` file containing only the staging
`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (never commit it):

```bash
# An early-access code for your own devices (phone, laptop): up to 5 devices, 30 days
node --env-file=.env.staging scripts/early-access.mjs create --purpose site --label "Owner devices" --uses 5 --days 30
```
The code is printed **once**. Open the address on your phone, enter the code, and you reach
the normal sign-in page.

You also need an account and a company (the gate never creates them):

- **Recommended:** create your company and owner directly —
  Supabase **SQL Editor**: `select private.create_company('Your Company LLC', 'your-company');`
  then on your computer:
  `node --env-file=.env.staging scripts/create-owner.mjs you@example.com "Your Name" your-company`
  (asks for a password). Sign in on the phone.
- **Or** use self-serve sign-up: create a *company* code
  (`create --label "Your company" --uses 1`), open `/signup` after the gate, and confirm the
  email (needs working Auth email, step 1.8).

### 3a. Your platform (Taviron team) access

The platform area (`/admin`: leads, live demo, company onboarding, audit log) is only for
people you grant the **platform role**. It is separate from being an owner of a company, and
it can only be granted from your computer with the service-role key — never from the
website:

```bash
# You need a normal Taviron login first (create-owner.mjs above, or an invitation).
node --env-file=.env.staging scripts/platform-admin.mjs grant you@example.com --note "Founder"
node --env-file=.env.staging scripts/platform-admin.mjs list
node --env-file=.env.staging scripts/platform-admin.mjs revoke someone@example.com --note "Left the team"
```

Then sign in and open `https://<your-project>.vercel.app/admin`. To show the product, open
**Live demo → Start the demo**: it creates a separate demo company with fictional data and
switches you into it; the yellow bar at the top lets you view it as each role. Use the
company switcher in the account menu to go back to your own company.

**Testers:** give each group its own site code (`--purpose site --label "Pilot: Ridgeway"
--uses 10`), then invite their users from Settings → Users (invitation links work without
a code). List and revoke:
```bash
node --env-file=.env.staging scripts/early-access.mjs list
node --env-file=.env.staging scripts/early-access.mjs revoke <code-id> --reason "Pilot ended"
node --env-file=.env.staging scripts/early-access.mjs revoke-devices <code-id> --reason "Shared too widely"
```
**Rotate** a code: create a new one, send it, revoke the old one. Changing
`SITE_ACCESS_SECRET` in Vercel (and redeploying) signs every device out of early access
at once.

### 3b. The shared Early Access password

Instead of a personal code per person, you can give selected prospects one password. It is
set only in the server environment and checked on the server; it is never stored in the
database, logged or sent to the browser (the database keeps a keyed fingerprint).

**Set it up (staging):**
1. Apply migration `20261029000100_shared_early_access_password.sql` first (§2a). Until it
   is applied, the password is refused with "temporarily unavailable"; codes keep working.
2. Vercel → Project → Settings → Environment Variables → add `EARLY_ACCESS_PASSWORD`
   (mark **Sensitive**, Production environment — the one `tltmaster.vercel.app` uses). Pick
   12–128 characters you can read out loud, e.g. four random words; never reuse
   `SITE_ACCESS_SECRET` or any other secret. Optionally `EARLY_ACCESS_PASSWORD_MAX_DEVICES`.
3. Redeploy (Deployments → ⋯ → Redeploy) — environment changes apply only to new deployments.
4. In a private window: open the site → Early Access page → wrong password refused → the
   password → sign-in page. Then sign in as usual.

**What the password does — and does not:** it admits *this browser* to the sign-in page,
exactly like a personal code: the device gets its own grant and signed cookie, re-checked
every 5 minutes. It never signs anyone in and never grants an account, company, membership
or permission — those still need an invitation or an approved sign-up, and roles still
apply. Personal codes keep working on the same page.

**Rotate it** (e.g. a prospect passed it on): change `EARLY_ACCESS_PASSWORD` in Vercel and
redeploy. The first entry with the new password retires the old one and signs out every
device admitted with it (within 5 minutes). To sign them out immediately — or to stop the
password altogether without a deploy — revoke its record:
```bash
node --env-file=.env.staging scripts/early-access.mjs list            # the row marked "shared"
node --env-file=.env.staging scripts/early-access.mjs revoke-devices <id> --reason "Rotated"   # devices out, password still works
node --env-file=.env.staging scripts/early-access.mjs revoke <id> --reason "Paused"            # devices out and this password refused until it is changed
```
Wrong entries (password or code) count together: 10 per network address per 15 minutes.
A visitor can remove early access from their own browser from the sign-in page
("Remove early access from this browser"); that ends the device's grant.

### 3c. A prospect demo tenant and its owner's login (e.g. Prairie Lantern Freight for Colby Chapman)

A prospect demo is a standing demo company for one prospect: fictional data, a one-time demo welcome and a "Demo" badge, nothing sent, and never
replaced by "Start the demo". Needs migrations `20261106000100_prospect_demo_tenants.sql` and `20261107000100_people_photos_and_demo_retire.sql`
(after the pending ones; §2a). Each step below is an owner action; nothing here is done automatically.

- **Keeping the demo current:** `/admin/demo` → **Refresh demo data** (Prairie Lantern Freight). Additive only: loads for
  the last 10 weekdays, today and tomorrow when those days are empty (finished ones delivered and verified), and any
  sample records missing from the current set. It changes and deletes nothing, so the prospect's own work and access
  stay; running it twice on a day adds nothing. You must still be a member of the demo (you are if you created it).
  App features and fixes reach every demo automatically with each release; only the sample data needs refreshing.
  It also runs the shared feature samples (`src/server/demo/samples.ts`; docs/DEMO_TENANTS.md §5): maintenance work
  orders and schedules, fleet documents, time off, a quote, an operation workspace, and a driver day for the owner
  once their employee record is linked (step 3). **After every release that adds samples, run Refresh on each prospect
  demo** (after applying that release's migrations) so every demo mode shows the new feature.
0. **Replacing an earlier version of the demo** (needs migration `20261107000100`): `/admin/demo` → tick the box next to
   the old Prairie Lantern Freight → **Retire** (it and its memberships become inactive; nothing is deleted), then
   continue with step 1. Logins made owner of the old demo must be made owner of the new one (step 3).
1. **Create and fill the tenant:** sign in as a platform admin → `/admin/demo` → "Create the Prairie Lantern Freight
   demo". You become its owner (switch companies from your menu). Note its slug (`prospect-…`) shown there.
2. **The prospect's login — they choose their own password.** Either with a **username** (decided 2026-10-12 for
   Colby Chapman: `colbychapman`) or with their verified email address (never guessed):
   `node --env-file=.env.staging scripts/platform-admin.mjs setup-link colbychapman --base-url https://<site>`.
   This creates a login with no company and prints a one-time link; nothing is emailed. Give the link to them
   privately; they open it and set their password (Supabase Auth must have the site URL configured, §1).
   A username account signs in with the username in the "Email or username" box. Its internal sign-in address
   (`colbychapman@users.mytaviron.com`) is not a mailbox: nothing is ever sent to it, the reset-password page
   refuses it, and if the password is forgotten you run `setup-link` again for a new link.
3. **Owner access to that one tenant:** `node --env-file=.env.staging scripts/platform-admin.mjs demo-owner
   colbychapman <prospect-slug> --name "Colby Chapman"` (a username or an email). `--name` sets the login's name
   when it has none and links the demo's "Colby Chapman" employee record to the login. The database accepts only an active prospect demo company
   and an existing login; it never grants access to a real company, the presenter demo, or the platform.
   With migration `20261108000100` the owner also joins the sample "Dispatch desk" channel and the demo's operation
   workspaces at once. Then run **Refresh demo data** so the owner gets their own driver day (My Day, Drives too).
4. **Verify before saying the login is ready:** they sign in, land on the Command Center of the demo tenant (owner),
   the demo welcome appears once (then the "Demo" badge on the account button), their own profile photo shows in the
   header if they added one, and the company menu lists no other company.

Do not use `scripts/create-owner.mjs` for a prospect (it sets a password chosen by the operator).

## 4. Custom domain (later)

1. Vercel → Project → **Settings → Domains** → add `app.yourdomain.com`.
2. At your domain registrar's DNS, add the record Vercel shows (for a subdomain usually
   `CNAME app → cname.vercel-dns.com`). Vercel issues the HTTPS certificate automatically.
3. Update `APP_BASE_URL` in Vercel and the Site URL / redirect URLs in Supabase to the new
   address, then redeploy. The gate stays on.

No domain is configured by this repository; buying one is your decision.

## 5. Updating and rolling back

- **App**: every push to the staging branch deploys. To undo, Vercel → Deployments → pick
  the previous one → **Promote / Instant Rollback**. The previous version must be compatible
  with the database (migrations are additive, so older app versions keep working).
- **Database**: migrations only move forward and are additive. Before `supabase db push`,
  take a backup: `pg_dump "<connection string from Supabase → Database>" -Fc -f before.dump`
  (on the free plan there are no automatic backups). To restore, see docs/BACKUP_RESTORE.md.
  Never edit an applied migration; fix forward with a new one.
- **Storage files** are not in database backups (see SETUP §2 step 11).

## 6. What the gate does (and does not)

- **With `PUBLIC_SITE=on` the public website is open**: `/`, `/platform`, `/solutions`,
  `/pricing`, `/about`, `/contact`, `/demo`, `/privacy`, `/terms` (exact paths, read-only)
  and the form endpoint `POST /api/leads`. Nothing else is. Without it (the default) the
  website is behind the gate like everything else.
- Every other page, server action, API route and file route checks for early access
  **before** anything else; without it pages redirect to `/early-access` and everything
  else returns 401 — including a server action posted to a public page. Exceptions: the
  Early Access page and Supabase Auth email links (`/auth/confirm`), which carry their own
  one-time tokens.
- A valid code — or the shared Early Access password (§3b) — gives this browser a signed, HttpOnly, Secure, SameSite=Lax cookie
  (`__Host-taviron-access`) tied to a database grant; it is re-checked every 5 minutes, so a
  revoked code or device loses access within 5 minutes. Wrong codes are limited to 10 per
  network address per 15 minutes.
- **Signed-in users pass the gate**: an account already means someone invited or approved
  them. Passing the gate never creates an account, a company, a membership or a permission.
- Codes are never stored (only SHA-256 hashes), never logged and never sent to the browser.
  The shared password lives only in the server environment (the database keeps an HMAC
  fingerprint keyed with `SITE_ACCESS_SECRET`); it is compared in constant time.
