# Session handoff — Taviron

Last updated: 2026-10-11. Contains **no secrets**: no codes, keys, passwords or project credentials.
Read with `docs/IMPLEMENTATION_PLAN.md` (requirements, history, roadmap §8) and
`docs/DEPLOYMENT.md` (hosting steps).

## 1. Repository state (verified)

- Branch: `claude/top-line-trucking-manager-vmw04i`. This is the only development branch, and the staging
  site deploys from it.
- Milestone code through `89ddf32` (check-deployment fix); this handoff and the plan's deployment
  status rows were committed right after it. Run `git log --oneline -5` for the current head.
- 20 migrations in `supabase/migrations/`, the latest being `20261023000100_site_access_gate.sql`.
  Never edit an applied migration; add new ones.
- `npm run typecheck` and `npm run lint` passed at handoff, on 2026-10-11.

## 2. Milestones in this session (all committed)

| Commit | Milestone | Plan section |
| --- | --- | --- |
| `dc21c1d` | N9: accounts, company onboarding, early-access codes for sign-up, company switcher | §5i |
| `dc1c8a9`, `098c998`, `4cede5c` | N10: unified Command Center (dashboard merged), urgent orders, personal layout and hiding, ticket review queue, order progress, company-neutral defaults | §5j |
| `cfb908d` | N11: office scans of paper tickets, review context and explanations, bulk accept, delivered-so-far, `ticket_reference_required`, `verified_delivery_inputs` (payroll input, no money) | §5k |
| `648dfad`, `89ddf32` | N12: Early Access page and server-enforced gate, operator script, `scripts/check-deployment.mjs`, `docs/DEPLOYMENT.md` | §5l |

## 3. Test results (actually run in this session's sandbox)

- **N12 final run:**
  - vitest (unit, DB and storage): 300/300.
  - Browser suite on the dev server: 41 passed, 5 skipped (the gate spec).
  - Gate spec against a production build with the gate on: 5/5.
  - Lint, typecheck, build: clean.
  - Fresh database with all 20 migrations: schema identical to dev; DB tests 151 passed, 7 skipped (no storage server there).
- **Also verified by hand** on the production build:
  - Behind HTTPS the cookie is `__Host-taviron-access` with `Secure; HttpOnly; SameSite=lax`.
  - With the gate on and no secret, every path answers 503.
- The sandbox's local dev stack (Postgres, Auth, PostgREST, storage, mailbox) is ephemeral. A new
  session must rebuild it: `docs/SETUP.md` §6, "Local backend without Docker".

## 4. Deployment and Supabase status

The facts below come from the owner's screenshots and messages, **not** from this sandbox: its
network policy blocks `tltmaster.vercel.app`, and the gateway answers 403 to CONNECT.

| Item | Status |
| --- | --- |
| Vercel project `tltmaster` (Hobby, free) | Created; Git connected; production branch = this branch |
| Staging address | `https://tltmaster.vercel.app` (HTTPS, HSTS present) |
| Supabase | Created through Vercel's Supabase integration. It set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` (plus unused `POSTGRES_*` / `SUPABASE_*` variables) |
| Supabase CLI login and `link` | Done; the owner's terminal showed "Finished supabase link." |
| `supabase db push` | Done: all 20 migrations applied, then "Remote database is up to date." |
| Gate variables (`EARLY_ACCESS_GATE`, `SITE_ACCESS_SECRET`) | Present on the live deployment. Inferred: the gate redirects and does not answer 503 |
| Vercel Deployment Protection | Off. Inferred: the app's own 307 reaches the checker |
| Outside-in check (`check-deployment.mjs`) | 15/17 passed. The 2 failures (file routes answered 403 instead of 401, still refused) were a checker defect, fixed in `89ddf32`. **Re-run pending** |
| `.env.staging` on the owner's Mac (URL + service role key) | Created. `early-access.mjs list` worked |
| `SITE_ACCESS_SECRET` | **Must be rotated**: the generated value appeared in a screenshot. Unknown whether rotated yet |
| Site-access code, company, owner login | **Not yet confirmed** as created |
| Sign-in from a phone | **Not yet confirmed** |
| `APP_BASE_URL`, Supabase Auth Site URL and redirect URLs, email templates, SMTP | Not confirmed; see DEPLOYMENT.md §1.5–1.8 |
| `ticket-photos` bucket on hosted storage, backups | Not checked |
| Custom domain | None. Not needed now |

## 5. Outstanding manual actions (owner)

1. Rotate `SITE_ACCESS_SECRET` in Vercel with a new `openssl rand -base64 32` value, never
   shared, then redeploy.
2. `git pull`, then `node scripts/check-deployment.mjs https://tltmaster.vercel.app`, and
   expect all PASS.
3. Create the site code: `early-access.mjs create --purpose site …`.
4. Create the company: `select private.create_company(...)` in the Supabase SQL Editor.
5. Create the owner login: `create-owner.mjs … <slug>`.
6. Open the site on a phone, enter the code and sign in.
7. Supabase Auth URL configuration, templates and SMTP (DEPLOYMENT.md §1).

Exact commands for steps 3–6 are in DEPLOYMENT.md §3.

## 6. Known issues and decisions pending

- The sandbox cannot reach the live site. To let Claude verify it, add `tltmaster.vercel.app`
  to the cloud environment's allowed domains.
- `npm install` on the owner's Mac reports 5 high-severity advisories. They have not been
  reviewed. Do not run `npm audit fix --force`.
- Vercel Hobby is non-commercial only, and Supabase Free has no backups and pauses when idle.
  Upgrading is the owner's decision before paying customers use the site.
- The historical B1 migration creates an empty "Top Line Trucking" company on every install.
  It may be renamed or deactivated; no code depends on it.
- No OCR. No payroll calculations: pay rules are unknown. QuickBooks Online is not integrated
  and must be verified with a test company first.

## 7. Next recommended task

Finish **B3 staging**: the owner actions above, then confirm sign-in from a phone. After that,
in order (IMPLEMENTATION_PLAN "Recommended next task" and §8):
1. Auth email (SMTP) and the invitation flow with a real inbox.
2. A backup/restore drill.
3. Payroll readiness, once the pay rules are written down.
4. Company billing requirements.
5. Fleet maintenance and defects.

Keep Taviron generic and multi-tenant: no company is a default tenant, and nothing is hardcoded by company name.

## 8. Instructions for a fresh Claude Code session

1. Read this file, then `docs/IMPLEMENTATION_PLAN.md` (§5i–§5l, "Recommended next task",
   §8), `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md`, and `AGENTS.md`. Read the Next.js docs
   in `node_modules/next/dist/docs/` before writing Next.js code.
2. Verify `git status`, `git log --oneline -5` and that the branch matches `origin`. Do not
   redo committed milestones N9–N12.
3. Rules that stay in force:
   - Never reset or delete data, edit applied migrations, deploy to production, buy services or change DNS without approval.
   - Never print or commit secrets, and never ask the owner to paste keys or codes.
   - Preserve RLS, server-side checks and tenant isolation.
   - Back up a dev database before schema changes.
   - Commit messages end with the session's co-author trailer.
   - Push only to this branch, and open no PR unless asked.
4. If you need the local stack, rebuild it per `docs/SETUP.md` §6. Start Next with `npx next dev -p 3000`.
