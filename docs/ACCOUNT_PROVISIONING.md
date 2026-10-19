# Account provisioning and first sign-in

Username sign-ins for people without a company email (drivers, mechanics, shop and office staff) and for customer-portal
contacts. Migration `20261120001200_account_provisioning.sql` (rollback in `supabase/rollbacks/`, destructive for setup
state). Status: **implemented and locally tested; not applied to any hosted database** (owner step, runbook
`docs/runbooks/2026-10-14-hosted-db.md` §14 Phase B).

## 1. How it works

1. **Create.** Staff fill in the person (employees: People → **Add with Username Sign-in**, or **Create Username Sign-in**
   on a person's page; customers: Customer Portal → Customer Access → **Create a Customer Sign-in**), check the review
   step, and press **Create Sign-in**.
   - Employees: role presets Driver / Mechanic / Dispatcher / Office employee fill the role and job title; the role
     (Settings → Roles) decides access. Bases, an optional own email and phone, and an on/off status.
   - Customers: one customer, an existing contact or a new one (an existing contact with the same email or name is
     reused; no duplicates), optional email.
   - **Username:** filled in automatically from the name with one the server confirmed is free (`sam.oneil`, then
     `sam.oneil2` …); staff can type their own at any time, and **Suggest one** goes back to automatic. Every value is
     checked for availability as it changes and again by the database on create.
2. **Reserve and create.** The server reserves the username (`account_provision_begin`, unique, idempotent per request
   key so a double click or retry never makes a second account), creates the Auth user at the internal address
   `<username>@users.mytaviron.com` (never a mailbox) with a generated temporary password, and attaches it
   (`account_provision_attach`, which checks the address matches the reservation).
3. **Access.** Employees get a membership with the chosen role (`add_company_member`); customers get a portal account
   for exactly one customer (`portal_create_login`). A portal sign-in never becomes a membership and an employee sign-in
   never becomes a portal account.
4. **Issue.** `account_setup_issue` records that setup is required: a SHA-256 fingerprint of the stored password hash
   (a hash of a hash; reveals nothing), an expiry (print/copy 7 days, emailed link 24 hours) and the method.
5. **Hand over** (the panel shows the temporary password only in memory, hidden until **Show**, hidden again after 60 s):
   - **Print Sign-in Sheet:** one page with the website, username, temporary password (optional) and simple steps.
   - **Copy Without Password**, or **Copy With Password…** after an explicit warning.
   - **Send Setup Link:** only when email sending is configured (not in preview mode, never in a demo) and the person
     has an email. It sends a one-time link, never a password; the result says only "accepted for delivery by the email
     service (reference …)" or the failure — delivery to an inbox is never claimed.
6. **First sign-in.** The person signs in with the username and the temporary password (main sign-in page, or their
   company's portal sign-in). Until they choose their own password the database gives them **no company and no portal**
   (`current_company_id()` and `portal_me` refuse while setup is pending) and every page sends them to `/welcome`.
   `account_setup_complete` accepts only when the stored password hash changed and the temporary sign-in has not
   expired; then other sessions are signed out and the person lands on their page: driver → My Day (`/driver`),
   mechanic → Maintenance, dispatcher → Dispatch, office/owner → Command Center, customer → their portal.

## 2. Managing sign-ins

On a person's page (employees) or in the Customer Sign-ins list (portal): status (waiting for first sign-in, temporary
password expired, active, turned off), last sign-in, and:
- **Reissue Sign-in Sheet / Reset Password:** a new temporary password replaces the old one at once; setup starts again.
- **Email Setup Link** (when available).
- **Turn Off Sign-in:** employees lose company access (`set_user_access`); customers lose portal access
  (`portal_revoke`). When the sign-in has no access anywhere else, it is also blocked in Auth so open sessions stop
  refreshing. Records, requests and history are kept. **Turn On** undoes it (portal sign-ins start over with a new
  temporary password).
- **Security history:** created, issued, reissued, delivered/printed/copied, completed, turned off/on, blocked.

Nobody can see or retrieve a person's own password. Staff never reset their own sign-in here, an email-based account,
an account that also has access elsewhere (another company, another portal, or the platform team), or — unless they
are an owner — an owner's sign-in.

## 3. Security and privacy rules

- Temporary passwords exist only in the server response to the staff member who issued them and in their browser memory;
  never stored, logged, audited or sent to analytics. The database holds a fingerprint of the hash only.
- The Auth admin key is used only on the server (`src/server/accounts.ts`), and only after a permission-checked database
  call with the caller's own session confirmed the action.
- Permissions: employees need `users.manage` (and `employees.edit` to create the person record); portal sign-ins need
  `customers.edit`. Checked on the server and again in each database function, scoped to the caller's company.
- Sign-in errors are generic ("Username or password is incorrect."). "This sign-in is turned off" is shown only after
  the password matched.
- **Shared computers:** the sign-in pages offer "This is a shared computer"; the session cookies then end with the
  browser (`src/lib/shared-device.ts`). Completing first-time setup signs out every other session.
- Drivers and customers are not required to use two-step verification; company policy and platform rules for MFA are
  unchanged.
- Demo companies never create, reset or email sign-ins (docs/DEMO_TENANTS.md §2); role previews and the Testing Lab
  show those experiences instead.

## 4. Before the migration is applied

Pages and actions work without it: creating a sign-in reports "needs the database update 20261120001200", the
Customer Access tab shows that notice, `/welcome` says first-time setup is not available, and nothing else changes.

## 5. Tests

- DB `tests/db/account-provisioning.test.ts` (7): reservation, gate and completion by fingerprint, duplicates and
  validation, request-key reuse, authorization and demo refusal, self/email/cross-company/shared accounts, expiry and
  reissue, Auth block rules, portal isolation (one customer, no duplicate contact, no membership, other companies refused).
- `tests/db/tenancy.test.ts`: the new `SECURITY DEFINER` functions are on the reviewed list.
- Unit `tests/unit/accounts.test.ts`: temporary passwords, username generation, landing pages, password rules, copied
  text, shared-computer cookies.
- e2e `tests/e2e/account-provisioning.spec.ts` (driver end to end on a phone, shared computer, setup enforced, temporary
  password stops working, turned off; taken username; no access without `users.manage`) and
  `tests/e2e/portal-provisioning.spec.ts` (customer end to end, portal only, turned off and on).

## 6. Owner steps

1. Apply `20261120001200` with Phase B (runbook §14), after the code that contains these pages is in Production.
2. To email setup links: configure the app's email provider (`EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM`, live
   mode; docs/SETUP.md) — otherwise staff print or copy. The app sends the message itself with a one-time recovery
   token verified at `/auth/confirm`; no Supabase email template change is needed.
