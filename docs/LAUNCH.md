# Launch plan: Top Line testing from 2026-12-01, live in January 2027

Owner decisions 2026-11-05 (master plan §11b). This page is the one checklist: what the owner does in which dashboard,
what Claude builds, and the status of each. Statuses: **To do**, **Waiting on owner**, **Built (off)**, **Done**, **Verified**.

## Dates

| When | What |
| --- | --- |
| By Fri 2026-11-21 | Owner steps 1 to 5 below done (hosting, separate preview database, sign-in email, monitoring accounts, Top Line spreadsheets sent). |
| Mon 2026-11-24 to Fri 2026-11-28 | Claude imports Top Line's data (preview first, owner approves); drivers install the app on their phones and sign in once. |
| Mon 2026-12-01 | Top Line runs real daily work in Taviron, side by side with its current method. |
| Mon 2026-12-15 | Taviron only, if the first two weeks had no blocking problem. |
| By Wed 2026-12-31 | Lawyer returns terms and privacy; January switch-on checklist (LR6) prepared, everything still off. |
| January 2027 | Switch-ons one at a time, each verified with a test company; site public with prices; first outside customers. |

## Owner steps (in order)

### 1. Hosting on paid plans (approved 2026-11-05, about $45/month) · Waiting on owner

1. **Supabase:** dashboard → the project the live site uses (taviron-staging today) → Settings → Billing → upgrade to
   **Pro**. Then Database → Backups: confirm daily backups are listed. This project becomes Production; nothing moves.
2. **Vercel:** dashboard → Settings → Billing → upgrade to **Pro** (the free plan forbids business use).
3. Tell Claude when both are done; Claude records it here and runs the restore drill (§4).

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

### 3. Sign-in emails (invitations, password resets) · Waiting on owner (DEPLOYMENT §1, S4)

Resend's domain `mytaviron.com` is already verified.
1. Supabase (Production project) → Authentication → **SMTP Settings** → enable custom SMTP: host `smtp.resend.com`,
   port `465`, user `resend`, password = a Resend API key, sender `no-reply@mytaviron.com`, name `Taviron`.
2. Authentication → **URL Configuration**: Site URL = the address Top Line will use; add it plus `/auth/callback` and
   `/auth/confirm` to Redirect URLs.
3. Send yourself a password reset from the sign-in page and confirm it arrives.

### 4. Monitoring (approved 2026-11-05: free tiers) · Done 2026-11-09 (owner: UptimeRobot monitor shows Up; Sentry project created, `SENTRY_DSN` set for Production, redeployed)

- **UptimeRobot** (free): New monitor → HTTP(s) → URL `https://<your address>/api/health` → every 5 minutes → alert
  contact = your email and phone app. The check answers 200 when the app, sign-in and database answer, 503 otherwise, and
  returns no data. It works with the early-access gate on.
- **Sentry** (free): create a project of type *Next.js*, copy its **DSN**, then Vercel → Environment Variables →
  Production only → `SENTRY_DSN` = the DSN → redeploy. Server errors are then reported with emails, long numbers,
  tokens, query strings and record ids removed; nothing is sent without the variable. Sentry → Alerts: email on new issues.

### 5. Top Line's data (LR3) · Waiting on owner

Send the spreadsheets in this chat (Excel or CSV, any layout): customers (with job sites and contacts), trucks, trailers,
drivers (with CDL and medical card dates), employees and their roles, standing rates or price lists, and open orders.
Claude maps them through the company import, shows a preview, and saves nothing until you approve it.

### 6. Legal review before January (LR5) · Packet ready for the lawyer (`docs/LEGAL_REVIEW_PACKET.md`, 2026-11-06)

Top Line is the owner's own company and stays on its free beta arrangement, so December needs no new agreement. Claude
prepared the review packet for the lawyer (`docs/LEGAL_REVIEW_PACKET.md`, 28 open questions at the end): every data practice and promise the product and site make (what is stored,
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

## What Claude builds before December (master plan §12)

| Item | Status |
| --- | --- |
| Health check `/api/health` and Sentry reporting (LR4) | Built (off until `SENTRY_DSN`) |
| Detention proposals from recorded waits, off until set per customer (DT1) | Built |
| Freight loads, rest of MK2: accessorial charges on the invoice, rate confirmation file, proof of delivery per stop, brokers as customers | To do |
| Import ready for Top Line's files (LR3) | Customers, job sites, trucks, trailers, drivers with CDL and medical dates: built. Rates and open orders: built to match the files once they arrive |
| Demo data, small fixes, catalog honesty (UX13, UX15, LR2) | Built (portal ticket photos for demos still open) |
| Truck-day dispatching (UX11), by January | Built (slice 1): plan, assign, release, truck-hours for review; adding hours to the invoice is slice 2 |

## Restore drill (after step 1)

On a copy, never over Production: download the latest encrypted backup from GitHub → Actions → "Database migrations
(Production)" artifacts (or Supabase → Database → Backups), restore it into the `taviron-preview` project or a local
database, open the app against it and check a recent order, ticket and invoice are there. Record the date and time taken
here. Until the first drill passes, backups are assumed, not proven.
