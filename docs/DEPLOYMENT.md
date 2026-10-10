# Deploying Taviron (staging / early access)

This puts Taviron on a real HTTPS address with the Early Access gate in front of it.
It uses two services that both have free tiers and need **accounts in your name**:

| Piece | Service | Free tier notes (verify current terms before relying on them) |
| --- | --- | --- |
| Web app (Next.js) | **Vercel** | Hobby plan: free, HTTPS on `*.vercel.app`, **personal / non-commercial use only**. Using it for a business (including a paid beta) needs the Pro plan (paid) — decide before customers use it. |
| Database, sign-in, file storage | **Supabase** | Free plan: 2 projects, small database and storage limits, projects **pause after a week without activity**, no automatic backups. The Pro plan (paid) adds daily backups. |

Nothing here costs money on the free tiers. Upgrading either plan is a paid decision for you.

Environments stay separate: your computer uses the local stack; this guide creates a
**staging** Supabase project and a **staging** Vercel project. A future production setup
repeats the same steps with new projects — never point staging at production data.

---

## 1. Supabase (staging database, sign-in and storage)

1. Sign in at supabase.com → **New project** → name `taviron-staging`, a strong database
   password (keep it in your password manager), a US region near your users.
2. **Project Settings → API**: note the *Project URL*, the *anon public* key and the
   *service_role* key (secret — server only).
3. Apply the database from this repository (from your computer, in the project folder):
   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push          # applies every file in supabase/migrations, in order
   ```
   Do **not** load `supabase/seed.sql` (sample data) into anything but a throwaway test.
   The migrations create an empty company named "Top Line Trucking" (historical); in
   **Table Editor → companies** you may rename or deactivate it.
4. Check storage: **SQL Editor** →
   ```sql
   select id, public from storage.buckets where id = 'ticket-photos';
   ```
   Expect one row with `public = false`. If it is missing, run
   `select private.setup_ticket_photo_storage();`.
5. **Authentication → Sign In / Providers**: Email on; **"Allow new users to sign up" off**;
   **"Confirm email" on**.
6. **Authentication → URL Configuration**: *Site URL* = your Vercel address from step 2.4
   (come back after deploying), *Redirect URLs* = `<address>/auth/confirm` and
   `<address>/auth/confirm**`.
7. **Authentication → Email Templates**: paste `supabase/templates/confirmation.html`,
   `invite.html` and `recovery.html` into *Confirm signup*, *Invite user* and *Reset
   password*.
8. **Authentication → SMTP**: the built-in sender only sends a few emails per hour and is
   meant for testing. For invitations to real people, configure SMTP (e.g. Resend, which has
   a free tier) — optional for a first look.

## 2. Vercel (the web address)

1. Sign in at vercel.com with GitHub → **Add New → Project** → import
   `jabonicontro-cyber/tltmaster`.
2. **Settings → Git → Production Branch**: set it to the branch you want staging to run
   (for now `claude/top-line-trucking-manager-vmw04i`). This is the *staging* project; a
   real production project later gets its own branch, database and settings.
3. **Settings → Environment Variables** (Environment: Production; also Preview if you use
   preview URLs). Names and purpose — values come from your own accounts:

   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon public key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key (**mark Sensitive**) |
   | `APP_BASE_URL` | `https://<your-project>.vercel.app` (or your domain later) |
   | `EARLY_ACCESS_GATE` | `on` |
   | `SITE_ACCESS_SECRET` | 32+ random characters — generate with `openssl rand -base64 32` (**Sensitive**) |
   | `EARLY_ACCESS_DAYS` | `30` (optional) |
   | `EMAIL_PROVIDER` | `preview` (quote emails are shown, not sent, until Resend is set up) |

   Without `SITE_ACCESS_SECRET` the app deliberately answers **503** to everything.
4. **Settings → Deployment Protection**: turn *Vercel Authentication* off for this project
   (otherwise visitors see a Vercel login before the Early Access page).
