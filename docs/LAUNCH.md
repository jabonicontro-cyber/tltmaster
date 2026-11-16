# Launch plan: Top Line testing from 2026-12-01, live in January 2027

Owner decisions 2026-11-05 (master plan §11b). This page is the one checklist: what the owner does in which dashboard,
what Claude builds, and the status of each. Statuses: **To do**, **Waiting on owner**, **Built (off)**, **Done**, **Verified**.

**Address (owner decision 2026-11-14):** Top Line uses **https://www.mytaviron.com** from December 1. It already serves
Production; `mytaviron.com` redirects to it, and `tltmaster.vercel.app` keeps working. Related pages: docs/INCIDENTS.md
(what to do when something breaks), docs/TOPLINE_DRIVER_ROLLOUT.md (drivers' phones, Nov 24 to 28),
docs/SWITCH_ON.md (January switch-ons), docs/BACKUP_RESTORE.md (restore drill).

## Dates

| When | What |
| --- | --- |
| By Fri 2026-11-21 | Owner steps 1 to 5 below done (hosting, separate preview database, sign-in email, monitoring accounts, Top Line spreadsheets sent). |
| Mon 2026-11-24 to Fri 2026-11-28 | Claude imports Top Line's data (preview first, owner approves); drivers install the app on their phones and sign in once (docs/TOPLINE_DRIVER_ROLLOUT.md). App emails switched on and checked (step 8; owner chose "before Dec 1"). |
| Mon 2026-12-01 | Top Line runs real daily work in Taviron, side by side with its current method. |
| Mon 2026-12-15 | Taviron only, if the first two weeks had no blocking problem. |
| By Wed 2026-12-31 | Lawyer returns terms and privacy. The January switch-on checklist (LR6) is prepared (docs/SWITCH_ON.md, 2026-11-14); everything on it stays off. |
| January 2027 | Switch-ons one at a time, each verified with a test company; site public with prices; first outside customers. |

## Owner steps (in order)

### 1. Hosting on paid plans (approved 2026-11-05, about $45/month) · Waiting on owner

1. **Supabase:** dashboard → the project the live site uses (taviron-staging today) → Settings → Billing → upgrade to
   **Pro**. Then Database → Backups: confirm daily backups are listed. This project becomes Production; nothing moves.
2. **Vercel:** dashboard → Settings → Billing → upgrade to **Pro** (the free plan forbids business use).
3. Tell Claude when both are done; Claude records it here, and the restore drill follows (end of this page).

### 2. A separate database for Preview (test pushes never touch Top Line's data) · Waiting on owner

1. Supabase → **New project** → name `taviron-preview`, free plan, same region as Production. Save the database password
   in your password manager.
2. Project Settings → API: copy the Project URL, the anon key and the service-role key.
3. Vercel → the project → Settings → Environment Variables → for the **Preview** environment only, set
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` to the new project's values
   (Production keeps its own). Never paste the keys anywhere else.
4. Apply the migrations to the new project once from your computer: `npx supabase link --project-ref <preview ref>` then
   `npx supabase db push` (DEPLOYMENT §2a), then re-link your usual project. Claude never runs `db push` against a hosted
   database.

### 3. Sign-in emails and the address (invitations, password resets, QR codes) · Waiting on owner (DEPLOYMENT §1, S4)

Resend's domain `mytaviron.com` is already verified.
1. Supabase (Production project) → Authentication → **SMTP Settings** → enable custom SMTP: host `smtp.resend.com`,
   port `465`, user `resend`, password = a Resend API key, sender `no-reply@mytaviron.com`, name `Taviron`.
2. Authentication → **URL Configuration**:
   - **Site URL** = `https://www.mytaviron.com`
   - **Redirect URLs**: add `https://www.mytaviron.com/auth/callback`, `https://www.mytaviron.com/auth/confirm` and
     `https://www.mytaviron.com/auth/confirm**`. Keep the `https://tltmaster.vercel.app/...` entries that are already
     there, so that address keeps working as an extra one.
3. Vercel → the project → Settings → Environment Variables → **Production** → `APP_BASE_URL` =
   `https://www.mytaviron.com` → Save → Deployments → the current Production deployment → **Redeploy**. Taviron builds
   the links in its emails and the drivers' sign-in QR codes from this address, so drivers' phones are signed in on
   the same address they add to their home screen.
4. Send yourself a password reset from the sign-in page and confirm it arrives and its link opens
   `www.mytaviron.com`.

### 4. Monitoring (approved 2026-11-05: free tiers) · Done 2026-11-09 (owner: UptimeRobot monitor shows Up; Sentry project created, `SENTRY_DSN` set for Production, redeployed)

- **UptimeRobot** (free): New monitor → HTTP(s) → URL `https://<your address>/api/health` → every 5 minutes → alert
  contact = your email and phone app. The check answers 200 when the app, sign-in and database answer, 503 otherwise, and
  returns no data. It works with the early-access gate on.
- **Sentry** (free): create a project of type *Next.js*, copy its **DSN**, then Vercel → Environment Variables →
  Production only → `SENTRY_DSN` = the DSN → redeploy. Server errors are then reported with emails, long numbers,
  tokens, query strings and record ids removed; nothing is sent without the variable. Sentry → Alerts: email on new issues.
- **When an alert arrives:** follow docs/INCIDENTS.md (first checks, rollback, telling Top Line, the record to keep).

### 5. Top Line's data (LR3) · Waiting on owner

Send the spreadsheets in this chat (Excel or CSV, any layout): customers (with job sites and contacts), trucks, trailers,
drivers (with CDL and medical card dates), employees and their roles, standing rates or price lists, and open orders.
Claude maps them through the company import, shows a preview, and saves nothing until you approve it.

### 6. Legal review before January (LR5) · Packet ready for the lawyer (`docs/LEGAL_REVIEW_PACKET.md`, 2026-11-06, refreshed 2026-11-14)

Top Line is the owner's own company and stays on its free beta arrangement, so December needs no new agreement. Claude
prepared the review packet for the lawyer (`docs/LEGAL_REVIEW_PACKET.md`, open questions at the end; §13 lists what changed since 2026-11-06): every data practice and promise the product and site make (what is stored,
who sees it, retention, sub-processors such as Supabase, Vercel, Resend and, once switched on, OpenAI, Twilio,
QuickBooks and Sentry), with where each lives in the code. The lawyer's final terms and privacy replace the drafts
before outside customers in January.

### 7. Sign-in protection in the Supabase dashboard (security review 2026-11-06, M3) · Partly done 2026-11-09

Done by the owner 2026-11-09 (taviron-staging, free plan): rate limits confirmed (sign-ups and sign-ins 30 / 5 min,
token verifications 30 / 5 min); minimum password length 10. **Waits for the Supabase Pro upgrade (step 1):** leaked
password protection (saving it on Free gave an error) and the session time-box and inactivity timeout below
(greyed out on Free, owner 2026-11-09). Do these three right after step 1.

The app now limits wrong passwords per sign-in (8 in 15 minutes) for sign-ins made through Taviron, but someone with a
stolen password could try authenticator codes against Supabase directly. Only the dashboard settings below stop that.
In the Supabase project (Authentication):

1. **Rate limits:** lower "Token verifications" and "Sign-ups and sign-ins" to the smallest values that still fit
   normal use (for example 30 per 5 minutes per address), and confirm "MFA verifications" (if shown) is limited.
2. **Password security:** turn on **Leaked password protection** (Pro plan; checks new passwords against known
   breaches) and set the minimum length to 10.
3. **Sessions:** set **Time-box user sessions** to 30 days (matches the app's 30-day sign-in cookie) and
   **Inactivity timeout** to 14 days.

Tell Claude when done; nothing else needs changing in the code.

### 8. App emails: quotes, invoices, website leads, daily summary · Waiting on owner (owner chose "before Dec 1")

Today the app records every email as a preview and sends nothing (`EMAIL_PROVIDER` is not `resend`). These steps make
it send through Resend, first to a test inbox only, then for real. Sign-in emails are step 3 (Supabase), not this.

1. **Resend** (resend.com, the account where `mytaviron.com` is verified) → **API Keys** → **Create API Key** → name it
   `Taviron app`, permission **Sending access**, domain `mytaviron.com` → Add. Copy the key (it starts with `re_`); it
   is shown only once. Never paste it in a chat.
2. **Vercel** → the project → Settings → Environment Variables → environment **Production** only. Add each:
   1. `EMAIL_PROVIDER` = `resend`
   2. `RESEND_API_KEY` = the key from step 1 (tick **Sensitive**)
   3. `EMAIL_FROM` = the sender people see, on the verified domain, for example `Taviron <no-reply@mytaviron.com>`
   4. `EMAIL_REPLY_TO` = the inbox that should get replies. Today this one address receives replies to every quote and
      invoice email **and** to the confirmation sent to website visitors, so use an inbox you read (see the note below).
   5. `LEAD_NOTIFY_EMAIL` = the inbox that gets "new lead" notices from the website form
   6. `EMAIL_TEST_RECIPIENT` = your own inbox (**test mode**: every email goes there with `[TEST]` in the subject, and
      quotes stay drafts)

   Then Deployments → the current Production deployment → **Redeploy** (a change applies only after a redeploy).
3. **Check test mode:** sign in to Top Line → **Settings → Email** shows **Mode: Test** and the From address.
   - Open a quote for a test customer (or one whose contact is your own address) → **Email quote** → it arrives in your
     test inbox with `[TEST]`, and the quote is not marked sent.
   - Optional: email an invoice the same way; it also goes to the test inbox only.
   - A malformed value shows on Settings → Email as "Email sending is off: … is malformed", and nothing is sent until
     it is fixed.
4. **Demos never send:** open a demo company and select **Email quote** on a quote: it says "Demo company: emails are shown, never sent."
   The variables above do not change that (`src/app/(app)/quotes/actions.ts`, `src/app/(app)/billing/invoices/actions.ts`).
5. **Go live:** Vercel → delete `EMAIL_TEST_RECIPIENT` → Redeploy → Settings → Email shows **Mode: Live**. Email one
   quote to your own address as the customer contact and confirm it arrives without `[TEST]` and is marked sent.
6. Tell Claude the date; Claude records it here and in the legal packet (Resend becomes **On**).

**To switch it off again:** set `EMAIL_PROVIDER` = `preview` (or delete it) → Redeploy. Nothing is sent; every attempt
is recorded as a preview.

**Note on replies (for January):** `EMAIL_REPLY_TO` is one address for every company. That is fine while Top Line is
the only company; before outside customers send quotes or invoices, each company needs its own reply address (a code
change, listed in docs/SWITCH_ON.md).

## What Claude builds before December (master plan §12)

| Item | Status |
| --- | --- |
| Health check `/api/health` and Sentry reporting (LR4) | Done 2026-11-09 (`SENTRY_DSN` set for Production; UptimeRobot shows Up) |
| Incident runbook (LR4) | Done 2026-11-14: docs/INCIDENTS.md |
| Restore drill procedure (LR4) | Written 2026-11-14 (docs/BACKUP_RESTORE.md, "Restore drill"); running it waits on the owner |
| Drivers' phones (DS1, LR1) | Help article "Set up Taviron on your phone" and docs/TOPLINE_DRIVER_ROLLOUT.md (2026-11-14); not yet tried on real iPhone and Android phones (owner, Nov 24 to 28) |
| January switch-on checklist (LR6) | Prepared 2026-11-14: docs/SWITCH_ON.md (everything stays off) |
| Freight scope after MK2 (§9 Q28) | Proposal for the owner: docs/FREIGHT_SCOPE_PROPOSAL.md (2026-11-14) |
| Detention proposals from recorded waits, off until set per customer (DT1) | Built |
| Freight loads, rest of MK2 | Built: extra charges on the invoice (2026-11-06); rate confirmation, bills of lading and proof of delivery on the order or a stop, and brokers as customers (2026-11-09). Left: the driver adding proof of delivery from the phone at a stop |
| Import ready for Top Line's files (LR3) | Customers, job sites, trucks, trailers, drivers with CDL and medical dates: built. Rates and open orders: built to match the files once they arrive |
| Demo data, small fixes, catalog honesty (UX13, UX15, LR2) | Built (portal ticket photos for demos still open) |
| Truck-day dispatching (UX11), by January | Built: slice 1 (plan, assign, release, truck-hours for review) and slice 2 (**Add to order** puts the reviewed hours on the order as one hourly line, migration `20261120008700`). Open: different start times per truck in one step |

## Restore drill (after step 1) · Waiting on owner

On a copy, never over Production. The exact commands, the checks (row counts against Production, a recent order with
its tickets and invoice, the sign-ins) and the record to keep are in docs/BACKUP_RESTORE.md, "Restore drill". Best done
before 2026-11-24 with the backup of 2026-11-12 (made before Top Line's data arrives; it expires about 2026-11-26).
Until the first drill passes, backups are assumed, not proven.
