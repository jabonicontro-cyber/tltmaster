# Setup

## 1. Environment variables

Copy `.env.example` to `.env.local` (local) or set them in your host's
dashboard (production). Never commit real values.

| Variable | Required | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Public key; all access is still limited by Row Level Security |
| `SUPABASE_SERVICE_ROLE_KEY` | for invitations and `scripts/create-owner.mjs` | **Server only.** Never prefix with `NEXT_PUBLIC_` |
| `APP_BASE_URL` | yes in production | e.g. `https://ops.example.com`; used in reset / invitation links |
| `EMAIL_PROVIDER` | no (default `preview`) | `preview` or `resend` |
| `RESEND_API_KEY`, `EMAIL_FROM` | for real email | `EMAIL_FROM` must be on a domain verified in Resend |
| `EMAIL_REPLY_TO` | optional | Replies from customers go here |
| `EMAIL_TEST_RECIPIENT` | optional | Test mode: every email goes here, subject gets `[TEST]`, quotes are **not** marked sent |
| `TEST_DATABASE_URL` | for `npm run test:db` | Superuser URL of a **local/disposable** database |

## 2. Supabase project (hosted)

1. Create a project at supabase.com (choose a US region). Note the database password.
2. Apply migrations from this repository:
   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push            # applies supabase/migrations
   ```
   Do **not** load `seed.sql` into production unless you want the sample data for training.
3. **Authentication → Sign In / Providers**: keep Email enabled, **turn off "Allow new users
   to sign up"** and **turn on "Confirm email"**. Public sign-up must stay off: new customers
   sign up only through the app's `/signup` page with an early-access code (the server creates
   the account with the admin API), and everyone else is invited by an owner.
4. **Authentication → URL Configuration**: Site URL = `APP_BASE_URL` (the email templates build
   their links from it); add `<APP_BASE_URL>/auth/confirm` and `<APP_BASE_URL>/auth/confirm**`
   to Redirect URLs.
5. **Authentication → Email Templates**: replace *Confirm signup*, *Invite user* and *Reset
   password* with `supabase/templates/confirmation.html`, `invite.html` and `recovery.html`
   (they link to `/auth/confirm`, which works with server-side sessions; the confirmation
   link continues to `/onboarding`). Suggested subjects: "Confirm your email", "You have been
   invited to Top Line Trucking Manager", "Reset your password".
6. **Authentication → SMTP**: Supabase's built-in mailer is rate-limited and meant for testing.
   Configure custom SMTP (Resend provides SMTP credentials) before go-live so verification,
   invitation and password-reset emails are delivered reliably. Check the Auth email rate
   limit (Authentication → Rate Limits) fits the number of invitations you expect.
6a. **Server secret for sign-up and invitations.** `SUPABASE_SERVICE_ROLE_KEY` must be set in the
   app host's server environment (never as a `NEXT_PUBLIC_` variable). Without it `/signup`
   says sign-up is not available and invitations fail. Rate limiting reads the client address
   from `X-Forwarded-For` as set by the host (Vercel sets it); behind a different proxy make
   sure the proxy overwrites that header.
6b. **Early-access codes** (operators, from a trusted machine with the service-role key):
   ```bash
   node --env-file=.env.local scripts/early-access.mjs create --label "Ridgeway Aggregates" --uses 1 --days 14
   node --env-file=.env.local scripts/early-access.mjs list
   node --env-file=.env.local scripts/early-access.mjs revoke <code-id> --reason "Sent to the wrong person"
   ```
   The code (`TLT-XXXXX-XXXXX-XXXXX-XXXXX`) is printed once and stored only as a hash; send it
   to the customer directly. The customer opens `/signup`, enters the code, company name, name,
   email and password, confirms the email, and lands on `/onboarding`, where "Create my company"
   creates the company with them as Owner. Failed code attempts are limited (10 per address and
   5 per email per 15 minutes; 5 per signed-in user). A signed-in user can create another company with a
   new code on `/onboarding` (owners find it in the account menu → "Create a company").
7. Create the first owner from a trusted machine (the company slug defaults to
   `top-line-trucking`, which the migrations create):
   ```bash
   node --env-file=.env.local scripts/create-owner.mjs owner@yourcompany.com "Owner Name"
   ```
   To add another company (operators only, SQL editor or psql as `postgres`):
   ```sql
   select private.create_company('Example Hauling LLC', 'example-hauling');
   ```
   then run `create-owner.mjs owner@example.com "Name" example-hauling`. Each
   company's data, settings, numbering and permissions are isolated (see
   docs/ARCHITECTURE.md → Companies).
8. Sign in, open **Settings → Company** and enter the company address, phone and email that
   should appear on quotes. Confirm the default sales-tax rate with your accountant.
9. **Storage (ticket photos).** Supabase Storage is part of every hosted project. The
   migration `20261019000100_ticket_photos.sql` creates the private bucket
   `ticket-photos` (5 MB, JPEG/PNG/WebP) and its policies when the `storage` schema exists.
   Verify after `db push`:
   ```sql
   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'ticket-photos';
   select policyname, cmd from pg_policies where schemaname = 'storage' and policyname like 'ticket_photos%';
   ```
   Expect `public = false` and two policies (INSERT, SELECT). If storage was enabled after the
   migration ran, run `select private.setup_ticket_photo_storage();` as `postgres`.
   **Never** make the bucket public in the dashboard. No new app environment variables are
   needed: uploads and signed links use the signed-in user's own token.
10. **Abandoned uploads.** Schedule (daily) from a trusted machine or job:
   ```bash
   node --env-file=.env.local scripts/cleanup-ticket-photos.mjs --hours=24
   ```
   It uses `SUPABASE_SERVICE_ROLE_KEY` (keep it out of the app host's public env and out of
   git), removes photos never attached to a ticket within 24 hours and objects without a
   record, then marks the records discarded. `--dry-run` only counts.
11. **Retention and backups.** Attached photos are kept as long as their ticket (they are
   evidence, also after corrections and voids); there is no automatic deletion of attached
   photos. Supabase database backups (and `pg_dump`) **do not include storage files** — the
   records survive a restore but the images would not. Before go-live, decide on a storage
   backup (for example a periodic copy of the bucket with the Storage API or S3-compatible
   access to another private location) and test a restore.

## 3. Email for quotes (Resend)

1. Create a Resend account, add your domain, and add the DNS records it gives you (SPF/DKIM).
2. Create an API key with "sending" access.
3. First set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` **and**
   `EMAIL_TEST_RECIPIENT=<your inbox>`. Send a quote: it arrives at your inbox only, and the
   quote stays a draft.
