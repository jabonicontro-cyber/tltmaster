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

## 2. Intentional differences (the complete list)

Each is enforced by `tests/unit/demo-parity.test.ts`: adding any other `isDemo` / `is_demo` / `demo_kind` branch to
`src/` fails the test until it is added here with its reason.

| Where | Difference | Why |
| --- | --- | --- |
| `src/server/auth.ts` | Reads `is_demo` into `access.isDemo`; role previews only in demos, only narrowing. | Marks the tenant; lets a presenter show other roles without granting anything. |
| `src/components/layout/app-shell.tsx`, `src/app/(app)/layout.tsx`, `src/app/(app)/demo-actions.ts` | Demo bar ("fictional data · nothing is sent"), role preview, presentation mode. | Users must know the data is fictional; screenshots and live demos. |
| `src/server/data/profile.ts`, `src/app/(app)/layout.tsx`, `src/app/(app)/driver/page.tsx` | The platform presenter is shown as the fictional persona (Daniel Mitchell) in the presenter demo. | Never show the presenter's real name inside a demo. |
| `src/app/(app)/quotes/actions.ts` | Quote emails are always previews, never sent. | Demos never send anything. |
| `src/app/(app)/settings/actions.ts` | Inviting users is refused. | Demos never send email; prospect owners are added by the operator (DEPLOYMENT §3c). |
| `src/app/admin/actions.ts`, `src/app/admin/demo/page.tsx` | Platform tools to create, refresh and retire prospect demos. | Operator tooling, not part of the tenant's app. |
| Database: `public.comm_seed_demo_samples()` (migration `20261108000100`) | Adds fictional sample Communications content (a "Dispatch desk" channel with pinned sample instructions); refused for real companies; never adds platform operators as members. Called by the seed and Refresh. | Communications needs content to look alive; fictional people cannot post without logins, so samples are system notes marked "Sample". |

Everything else (Communications, Dispatch, Maintenance, Fleet, Employees, Reports, Billing previews, …) behaves
exactly as for a real company. Features that cannot act for real anyway (e.g. invoices are previews, Smart Dispatch
only proposes) need no demo branch.

## 3. Checklist for every new feature or UI change

1. **Applies to demos?** Yes by default when it can run on fictional data. If not, document the exception in §2.
2. **Sample data?** If the feature needs records to look alive, add them to the seed **and** the refresh, so new and
   existing demos both get them. Use only invented names, 555-01xx numbers, `.example` addresses; no VINs, plates,
   DOT/MC numbers or real businesses.
3. **Dependencies?** Name migrations, env vars and services. Without them the feature shows its normal "not
   available yet" state in demos too.
4. **Safety:** nothing real leaves a demo — email, SMS, push, dispatch to a real driver, payment, accounting export
   or third-party call is simulated or refused (follow quote emails and invitations). No extra permissions to make a
   feature appear functional. Tenant isolation and RLS unchanged.
5. **Tests:** `tests/e2e/demo-parity.spec.ts` checks every navigation page loads in a demo with the same navigation as
   a standard company; add a feature-specific check when the feature has demo-relevant behaviour.
6. **Report** any intentional difference in the release summary.

## 4. Known gaps (to close as features are touched)

- Communications samples are system notes in one channel (no fictional people chatting: they would need logins).
  A prospect owner added with `demo-owner` joins the channel at once (if the samples exist; otherwise at the next
  **Refresh demo data**). Sample notes expire after
  14 days like all message content; Refresh adds them again. Needs migration `20261108000100`; until then the seed and
  Refresh skip the samples.
- The presenter demo gets no Communications samples: its presenter is a platform operator, who is never added to
  sample conversations.
- Refresh exists for Prairie Lantern Freight; a new prospect demo needs its own seed and refresh (or a shared one).
- No scheduler: refresh is a button (`/admin/demo`), not a nightly job.
