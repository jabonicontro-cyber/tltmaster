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
3. **Authentication → Sign In / Providers**: keep Email enabled, **turn off "Allow new users to sign up"**.
   Users are invited by an owner.
4. **Authentication → URL Configuration**: Site URL = `APP_BASE_URL`; add
   `<APP_BASE_URL>/auth/confirm` to Redirect URLs.
5. **Authentication → Email Templates**: replace the *Reset password* and *Invite user*
   templates with `supabase/templates/recovery.html` and `invite.html`
   (they link to `/auth/confirm`, which works with server-side sessions).
6. **Authentication → SMTP**: Supabase's built-in mailer is rate-limited and meant for testing.
   Configure custom SMTP (Resend provides SMTP credentials) before go-live so password-reset
   emails are delivered reliably.
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
`20261018000100_driver_portal.sql` and
`20261019000100_ticket_photos.sql`):

```bash
npx supabase migration up      # Supabase CLI
# or, for the no-Docker stack:
psql "postgres://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -1 \
  -f supabase/migrations/20261012000100_order_management.sql
# then the same for 20261013000100_fleet_registry.sql, 20261014000100_dispatch_assignments.sql
# 20261015000100_delivery_tickets.sql, 20261016000100_billing_readiness.sql,
# 20261017000100_command_center.sql, 20261018000100_driver_portal.sql and
# 20261019000100_ticket_photos.sql, in that order
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
`:54321` that behaves like the Supabase API. CI uses it for database tests. Password-reset
emails are not delivered by this stack; use the Supabase CLI (which includes a test inbox)
to try that flow locally.
