# Taviron — instructions for Claude Code

Taviron is a multi-tenant operations platform for hauling and aggregate companies (Next.js 16
App Router + Supabase). Read `AGENTS.md` first: this Next.js version differs from older
ones, so check `node_modules/next/dist/docs/` before writing Next.js code. The proxy is
`src/proxy.ts`.

## Where things are

| Path | What it holds |
| --- | --- |
| `docs/SESSION_HANDOFF.md` | Current state, deployment status, outstanding owner actions. Read it first. |
| `docs/TAVIRON_MASTER_PLAN.md` | Product direction, confirmed decisions vs proposals, open questions. |
| `docs/IMPLEMENTATION_PLAN.md` | What was built per milestone (§5–§5n), the roadmap (§8). |
| `docs/DEPLOYMENT.md` | Vercel + Supabase staging, migrations (§2a), platform access (§3a). |
| `docs/SETUP.md` | Environment variables, the local stack without Docker, tests. |
| `docs/ARCHITECTURE.md` | Request flow and the security model. |
| `docs/SCHEMA.md` | Database tables and rules. |

## Rules that always apply

- **Tenancy and authorization:**
  - Every business table has `company_id` and RLS.
  - Never trust a company id or role from the client.
  - Permissions are checked on the server (`src/server/auth.ts`) and again in the database.
  - A `SECURITY DEFINER` function must pin `search_path = ''` and be added to the reviewed list in `tests/db/tenancy.test.ts`.
- **Platform owner** (`private.platform_admins`):
  - Granted only by `scripts/platform-admin.mjs`. Never add a page or route that grants it.
  - Demo role previews only narrow permissions; they never grant them.
- **Migrations:**
  - Never edit an applied migration; add a new versioned file in `supabase/migrations/`.
  - Back up the dev database before applying one: `pg_dump -Fc` into `/var/lib/tlt-backups/`.
  - Staging and production migrations are the owner's action (DEPLOYMENT §2a).
- **No silent side effects:**
  - No real emails, invoices, accounting exports or payments without explicit authorization.
  - The demo company never sends anything.
- **Honest data:**
  - Never invent business rules (pay formulas, pricing), contacts, customers, testimonials or metrics.
  - Missing data is shown as missing; estimates are labelled.
- **Deployment and secrets:**
  - Never deploy to production, change DNS or add paid services without approval.
  - Never print or commit secrets.

## Workflow

- **Branch:** `claude/top-line-trucking-manager-vmw04i`. Every push deploys to the Vercel project's
  Production environment (`tltmaster.vercel.app`, which serves as staging).
- **Commits** end with the session's co-author trailer. Don't open a PR unless asked.
- **Checks before a push:**
  - `npm run lint`, `npx tsc --noEmit`
  - `npx vitest run` (unit, DB and storage tests; needs the local stack)
  - `npx playwright test` (needs the dev server)
  - `npm run build`
  - The gate spec against a production build (SETUP §5).
- **Local stack:** Postgres on 54322 (`/var/lib/tlt-pg/data`), then `scripts/dev-stack/stack.sh up`, then
  `npx next dev -p 3000`. See SETUP §6.
