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
| `src/app/(app)/quotes/actions.ts` | Quote emails are always previews, never sent. | Demos never send anything. |
| `src/app/(app)/settings/actions.ts` | Inviting users is refused. | Demos never send email; prospect owners are added by the operator (DEPLOYMENT §3c). |
| `src/app/admin/actions.ts`, `src/app/admin/demo/page.tsx` | Platform tools to create, refresh and retire prospect demos. | Operator tooling, not part of the tenant's app. |
| Database: `public.comm_seed_demo_samples()` (migration `20261108000100`) | Adds fictional sample Communications content (a "Dispatch desk" channel with pinned sample instructions); refused for real companies; never adds platform operators as members. Called by the seed and Refresh. | Communications needs content to look alive; fictional people cannot post without logins, so samples are system notes marked "Sample". |
| Database: `public.dismiss_demo_welcome()`, `user_preferences` key `demo_welcome` (migration `20261109000100`) | Remembers that a person saw the welcome in a demo company; refused for real companies. Until the migration is applied, an http-only browser cookie (`taviron-demo-welcome`) remembers it on that browser. | The welcome should appear once per person, not on every sign-in or device. |
| Database: `private.comm_user_name` (migration `20261108000100`) | In a demo company, Communications names a login linked to an employee record by that record's name. | The presenter appears as the persona (Daniel Mitchell), never under their own name, as everywhere else in the demo. |

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
| Command Center | Orders and loads for recent days, today and tomorrow (Refresh fills empty days) | ✓ | ✓ | ✓ | ✓ | — (opens My Day) | ✓ |
| Orders, Dispatch, Smart Dispatch | Same loads; trucks, trailers and drivers | ✓ | ✓ | ✓ | ✓ | — | — |
| My Day | The demo owner's own driver record (linked employee), qualifications and a load today or tomorrow | ✓ | — | ✓ | — | ✓ | — |
| Delivery tickets | Tickets on delivered loads | ✓ | ✓ | ✓ | ✓ | — | — |
| Quotes | A draft quote copied from a sample order line | ✓ | ✓ | ✓ | ✓ | — | — |
| Fleet and documents | Registrations (one expiring), an inspection due, an expired trailer registration | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| Maintenance | A safety-critical brake work order on an idle truck, tire and electrical work orders, oil and annual inspection schedules | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| Time off | An approved vacation, a pending personal day, and a pending request for the viewer's own employee record | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Communications | "Dispatch desk" channel with pinned sample notes; an operation workspace for a scheduled order (needs `20261108000100`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Employees | Fictional employees with departments and qualifications | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| Explain this plan (AI, docs/AI.md) | None needed (uses the planning-day samples). Blocked in demos unless `AI_IN_DEMOS=on` — the page shows the normal "not available" state; Company setup shows the gate | ✓ (state) | ✓ (state) | ✓ (state) | ✓ (state) | — | — |

Proof: `tests/e2e/demo-parity.spec.ts` opens every navigation page in every demo mode, for the presenter demo and for
a prospect demo after **Refresh demo data**, and checks Maintenance, Time off, Quotes, Communications and My Day show
sample data; `tests/db/demo-samples.test.ts` checks the samples, that a second run adds nothing and keeps every demo
user, and that a real company is refused.
