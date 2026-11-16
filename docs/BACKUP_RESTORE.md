# Backups and restoring

Complete this before entering real business data.

## What needs protecting

Everything lives in the Supabase PostgreSQL database (customers, prices, quotes,
history, audit log, user profiles). Quote PDFs are regenerated from the stored
revision data, so there are no separate files to back up yet. Secrets live in the
hosting provider's environment settings — keep a copy in the company password
manager.

## Automatic backups (Supabase)

- **Pro plan or higher** includes daily backups (retained 7 days on Pro).
- **Point-in-time recovery (PITR)** is an add-on that restores to any second within
  the retention window. Recommended once the system is used daily.
- Free-plan projects have no automatic backups and pause when idle — do not run the
  business on the free plan.

Check **Database → Backups** in the Supabase dashboard regularly.

## Independent weekly backup (recommended in addition)

Keep a copy outside Supabase. From a trusted computer with PostgreSQL client tools:

```bash
# Connection string: Supabase → Project Settings → Database → Connection string (session pooler)
export DB_URL='postgresql://postgres.<ref>:<password>@<host>:5432/postgres'

pg_dump "$DB_URL" --format=custom --no-owner --no-privileges \
  --schema=public --schema=private \
  --file="topline-$(date +%F).dump"

# Auth users (logins) are in the auth schema:
pg_dump "$DB_URL" --format=custom --data-only --schema=auth --table=auth.users --table=auth.identities \
  --file="topline-auth-$(date +%F).dump"
```

Store the files encrypted (e.g. in an encrypted company drive) and keep at least
4 weekly copies. The dump contains customer contact details — treat it as
confidential.

## Restoring

### From Supabase backups / PITR
Dashboard → **Database → Backups** → choose the backup or point in time → Restore.
The project is unavailable during the restore. Afterwards, sign in and spot-check
recent quotes.

### From a `pg_dump` file into a new project
1. Create a new Supabase project.
2. Apply migrations: `npx supabase link --project-ref <new-ref> && npx supabase db push`.
3. Restore data only (schema comes from the migrations):
   ```bash
   pg_restore --data-only --no-owner --disable-triggers -d "$NEW_DB_URL" topline-auth-YYYY-MM-DD.dump
   pg_restore --data-only --no-owner --disable-triggers -d "$NEW_DB_URL" topline-YYYY-MM-DD.dump
   ```
   `--disable-triggers` is required so the immutability and audit triggers do not
   block restoring historical rows (it needs a role allowed to disable triggers; use
   the `postgres` connection).
4. Point `NEXT_PUBLIC_SUPABASE_URL` / keys at the new project and redeploy.
5. Verify: sign in, open several customers and sent quotes, download a PDF, and
   check **Settings → Audit log**.

## Test the restore

At least once before go-live and then twice a year: run the restore drill below, write down how long it took, and
keep the result in the drill record.

## Restore drill (master plan LR4; written 2026-11-14)

Proves that the encrypted backup the "Database migrations (Production)" workflow makes can be opened and holds the
data. **Running it waits on the owner** (the Supabase Pro upgrade, docs/LAUNCH.md step 1, and the backup passphrase,
which only the owner has). Until the first drill passes, backups are assumed, not proven.

**What the backup is** (`.github/workflows/db-migrate.yml`): a full `pg_dump -Fc --no-owner --no-privileges` of the
hosted database made with PostgreSQL 17 client tools, encrypted with the `BACKUP_PASSPHRASE` secret (AES-256, gpg),
uploaded as the artifact `production-db-backup-<run id>` (file `backup-<UTC time>.dump.gpg`) and **kept 14 days**.
It is made only when a release has migrations to apply, not on a schedule. The newest one recorded is
`backup-20261112T041308Z.dump.gpg` (run 43153292716, SESSION_HANDOFF 2026-11-12); it expires about 2026-11-26.
Photos and attachments in Storage are not in it.

