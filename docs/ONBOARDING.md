# Company onboarding and data import

How a trucking company gets its workspace ready in Taviron, what exists today, and what comes next (master plan §12
B11). Imports and setup prepare the data that dispatch checks, Smart Dispatch and **Plan the day** rely on, so
missing data is always shown as missing.

## 1. What exists

| Step | Who | Where | Notes |
| --- | --- | --- | --- |
| Create the company | Taviron team | `/admin/onboarding` (platform owners only) | No users yet; never touches another company (IMPLEMENTATION_PLAN §5m). |
| Import customers, materials, trucks, drivers from CSV | Taviron team | `/admin/onboarding/[company]` | Header matching with manual mapping; values normalised; every row checked in the browser, on the server and in the database. Staging creates nothing; rows are *ready*, *possible duplicate* or *needs fixing*. **Approve** creates the chosen rows all at once or not at all. **Revert** removes only rows the batch created that are untouched and unused (others are kept and deactivated). Every step is audited in `private.platform_audit`. |
| Owner login | Taviron team | `scripts/create-owner.mjs` / invitation (DEPLOYMENT §3) | |
| Invite people and set roles | Company owner | Settings → Users | Server and database enforce roles. |
| **Company setup checklist** (new, 2026-10-13) | Company owner (`settings.manage`) | `/setup` | Read-only. Company profile, people and roles, customers, materials and standard rates, trucks and capacity, trailers (fleets with tractors), drivers and qualifications — each *done*, *incomplete* or *not started*, with counts of what is missing and a link to fix it. Built from the company's own data (RLS); if anything cannot be read, the page says so instead of showing an all-clear. Logic: `src/lib/onboarding/readiness.ts` (tested in `tests/unit/onboarding-readiness.test.ts`); data: `src/server/data/readiness.ts`. |

Demo companies: the checklist works the same way in every demo company for the Owner mode (other modes have no
`settings.manage`); it reflects the demo's fictional data and changes nothing.

## 2. Rules

- Never invent missing customer, driver, vehicle, load or financial information; never treat inferred values as
  confirmed. A suggestion (human or, later, AI) is labelled as a suggestion until a person confirms it.
- Imports never silently overwrite existing records; duplicates are shown and decided by a person.
- Reversal is promised only where it is safe (untouched, unused records); otherwise the record is deactivated and the
  limitation is stated before approval.
- Tenant isolation: platform imports run through `platform_*` functions that check the platform role and the target
  company; company users only ever see their own company.

## 3. Next steps (in order)

1. **Self-service CSV import for company administrators** using the same staging → review → approve → revert model,
   scoped to the administrator's own company. Needs company-scoped database functions (a migration the owner applies);
   until then imports stay with the Taviron team.
2. Contacts, job sites, customer rates and driver qualifications as import types; XLSX files.
3. AI-assisted mapping and error explanations through the shared AI platform (backlog B6) once a provider is approved —
   suggestions only, confirmed by a person.
4. A setup link from the Command Center while the checklist is incomplete.
