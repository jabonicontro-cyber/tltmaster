# Session handoff — Taviron

Last updated: 2026-10-11, after N13. Contains **no secrets**: no codes, keys, passwords or
project credentials. Read it together with:
- `docs/IMPLEMENTATION_PLAN.md`: §5m for N13, "Recommended next task", and roadmap §8 A–H.
- `docs/DEPLOYMENT.md`: hosting steps, including §2a (database updates) and §3a (platform access).

## 1. Repository state (verified)

- **Branch:** `claude/top-line-trucking-manager-vmw04i`. This is the only development branch, and Vercel
  deploys the staging site from it. Run `git log --oneline -5` to see the current head.
- **Migrations:** 21 in `supabase/migrations/`, the latest being `20261024000100_platform_owner.sql` (N13).
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

N13 delivered:
- **Public website:** 9 pages, proposed pricing, a 3D hero built from real screens, and lead forms.
- **Platform owner role:** granted by an operator only, and audited.
- **`/admin` launchpad and lead workspace.**
- **Live demo company:** role previews, with nothing sent outside Taviron.
- **Team-led CSV onboarding:** review, approval and reversal.

## 3. Test results (run in this session's sandbox, N13)

**Overall:**

| Check | Result |
| --- | --- |
| vitest: unit, DB and storage | 315/315 |
| Browser suite, dev server | 46 passed, 5 skipped. The skipped tests are the gate spec, which runs separately below. |
| Lint, typecheck, production build | Clean |

**Gate spec against a production build with the gate on.** It ran twice, and the outside-in checker passed all checks in both runs:

| Run | Gate spec | What it confirmed |
| --- | --- | --- |
| Default, website behind the gate | 5/5 | The website and the form endpoint redirect or answer 401. |
| `PUBLIC_SITE=on` | 5/5 | The website is open, the form endpoint answers, and everything else stays gated. |

**Fresh database:** all 21 migrations plus seed applied to an empty cluster.
- Schema is identical to dev.
- DB tests: 156 passed, 7 skipped. The skipped tests need the storage server.

**Screenshots:** those in `public/site/` were captured from the running app, using the demo company with fictional data.

## 4. Deployment and Supabase status

The facts below come from the owner's earlier screenshots and messages. The sandbox cannot reach `tltmaster.vercel.app`:
its network policy blocks the host.

| Item | Status |
| --- | --- |
| Staging site | `https://tltmaster.vercel.app` on the Vercel Hobby plan. Vercel deploys every push to this branch. |
| Supabase | Created through the Vercel integration. All 20 N12-era migrations were pushed. |
| **N13 migration `20261024000100_platform_owner.sql`** | **Not pushed to staging.** It is the owner's action, in DEPLOYMENT §2a. |
| What staging does until the migration is pushed | The app keeps working. The demo/contact form says it cannot save. The platform area answers 404. |
| `PUBLIC_SITE` | Not set, so the public website stays behind the gate. Opening it is the owner's decision: confirm the pricing and the legal drafts first. |
| `SITE_INDEXING` | Not set, so nothing is indexed. |
| `SITE_ACCESS_SECRET` | **Must be rotated.** An earlier value appeared in a screenshot, and it is unknown whether it was rotated. |
| Site code, company, owner login, phone sign-in, platform role | Not yet confirmed. |
| Auth URLs, templates, SMTP, `ticket-photos` bucket, backups | Not confirmed. See DEPLOYMENT §1. |

## 5. Outstanding manual actions (owner)

1. **Back up the staging database, then push the new migration.** On your Mac, from the project folder:
   ```bash
   git pull
   npx supabase db push
   ```
   Take the backup first, as shown in DEPLOYMENT §2a.
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
6. **When ready to show the public website:** confirm the pricing and get the Privacy and Terms drafts reviewed. Then set
   `PUBLIC_SITE=on` in Vercel and redeploy. Set `SITE_INDEXING=on` only for the real launch domain.
7. **Supabase Auth setup:** URL configuration, email templates and SMTP (DEPLOYMENT §1).

## 6. Known issues and decisions pending

- **Pricing ($499; founding offer $399.20)** is a proposal labelled "subject to confirmation". No billing code exists, and none may be added
  without explicit authorization.
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

Finish B3 staging, which now includes N13 (section 5 above). After that:
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
2. **Check the repository:** run `git status` and `git log --oneline -5`, and confirm the branch matches `origin`. Do not redo milestones N9–N13.
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