4. When satisfied, remove `EMAIL_TEST_RECIPIENT` and redeploy. **Settings → Email** shows the
   current mode.

Behavior guarantees (covered by tests):
- A quote is marked **Sent** only after the provider accepted the message.
- Every attempt — sent, failed, preview, test — is recorded with recipients, time, revision
  and the SHA-256 of the attached PDF.
- A failed or test send releases the revision so the draft stays editable.
- One automatic retry on temporary errors, with an idempotency key so the customer never gets
  duplicates.

### Upgrading an existing database to company separation

Migrations `20261011000100_mechanic_role.sql` and
`20261011000200_company_separation.sql` convert a single-company database:
every existing row is assigned to Top Line Trucking, roles move from `profiles`
to `company_memberships`, and a verification block aborts the whole migration
if any row count, ownership or quote total does not match. Before applying to a
database with real data: take a backup (docs/BACKUP_RESTORE.md), apply to a
staging copy first, deploy the app version from the same commit (the old app
version reads `profiles.role`, which the migration removes), then sign in and
check customers, quotes and orders.

### Applying new migrations without losing local data

`supabase db reset` rebuilds the database from scratch. To keep your local
records and only apply migrations added since your last update (for example
`20261012000100_order_management.sql`, `20261013000100_fleet_registry.sql`,
`20261014000100_dispatch_assignments.sql`, `20261015000100_delivery_tickets.sql` and
`20261016000100_billing_readiness.sql`, `20261017000100_command_center.sql` and
`20261018000100_driver_portal.sql`,
`20261019000100_ticket_photos.sql` and `20261020000100_company_onboarding.sql`):

```bash
npx supabase migration up      # Supabase CLI
# or, for the no-Docker stack:
psql "postgres://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -1 \
  -f supabase/migrations/20261012000100_order_management.sql
# then the same for 20261013000100_fleet_registry.sql, 20261014000100_dispatch_assignments.sql
# 20261015000100_delivery_tickets.sql, 20261016000100_billing_readiness.sql,
# 20261017000100_command_center.sql, 20261018000100_driver_portal.sql and
# 20261019000100_ticket_photos.sql and 20261020000100_company_onboarding.sql, in that order
```

The order-management migration only adds columns, rules and functions; existing
orders are kept (order date and confirmation time are filled from their creation
time) and it aborts if any quote-linked order's totals would differ from its
accepted revision. The fleet-registry migration only adds new tables, functions,
permissions and policies; it does not change existing rows. The dispatch migration
is additive too; it enables the `btree_gist` extension (available on Supabase and
in PostgreSQL contrib). The delivery-tickets migration is additive as well. The billing-readiness migration
adds tables, views, functions and permissions, adds the `billing` key to the
allowed document sequences and creates a `B-` batch sequence for every company; it
changes no existing rows. The command-center migration adds a permission, a
table and functions, and replaces the `audit_read_orders` policy with a narrower
one (billing entries in order history need `billing.view`); no rows change. The
driver-portal migration adds permissions, the `field_reports` table and
functions, moves the ticket insert into a shared helper (same behavior) and
replaces some command center functions; no rows change. The ticket-photos migration
adds the `ticket_attachments` table and functions, replaces `driver_submit_ticket` (photos),
and creates the storage bucket and policies if storage is installed; no rows change.
The company-onboarding migration adds three private tables (early-access codes, redemptions,
attempts) and functions, and replaces `add_company_member` and `set_user_access` with versions
that let only owners grant or remove the Owner role; no rows change.

