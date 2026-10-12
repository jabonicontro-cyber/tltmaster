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
| `docs/DEMO_TENANTS.md` | Demo tenants (presenter demo, prospect demos such as Prairie Lantern Freight): how they stay in sync with the product, the documented intentional differences, sample data, and the per-feature demo checklist. |
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
  Never use Tailwind `dark:` variants: dark mode is the person's choice (`data-theme`) and remaps the palette, while
  `dark:` follows the device and misfires (`tests/unit/theme-variants.test.ts`). `text-critical` gets a lighter red
  in dark mode for legibility; critical fills stay the fixed red.
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

## Demo tenants stay in sync with the product (permanent requirement, owner 2026-10-12)

- **One application.** Demo companies (`companies.is_demo`; presenter and prospect demos) run the same code, pages,
  components and database as every company. Never build a separate demo version of a page or component; a demo
  differs only through tenant data, permissions and the short list of intentional differences in
  `docs/DEMO_TENANTS.md` §2 (enforced by `tests/unit/demo-parity.test.ts`: any new `isDemo` / `is_demo` / `demo_kind`
  branch must be added there with its reason).
- **Demo compatibility is part of the definition of done** for every feature and UI change, without a separate
  request. In each plan and report: (1) does it apply to demos (default yes when it can run on fictional data);
  (2) does it need sample data — add it to the demo seed **and** to the refresh
  (`src/server/demo/prairie-lantern*.ts`, and `seed.ts` for the presenter demo) so existing demos get it via
  **Refresh demo data**; (3) its dependencies (migrations, env vars, services) and its demo-safe fallback;
  (4) tests showing it works in a demo (`tests/e2e/demo-parity.spec.ts` covers navigation and page loads; add
  feature-specific checks); (5) any intentional difference, reported and documented.
- **Safety first, always:** fictional records only; nothing real is sent, dispatched, paid or exported from a demo
  (simulate it, as quote emails and invitations already do); tenant isolation and RLS unchanged; never grant extra
  permissions to make a feature look functional; keep demo labels where users must know data or actions are
  simulated.
- A feature that depends on an unapplied hosted migration shows its normal "not available yet" state in demos too;
  never call it operational there until the migration is applied and verified.
- **Every demo mode, not just the owner (owner 2026-10-12, permanent).** Demo modes are the role previews
  (`src/lib/platform/preview.ts`: Owner, Dispatcher, Dispatcher who also drives, Office, Driver, Mechanic) in every demo
  company, plus any role or demo added later. A feature is **not done** until, in each mode whose role can use it, the
  page opens with that role's permissions and shows realistic sample data that exercises the real feature (lists,
  counts, dashboards, statuses, at least one edge case) — never an empty page, a placeholder or a demo-only imitation.
- **Existing demos get it on release.** Sample data goes in a shared, idempotent helper used by the presenter seed, the
  prospect seed **and** Refresh (`src/server/demo/samples.ts`), so live demos receive new features without being
  recreated. Refresh must never duplicate records, delete accounts, remove or change demo owners, or touch a real
  company (`is_demo` only). Required migrations still go through the owner's deployment step (DEPLOYMENT §2a).
- **Proof per feature:** `tests/e2e/demo-parity.spec.ts` (every mode: navigation, pages load, the feature's page has
  data) and `tests/db/demo-samples.test.ts` (samples created in a demo, refused for real companies, idempotent). Every
  plan and report states the demo modes affected, the sample data added, how existing demos receive it, and the tests.

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
