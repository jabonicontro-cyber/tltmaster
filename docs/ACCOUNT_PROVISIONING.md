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

## 7. Signing in without typing: QR code, then face or fingerprint (DS1, 2026-11-09)

Owner decision (master plan §12 DS1): QR first, then Face ID. Migrations `20261120017000_driver_qr_sign_in.sql` and
`20261120017100_signin_qr_money_rule.sql` (rollbacks in `supabase/rollbacks/`, both tested: applied, rolled back,
applied again). Status: **implemented and tested
locally; not applied to any hosted database; QR not verified live; passkeys not tested against a real passkey server.**

**QR code (Fleet → Drivers → a driver → Phone sign-in → Show sign-in QR code).**
- Who: `users.manage` (the permission that creates and resets sign-ins). Checked by the server action and again by
  `signin_qr_issue`.
- For whom: the driver record's own sign-in, only when it is an **active driver** membership of this company and a
  **username** sign-in with no access anywhere else (the same `account_issue_allowed` rule as Reset Password). Owners,
  office, dispatchers (also those who drive), mechanics, email sign-ins, platform administrators, people with another
  company or a customer portal, a turned-off or blocked sign-in, an expired first sign-in sheet and oneself are refused.
- **Money rule (owner SEC4, 2026-11-09):** two-step verification will be required for anyone who can see or change
  money, so a QR code is refused for a sign-in whose role holds a money permission in any company: every `billing.*`
  and `pricing.*` permission, `payroll.manage`, `employees.compensation`, `accounting.view`, `maintenance.costs`,
  `audit.view` (`private.is_money_permission`, the same list as `MONEY_PERMISSIONS` in `src/lib/permissions.ts`; a DB
  test checks they agree). Checked when the code is shown and again when it is used. When an owner gives the driver
  role a money permission, the driver's page says QR sign-in is off for drivers and why.
- The code: 32 random bytes (base64url) made on the app server; the database stores only its SHA-256, the company, the
  driver record and the sign-in. It works **once, for 10 minutes**; a new code replaces the driver's open one; closing
  the window cancels it. Rate limits: 5 per driver in 10 minutes, 30 per person per hour.
- The phone: the code holds `<site>/auth/qr#t=<token>`. The token is in the fragment, which browsers never send to a
  server (not in logs, proxies or referrers). `/auth/qr` reads it, removes it from the address bar and history, and
  posts it once to `/auth/qr/redeem` (same origin only). The server redeems it with the service role
  (`signin_qr_redeem`: row lock, single use, expiry, every rule checked again), then makes a real Supabase session for
  that sign-in (Auth admin `generateLink` magic link, verified on the server at once and never sent anywhere) and
  writes the httpOnly session cookies. The phone opens My Day. `/auth/qr` is reachable without early access (a
  brand-new phone has none); a valid code made by the office is the proof. Invented codes are limited per network
  address (8 in 15 minutes); rescanning a used or expired code does not count (drivers often share a depot address).
