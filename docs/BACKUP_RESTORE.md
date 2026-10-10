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

At least once before go-live and then twice a year: restore the latest dump into a
scratch Supabase project, run the verification steps above, write down how long it
took, then delete the scratch project.
