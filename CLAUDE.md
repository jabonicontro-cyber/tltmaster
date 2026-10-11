# Taviron — instructions for Claude Code

Taviron is a multi-tenant operations platform for hauling and aggregate companies (Next.js 16
App Router + Supabase). Read `AGENTS.md` first: this Next.js version differs from older
ones, so check `node_modules/next/dist/docs/` before writing Next.js code. The proxy is
`src/proxy.ts`.

## Where things are

| Path | What it holds |
| --- | --- |
| `docs/SESSION_HANDOFF.md` | Current state, deployment status, outstanding owner actions. Read it first. |
| `docs/TAVIRON_MASTER_PLAN.md` | **The one authoritative plan:** status by area, confirmed decisions vs proposals, pricing proposal, Outstanding Fixes and Operational Risks (§8), open decisions (§9), roadmap order (§11). Update it; never start a competing plan. |
| `docs/IMPLEMENTATION_PLAN.md` | What was built per milestone (§5–§5p). |
| `docs/DEPLOYMENT.md` | Vercel + Supabase staging, migrations (§2a), platform access (§3a). |
| `docs/SETUP.md` | Environment variables, the local stack without Docker, tests. |
| `docs/ARCHITECTURE.md` | Request flow and the security model. |
| `docs/SCHEMA.md` | Database tables and rules. |
| `docs/RELEASE_CHECKLIST.md` | What to check before a release is called done. |
| `docs/SCREENSHOTS.md` | How to capture product screenshots for the website. |
| `.claude/skills/` | Design skills from `emilkowalski/skills` (MIT; `skills-lock.json`). Use `emil-design-eng`, `review-animations`, `mobile-native`, `break-ui`, `apple-design` and `ask-sonner` for UI work; they never override the rules below. |

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
  - A reversible change gets a tested rollback script in `supabase/rollbacks/` (not a migration).
- **No silent side effects:**
  - No real emails, invoices, accounting exports or payments without explicit authorization.
  - The demo company never sends anything.
- **Suggestions never act on their own:**
  - Smart Dispatch (`src/lib/dispatch/smart.ts`) only proposes; assignments go through `assign_load` after a dispatcher approves.
  - Invoice drafts are computed previews; nothing is issued or exported.
- **Working with the founder:**
  - Audit before rebuilding; verify earlier reports instead of trusting them.
  - During requirements discovery ask one concise question at a time; never re-ask what the master plan answers.
  - Keep code written / tested / committed / pushed / deployed / verified as separate statuses.
- **Pricing and offers:** the founder's tier prices (master plan §5.1) are on the gated pricing page, from
  `src/lib/site/pricing.ts` only; founding-customer discounts are private and never shown publicly or put in site code; no checkout, billing or payment code without explicit authorization.
- **Brand:** Taviron navy/blue/silver palette (master plan §4); red only for genuine critical alerts. Public
  pages use the tokens in `src/app/globals.css` (`navy`, `electric`, `action`, `silver`, `cloud`); filled
  buttons with white text use `bg-action`, never `bg-electric`.
- **Urgency colour:** urgent, critical and safety states use `critical` (fixed red), never `brand` — `brand`
  follows each company's own colour.
- **Light and dark mode (app):** use the theme tokens — `bg-card` (never `bg-white`), `bg-surface`, `text-ink`,
  `text-muted`, `border-line`, `text-brand-fg` for brand-coloured text, `bg-strong`/`border-strong` for selected
  states (`charcoal` is the navigation only). Printable documents carry `force-light`. See `src/lib/theme.ts`.
- **Screenshots of the app:** follow `docs/SCREENSHOTS.md` (demo company, presentation mode, production build).
  Company workspaces use the company's own branding (`src/lib/branding.ts`).
- **Public website claims:** only what `src/lib/site/capabilities.ts` lists as available; run
  `docs/RELEASE_CHECKLIST.md` before calling a release done.
- **Honest data:**
  - Never invent business rules (pay formulas, pricing), contacts, customers, testimonials or metrics.
  - Missing data is shown as missing; estimates are labelled.
- **Deployment and secrets:**
  - Never deploy to production, change DNS or add paid services without approval.
  - Never print or commit secrets.

## Workflow

- **Branches and environments (verified 2026-10-11 from GitHub's deployment records):**
  - `claude/top-line-trucking-manager-vmw04i` is still Vercel's **Production Branch**: a push to it deploys to
    Production (`tltmaster.vercel.app`, and any domain on that environment). Push to it only through the release
    rule below (standing owner authorization, 2026-10-11): fast-forward only, never force.
  - Any other branch deploys to **Preview** only (first proven by `claude/ui-and-signin-checkpoint`, recorded as
    Preview). Work and push on `claude/ui-and-signin-checkpoint` (or another non-production branch) until the owner
    finishes the split in docs/DEPLOYMENT.md §2b (`main` → Production on `mytaviron.com`).
  - Before any push, re-check which branch Production tracks (GitHub deployment records); if unsure, don't push.
- **Deployment policy:**
  - Docs, plans, handoffs and test reports don't justify a deployment: commit them, and push them only together
    with the next real code checkpoint.
  - Code, styles, assets, routes, auth or server changes: run the focused and checkpoint tests, group related
    changes, push the checkpoint to the Preview branch, then verify the deployed URL in a browser. A local build
    does not prove the deployed site works; say "not verified live" when it couldn't be checked.
  - **Release rule (owner, 2026-10-11):** Preview is a checkpoint, not the destination. When a feature is complete
    and its release checks pass (lint, typecheck, unit/DB tests, the full browser suite, production build, gate spec
    and deployment check; security, tenant isolation and data integrity reviewed; no unresolved new regression),
    fast-forward the Production branch to the verified Preview commit without asking again, then verify the
    Production deployment record and report it. Stop and report instead when a check fails or a blocker remains.
  - Code that depends on an unapplied migration ships only if it works safely without it; document the limitation
    and never call the feature operational until the migration is applied and verified.
  - Still explicit owner approval, each time, for: remote migrations or database changes (never applied just
    because code is ready), environment variables or secrets, domains, account/role changes, anything
    destructive, force-pushes or history rewrites. Approval for one operation never covers another.
- **Commits** end with the session's co-author trailer. Don't open a PR unless asked.
- **Dates:** use `DateInput` (`src/components/ui/date-input.tsx`) for every date field and
  `isOperationalDate` on the server.
- **Checks before a push:**
  - `npm run lint`, `npx tsc --noEmit`
  - `npx vitest run` (unit, DB and storage tests; needs the local stack)
  - `npx playwright test` (needs the dev server)
  - `npm run build`
  - The gate spec against a production build (SETUP §5).
- **Local stack:** Postgres on 54322 (`/var/lib/tlt-pg/data`), then `scripts/dev-stack/stack.sh up`, then
  `npx next dev -p 3000`. See SETUP §6.