**Where to restore it:** a local PostgreSQL 17 on a trusted computer (the owner's, or one the owner chooses). The copy
never leaves that machine. Once Top Line's real data is in Production (from 2026-11-24), the backup holds real
customer and driver details: treat the decrypted file as confidential, never copy it into a shared folder, a chat or
Claude's sandbox, and delete it when the drill is done. Restoring into the `taviron-preview` Supabase project is
**not** recommended once real data exists: Preview deployments would then serve a copy of Top Line's records and the
owner's sign-ins, which defeats the reason that project exists (docs/LAUNCH.md step 2). If the owner wants the cloud
route anyway, ask Claude for the steps for that case; they are not written here because the project then has to be
emptied and set up again afterwards.

**Do it before 2026-11-24 if possible:** the 2026-11-12 backup was made before Top Line's import (from 2026-11-24), so
a first drill with it should carry no real customer records.

### Steps (about 30 minutes)

Needs: PostgreSQL **17** (server and client tools; an older `pg_restore` cannot read a dump made by version 17),
`gpg`, the GitHub CLI `gh` (or a browser), and this repository (for `scripts/dev-stack/roles.sql` and the count query
below).

1. **Download the backup.** GitHub → the repository → Actions → "Database migrations (Production)" → the newest run
   that applied migrations → Artifacts → `production-db-backup-<run id>`. Or from a terminal:
   ```bash
   gh run list --workflow db-migrate.yml --limit 10        # pick the id of a run that applied migrations
   gh run download <run id> --name production-db-backup-<run id> --dir restore-drill
   cd restore-drill && ls                                  # backup-YYYYMMDDTHHMMSSZ.dump.gpg
   ```
   If no artifact is left (older than 14 days and no release with migrations since), make a fresh copy with the weekly
   backup commands above instead, or wait for the next release with migrations.
2. **Decrypt it** (gpg asks for the passphrase; type it, never put it on the command line):
   ```bash
   gpg --pinentry-mode loopback --output backup.dump --decrypt backup-YYYYMMDDTHHMMSSZ.dump.gpg
   pg_restore --list backup.dump | grep -c "TABLE DATA"    # how many tables hold data in the backup
   ```
3. **Restore it into an empty database** (here a local server on port 5432; adjust host, port and user):
   ```bash
   export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres
   createdb restore_drill
   psql -d restore_drill -f ../scripts/dev-stack/roles.sql   # Supabase's roles (anon, authenticated, ...)
   time pg_restore --no-owner --no-privileges -d restore_drill backup.dump > restore.log 2>&1
   grep "error:" restore.log
   ```
   Errors are expected for Supabase's own parts that a plain PostgreSQL does not have (schemas `auth` and `extensions`
   "already exists"; extensions, functions and event triggers for graphql, vault, realtime, storage, net and pgsodium).
   **An error naming a table or function in `public` or `private` means the drill failed.**
4. **Check the data.** Save the count query below as `counts.sql` and run it:
   ```bash
   psql -d restore_drill -f counts.sql
   ```
   - Every row shows a count, and the newest dates are close to the backup time in the file name (UTC).
   - Compare with Production for the same moment: in the Supabase SQL editor run the same query with
     `where created_at <= '<backup time>'` added to each line (`occurred_at` for history entries). The counts should
     match (records are archived rather than deleted, so differences are rare; write down any).
   - Spot-check the newest orders: `select order_number, status, created_at from public.orders order by created_at desc limit 5;`
     and open the same orders in the app: their tickets and invoice should be the ones the copy holds.
   - Sign-ins: `select count(*) from auth.users;` matches the number of sign-ins in Production, and your own account is
     there: `select email, last_sign_in_at from auth.users where email = '<your sign-in email>';`. Signing in to the app
     against the copy is not part of this drill: it needs the app and an Auth server pointed at the copy, and the local
     stack (`scripts/dev-stack/stack.sh`, another Auth version) is not made for a production copy.
5. **Clean up:** `dropdb restore_drill`, then delete `backup.dump`, the `.gpg` file and `restore.log` (`shred -u` where
   available).
6. **Record it** in the table below and tell Claude, who updates docs/LAUNCH.md and master plan LR4.

```sql
-- counts.sql: what the restored copy holds (counts and dates only; no names or details).
select 'companies' as records, count(*) as rows, max(created_at) as newest from public.companies
union all select 'people with sign-ins (auth.users)', count(*), max(created_at) from auth.users
union all select 'memberships', count(*), max(created_at) from public.company_memberships
union all select 'customers', count(*), max(created_at) from public.customers
union all select 'orders', count(*), max(created_at) from public.orders
union all select 'loads', count(*), max(created_at) from public.order_loads
union all select 'delivery tickets', count(*), max(created_at) from public.delivery_tickets
union all select 'invoices', count(*), max(created_at) from public.invoices
union all select 'payments', count(*), max(created_at) from public.customer_payments
union all select 'trucks', count(*), max(created_at) from public.trucks
union all select 'drivers', count(*), max(created_at) from public.drivers
union all select 'history entries (audit_events)', count(*), max(occurred_at) from public.audit_events
order by 1;
```

**How these commands were checked (2026-11-14):** in Claude's sandbox against the local development database (test
data only, PostgreSQL 16): `pg_dump -Fc --no-owner --no-privileges`, encrypted and decrypted with gpg as the workflow
does, restored into an empty database after `roles.sql`. The only errors were the two expected "already exists" ones,
and the count query gave the same result on the copy as on the original. **Not checked:** a real workflow backup
(PostgreSQL 17, Supabase's own schemas, the owner's passphrase).

### Drill record

| Date | Backup file | Restored where | Time taken | Result (counts match? errors outside Supabase's own parts?) | Done by |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | Not run yet (waits on the owner). | — |