5. **Deploy**. Vercel gives you `https://<your-project>.vercel.app` with HTTPS.
6. Back in Supabase step 1.6, set the Site URL and redirect URLs to that address.
7. Check it from anywhere (no credentials needed):
   ```bash
   node scripts/check-deployment.mjs https://<your-project>.vercel.app
   ```

## 3. Let yourself (and testers) in

From your computer, with a `.env.staging` file containing only the staging
`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (never commit it):

```bash
# An early-access code for your own devices (phone, laptop): up to 5 devices, 30 days
node --env-file=.env.staging scripts/early-access.mjs create --purpose site --label "Owner devices" --uses 5 --days 30
```
The code is printed **once**. Open the address on your phone, enter the code, and you reach
the normal sign-in page.

You also need an account and a company (the gate never creates them):

- **Recommended:** create your company and owner directly —
  Supabase **SQL Editor**: `select private.create_company('Your Company LLC', 'your-company');`
  then on your computer:
  `node --env-file=.env.staging scripts/create-owner.mjs you@example.com "Your Name" your-company`
  (asks for a password). Sign in on the phone.
- **Or** use self-serve sign-up: create a *company* code
  (`create --label "Your company" --uses 1`), open `/signup` after the gate, and confirm the
  email (needs working Auth email, step 1.8).

**Testers:** give each group its own site code (`--purpose site --label "Pilot: Ridgeway"
--uses 10`), then invite their users from Settings → Users (invitation links work without
a code). List and revoke:
```bash
node --env-file=.env.staging scripts/early-access.mjs list
node --env-file=.env.staging scripts/early-access.mjs revoke <code-id> --reason "Pilot ended"
node --env-file=.env.staging scripts/early-access.mjs revoke-devices <code-id> --reason "Shared too widely"
```
**Rotate** a code: create a new one, send it, revoke the old one. Changing
`SITE_ACCESS_SECRET` in Vercel (and redeploying) signs every device out of early access
at once.

## 4. Custom domain (later)

1. Vercel → Project → **Settings → Domains** → add `app.yourdomain.com`.
2. At your domain registrar's DNS, add the record Vercel shows (for a subdomain usually
   `CNAME app → cname.vercel-dns.com`). Vercel issues the HTTPS certificate automatically.
3. Update `APP_BASE_URL` in Vercel and the Site URL / redirect URLs in Supabase to the new
   address, then redeploy. The gate stays on.

No domain is configured by this repository; buying one is your decision.

## 5. Updating and rolling back

- **App**: every push to the staging branch deploys. To undo, Vercel → Deployments → pick
  the previous one → **Promote / Instant Rollback**. The previous version must be compatible
  with the database (migrations are additive, so older app versions keep working).
- **Database**: migrations only move forward and are additive. Before `supabase db push`,
  take a backup: `pg_dump "<connection string from Supabase → Database>" -Fc -f before.dump`
  (on the free plan there are no automatic backups). To restore, see docs/BACKUP_RESTORE.md.
  Never edit an applied migration; fix forward with a new one.
- **Storage files** are not in database backups (see SETUP §2 step 11).

## 6. What the gate does (and does not)

- Every page, server action, API route and file route checks for early access **before**
  anything else; without it pages redirect to `/early-access` and everything else returns
  401. Exceptions: the Early Access page and Supabase Auth email links (`/auth/confirm`),
  which carry their own one-time tokens.
- A valid code gives this browser a signed, HttpOnly, Secure, SameSite=Lax cookie
  (`__Host-taviron-access`) tied to a database grant; it is re-checked every 5 minutes, so a
  revoked code or device loses access within 5 minutes. Wrong codes are limited to 10 per
  network address per 15 minutes.
- **Signed-in users pass the gate**: an account already means someone invited or approved
  them. Passing the gate never creates an account, a company, a membership or a permission.
- Codes are never stored (only SHA-256 hashes), never logged and never sent to the browser.
