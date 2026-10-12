# Release checklist

A short list to run through before a release is called done. It does not replace
the tests; it covers what the tests cannot decide. Tick each item in the
handoff notes (`docs/SESSION_HANDOFF.md`) for the release.

## 1. Code and tests (local)

- [ ] `npm run lint` and `npx tsc --noEmit` are clean.
- [ ] `npx vitest run` passes (unit, DB and storage). Note any skipped tests and why.
- [ ] `npx playwright test` passes against the dev server.
- [ ] `npm run build` succeeds, and the gate spec passes against the production build (SETUP §5).
- [ ] New `SECURITY DEFINER` functions pin `search_path = ''` and are in the reviewed list in `tests/db/tenancy.test.ts`; new business tables have `company_id` and RLS.

## 1a. Demo tenants (docs/DEMO_TENANTS.md)

- [ ] Each new feature or UI change is available in demo companies, or its exception is documented in DEMO_TENANTS §2.
- [ ] `tests/unit/demo-parity.test.ts` and `tests/e2e/demo-parity.spec.ts` pass (same navigation and working pages in
      a demo; invitations refused; nothing sent).
- [ ] New sample data needed by the feature is in the demo seed and in **Refresh demo data**, so existing demos get it.
- [ ] Demo actions cannot reach real customers, email, payments or exports.
- [ ] The report names any intentional difference between the standard app and the demo.

## 2. Database

- [ ] New migrations are new files — no applied migration was edited.
- [ ] The dev database was backed up (`pg_dump -Fc` into `/var/lib/tlt-backups/`) before applying them.
- [ ] The whole migration chain applies cleanly to an empty database.
- [ ] The migrations to apply on staging are listed in `docs/DEPLOYMENT.md` §2a, in order. Applying them is the owner's action, on the intended project only.

## 3. Public website

- [ ] Every feature described on the website is in `src/lib/site/capabilities.ts` under `AVAILABLE`, with the app pages that show it (`tests/unit/site-capabilities.test.ts` checks the pages exist).
- [ ] Anything not built, not verified or waiting on a business decision is under `PLANNED` ("Not yet") — never described as available.
- [ ] No invented customers, testimonials, logos, metrics, prices, phone numbers, addresses or company history.
- [ ] Screenshots show the demo company with fictional data, and say so.
- [ ] The early-access gate stays on and search indexing stays off unless the owner has decided otherwise (`PUBLIC_SITE`, `robots`).

## 4. Safety

- [ ] Nothing sends real email, issues invoices, exports to accounting or takes payments without the owner's explicit setup; the demo company never sends anything.
- [ ] Suggestions (Smart Dispatch, invoice drafts) never commit anything on their own.
- [ ] No secrets in the code, the docs or the commit history.

## 5. After pushing

- [ ] The GitHub deployment for the commit reports success (`curl https://api.github.com/repos/jabonicontro-cyber/tltmaster/deployments?sha=<commit>` and its statuses).
- [ ] Staging is checked in a browser by someone who can reach it — say plainly when it was not.
- [ ] Production is not changed without the owner's approval.