**Driver accounts.** Invite the person with the *Driver* role (Settings → Users),
then link the account on their driver record (Fleet → Drivers → Edit → *Linked
user account*). Until it is linked, *My Day* says so and shows nothing. Ticket photos
need the storage bucket (step 9 of the hosted setup, or `DEV_STORAGE=1` locally).

## 4. Deploying (Vercel or any Node host)

- Framework preset: Next.js. Node 22.
- Set the environment variables above for Production (and Preview, pointing at a separate
  Supabase project — never production data).
- The PDF route runs on the Node.js runtime; no extra setup.
- Every response carries `X-Robots-Tag: noindex` and `robots.txt` disallows everything.

## 5. Automated tests

```bash
npm run lint && npm run typecheck && npm test        # no database needed
npm run test:db                                      # needs a migrated local database
```

Browser tests need the app running against a **local** backend (the setup script refuses
remote URLs unless `E2E_ALLOW_REMOTE=1`):

```bash
set -a; source .env.local; set +a
npm run dev &                 # or npm run build && npm start
npm run test:e2e              # creates e2e users with known passwords in the local DB
```

## 6. Local backend without Docker

**With file storage (ticket photos):** `DEV_STORAGE=1 scripts/dev-stack/stack.sh up` also
builds the open-source Supabase Storage server (v1.45.0, the newest release that runs on
Node 22; needs `git` and `npm`; one-time build into `.dev-stack/storage-api`, or point
`STORAGE_API_DIR` at an existing build) and runs it with a local file backend
(`.dev-stack/storage-data`) behind the gateway at `/storage/v1`. On first start it creates
the `storage` schema; the stack then runs `private.setup_ticket_photo_storage()`. The
storage tests (`npx vitest run --project storage`) talk to this real server with real user
tokens and are skipped, with a message, when it is not running; the database photo tests
need the `storage` schema.

`scripts/dev-stack/stack.sh` runs Supabase Auth and PostgREST (downloaded from their GitHub
releases) against a PostgreSQL you provide on `127.0.0.1:54322`, with a small gateway on
`:54321` that behaves like the Supabase API. CI uses it for database tests.

**Email.** The stack also runs a development-only mail catcher (`scripts/dev-stack/mailbox.mjs`,
SMTP on `127.0.0.1:54325`). Supabase Auth requires email confirmation and sends verification,
invitation and reset emails with the repository templates to it; each message is saved as
JSON in `.dev-stack/mail/` (newest file last). Open the file and copy the `href` link into the
browser. Nothing leaves the machine. Public sign-up stays disabled, as on hosted projects.

### Two independent test companies (local only)

1. Start the stack and the app as in the README quick start (`npm run stack -- up`,
   `npm run stack -- env > .env.local`, `npm run dev`). `npm run stack -- db-reset` is for a
   **first-time** setup only (it rebuilds the database); on an existing database apply new
   migrations as described above instead. The seed gives you **Top Line Trucking** (sample data).
2. Create a second company with one account per role (the script refuses any non-local
   database or API URL and never prints the password):
   ```bash
   TEST_USER_PASSWORD='choose-a-10+-char-password' \
     node --env-file=.env.local scripts/create-test-company.mjs "Ridgeway Aggregates (test)" ridgeway
   ```
   It creates `owner@ridgeway.test`, `office@ridgeway.test`, `dispatcher@ridgeway.test`,
   `mechanic@ridgeway.test` and `driver@ridgeway.test` (email confirmed, the driver linked to a
   driver record with valid qualifications), all with that password. Running it again changes
   nothing. Use another name and key for a third company.
3. Give Top Line accounts in the same way through the app: sign in as the Top Line owner
   (`create-owner.mjs`), Settings → Users → Invite user, then open the invitation link from
   `.dev-stack/mail/` and choose a password.
4. To try the real sign-up flow instead, create a code
   (`node --env-file=.env.local scripts/early-access.mjs create --label "Local test" --days 1`),
   open `http://localhost:3000/signup`, then follow the verification email in `.dev-stack/mail/`.
5. Check isolation: sign in as `dispatcher@ridgeway.test` in one browser profile and a Top Line
   user in another; each sees only its own company. Copy an order or ticket URL from one
   company into the other's browser: it shows "Not found". To test the company switcher,
   invite an existing account (for example `dispatcher@ridgeway.test`) from Top Line's
   Settings → Users: it is added to Top Line, and the account menu then lists both companies.
   What each role can open is listed in `tests/e2e/roles.spec.ts` (run it with
   `npx playwright test tests/e2e/roles.spec.ts`).
