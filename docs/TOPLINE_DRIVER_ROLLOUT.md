# Top Line drivers: phones ready by Friday, November 28

One page to print. Monday 2026-11-24 to Friday 2026-11-28, every Top Line driver signs in once on their own phone, so
that on Monday 2026-12-01 they open Taviron and see their loads. Address: **www.mytaviron.com**.
Driver help inside the app: Help → "Set up Taviron on your phone".

**Who does the office part:** a person who can manage sign-ins. By default that is the **owner** only (permission
`users.manage`; setting up a phone sign-in also needs `employees.edit`, which owners and office staff have).

## Before Monday (once)

- [ ] `APP_BASE_URL` is `https://www.mytaviron.com` in Vercel Production and the Supabase Site URL is the same
      (docs/LAUNCH.md step 3). The QR codes open this address.
- [ ] Top Line's drivers are imported (LAUNCH step 5) and each shows in **Fleet → Drivers** and in People.
- [ ] The driver role has no money permissions (Settings → Roles and permissions). Otherwise the driver page says
      "QR sign-in is off for drivers here" and drivers would need two-step verification.
- [ ] Try the whole thing first on one iPhone and one Android phone (yours, with one driver), and write down below
      what the home-screen icon did on each. Tell Claude: it decides what the drivers are told.

## What the office does, per driver (about 5 minutes)

1. **Fleet → Drivers** → the driver → **Set up phone sign-in** → follow the steps (role **Driver**) →
   **Print Sign-in Sheet**. Give the
   sheet to the driver: it holds their username and a temporary password. The temporary password stops working
   **7 days** after it is made, so do this the same week (an expired sheet is replaced with **Reissue Sign-in Sheet** on the driver's People
   page).
2. Back on the driver's page: **Show sign-in QR code**. Only the driver should see it; anyone who scans it is signed
   in as that driver. It works once, for 10 minutes. The window says **Signed in on the phone** when it worked.
3. Watch the driver do the steps below, then tick the checklist.
4. If something fails, the window or the phone says why in plain words; **Show a new code** makes a fresh one.

## What each driver does

1. Open the phone's **Camera**, point it at the code, tap the link. The phone opens **My Day**.
2. If asked, create your own password (only you know it) and select **Save My Password**. Keep the sheet somewhere
   safe until you have remembered it.
3. Put Taviron on the home screen:
   - **iPhone:** in Safari, **Share** → **Add to Home Screen** → **Add**.
   - **Android:** in Chrome, menu (three dots) → **Install app** or **Add to Home screen**.
4. Open Taviron from the new icon. It should show My Day.
5. Read the two reminders: use Taviron only when parked; keep the paper ticket for every load.

**If the icon opens a page that says "Taviron is open by invitation" or asks to sign in:** the icon has its own
sign-in, apart from the browser (known for iPhone; not yet tried on a real phone). Until the test before Monday says
otherwise, the driver uses Taviron from the browser where the code signed them in (Safari or Chrome), and the office
notes it below. Do not hand out the Early Access password.

**Location:** the first time a driver sends a ticket, the phone may ask about location. Allow saves the position once
with that ticket as proof of delivery; it is not tracking. No still sends the ticket.

**No signal:** open My Day once with signal each morning. Tickets (without photos), inspections and Arrived / Left
taps made without signal say "Saved on this phone, not sent yet" and send themselves later. Do not sign out while
something waits to send.

**Lost or new phone later:** the office shows a new code on the new phone. The username and password keep working.

## Checklist

| Driver | Phone (iPhone / Android) | Sheet printed | Code scanned, My Day opens | Own password saved | Icon on home screen opens My Day | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| | | [ ] | [ ] | [ ] | [ ] | |
| | | [ ] | [ ] | [ ] | [ ] | |
| | | [ ] | [ ] | [ ] | [ ] | |
| | | [ ] | [ ] | [ ] | [ ] | |
| | | [ ] | [ ] | [ ] | [ ] | |
| | | [ ] | [ ] | [ ] | [ ] | |
| | | [ ] | [ ] | [ ] | [ ] | |
| | | [ ] | [ ] | [ ] | [ ] | |
| | | [ ] | [ ] | [ ] | [ ] | |
| | | [ ] | [ ] | [ ] | [ ] | |

Test phones before Monday: iPhone icon result: ______________________ Android icon result: ______________________

Checked against the code on 2026-11-14 (`src/app/auth/qr`, `src/server/signin-qr.ts`, `src/server/people/driver-qr.ts`,
`src/components/accounts/phone-sign-in-qr.tsx`, `src/server/accounts.ts`, docs/COMPANION_APP.md). Not yet tried on a
real iPhone or Android phone.