- The office window shows the QR code, a countdown and, within 3 seconds, "Signed in on the phone".
- Audit (`audit_events` + `security_events`, shown in the person's Security history): shown, used, expired, refused,
  cancelled, failed. Never the token or its hash.
- A first sign-in sheet that is still waiting: the QR code signs the phone in, and the person is then asked to choose
  their own password as before (the setup rule is unchanged). Two-step verification, when enrolled or required, is
  still asked for.
- Never during a Taviron support visit (the button is replaced by an explanation; refused by the server action, the
  function and a `z_no_support_visit` trigger on the table): a code is a way in only the company's own people hand out. Demo companies show a labelled sample code that
  holds plain text and signs nothing in; the database refuses real codes there (DEMO_TENANTS §2).

**Face or fingerprint (passkeys, Supabase Auth's passkey API).**
- After signing in on a phone that has face or fingerprint unlock, My Day offers "Sign in with your face or fingerprint
  next time" (**Set it up** / **Not now**, remembered on that phone for 30 days).
- Who may: only an **active driver** sign-in (every active membership is a driver one) that holds **no money
  permission**, has no customer portal account and is not in a demo company. **Refused for the Taviron team** (Admin and
  Support): their two-step rule stays the authenticator app. One database rule, `public.my_passkey_refusal()`
  (`20261120017100`), decides: My Day offers it only when the rule allows; the server asks it before the challenge and
  again before the passkey is stored, and after a passkey sign-in (a person whose role changed since is signed out of
  that session at once and told to use their password). When the database cannot answer, it is refused (fails closed).
- The sign-in page then shows **Sign in with face or fingerprint** (a discoverable passkey: no username to type).
- The session cookie stays httpOnly: the server asks Supabase Auth for the challenge and checks the answer
  (`auth.passkey.startRegistration/verifyRegistration`, `startAuthentication/verifyAuthentication`,
  `src/app/(auth)/passkey-actions.ts`); the browser only runs the WebAuthn ceremony (`src/lib/passkeys.ts`).
- Lost or new phone: on the driver's page the office sees on how many phones it is set up and **Remove (lost or new
  phone)** removes them all (`auth.admin.passkey`, after `signin_passkey_check`; audited). During a support visit this
  becomes a request an owner approves (`signin.passkeys_remove`). Username and password keep working.
- Whether passkeys are offered is asked from the auth server itself (a challenge request, remembered 10 minutes per
  server; `PASSKEYS=off` hides them regardless). Without passkeys every button for them is hidden.
- **The local auth server (GoTrue v2.180.0 in `scripts/dev-stack/stack.sh`) has no passkey API** (`/passkeys/*` answers
  404), so passkey registration and sign-in were **not tested end to end**; the conversions are unit-tested and the
  hidden state is tested in the browser.

**Owner steps.**
1. Apply `20261120017000` and `20261120017100` together (they ship with the code through the normal migration
   workflow; both additive, no destructive statement). Before them, the button answers "QR sign-in needs the database
   update 20261120017000", and without `017100` face or fingerprint setup and sign-in are refused (fails closed).
2. Passkeys: in Supabase, Authentication → turn on passkeys (WebAuthn) and set the relying party to the site's address:
   RP ID `tltmaster.vercel.app` (the host name only) and allowed origin `https://tltmaster.vercel.app` (add the custom
   domain too once it is used; a passkey belongs to one address, so moving to a new domain means drivers set it up again
   once). Then sign in on a phone, set it up from My Day, sign out and use **Sign in with face or fingerprint**.
3. While the early-access gate is on, a phone that signed out needs the site password or a new QR code before it can
   reach the sign-in page (the gate is unchanged); signed-in phones stay signed in for 30 days of use.

**Tests.** DB `tests/db/signin-qr.test.ts` (12; the money rule: the database and app lists agree, every money
permission refuses a code, a code is refused when used after drivers got a money permission, passkeys refused for
other roles, inactive drivers, people who are an owner elsewhere, the Taviron team, money permissions and demos; single use, expiry, replace and cancel, re-checked when used, permission
and other company refused, owners/office/email/elsewhere/platform admin/self refused, demo and support visit refused,
rate limit, no app-user access to redeem or the table, passkey checks and audit); `tests/db/tenancy.test.ts` (reviewed
definer list); unit `tests/unit/signin-qr.test.ts`, `tests/unit/passkeys.test.ts`, `tests/unit/support-requests.test.ts`,
`tests/unit/site-access.test.ts`; e2e `tests/e2e/signin-qr.spec.ts` (office shows a code, a phone opens it and lands on
My Day, the window says so, reuse and closed codes refused, no QR without `users.manage`, demo sample stores nothing,
invented codes limited, no passkey buttons without passkeys) and `tests/e2e/gate.spec.ts` (with the gate on: `/auth/qr`
reachable without early access and holds no data; a brand-new phone is signed in once by a code).
