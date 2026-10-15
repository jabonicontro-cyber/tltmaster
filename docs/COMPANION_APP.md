# Taviron companion app

Tracked separately from the main platform (master plan §12 row B49). Last updated 2026-10-15 (site directions status added).

## 1. What existed before

No app. Drivers already had a mobile-first web page, **My Day** (`/driver`), inside the main application: assignments
with instructions, tickets with photos, delay and breakdown reports, maintenance notices, and access to
Communications and Time off through the normal menu. No manifest, service worker, native project or app-store
listing existed. The agreed scope (master plan §7) lists a "driver mobile app (future)": assignments,
acknowledgments, photos, digital tickets, documents, exceptions, PTO, inspections, announcements, messaging; paper
tickets stay supported.

## 2. Architecture and why

**An installable web app (PWA) served by the existing Next.js application**, not a separate product:

- One backend, one source of truth. Sign-in (Supabase Auth), company isolation (row-level security), permissions
  (`src/server/auth.ts` + database), validation and audit are exactly the ones the office uses. A driver's action
  from the phone runs the same server actions and database functions as anywhere else.
- No API keys or service credentials on the device: the phone holds only the user's session cookie, like the
  browser.
- Updates ship with every Taviron release; no store review.
- **Not a native app.** It is installed from the browser ("Add to Home Screen" on iPhone, "Install app" on
  Android). Section 7 covers what a store-published native build would need.

Files: `src/app/manifest.ts` (manifest), `public/app-icons/` (icons from the Taviron emblem), `public/sw.js`
(service worker), `src/app/offline/page.tsx`, `src/lib/companion.ts`, `src/components/companion/*`, the driver tab
bar in `src/components/layout/app-shell.tsx`, and the My Day additions in `src/app/(app)/driver/page.tsx`.

## 3. Scope: agreed items and their state

| Agreed item | State in the companion app |
| --- | --- |
| Assignments, schedule, load instructions | Working (My Day: today, earlier, later; instructions, directions, site contact) |
| Whether the site's directions were checked (B51) | Working once `20261115000200` is applied: "Not checked by the office yet" / "Last checked by the office …" under the directions; unverified safety or access directions, and overdue ones, show a red line on the load ("Confirm them with dispatch before relying on them"). The phone never shows who checked them |
| Dispatch updates (new load, changed date/time) | Working: in-app notices on My Day with **Got it** (20261114000500 triggers; Communications notifications) |
| Acknowledgments | **Got it** marks the notice read on that account. It is *not* proof the driver read or understood it, and the screen says dispatch still confirms what matters |
| Photos and digital tickets | Working (existing ticket form with photos; paper tickets supported) |
| Exceptions (delay, breakdown, equipment issue) | Working (existing field reports) |
| Maintenance notices (truck and the trailer it usually pulls) | Working |
| Messaging, announcements, critical alerts with acknowledgment | Working through Communications (same membership rules and acknowledgment audit); Messages tab when the login has `comms.message` |
| Presence (Available, Busy, Away, Busy – Active Delivery) | Working (Communications; active delivery is derived from the assignment, never set to Available automatically) |
| Time off (requests, balances) | Working (Time off tab; same approval chains and balance checks) |
| Documents, inspections (DVIR) | **Not built.** Inspections need the compliance scope (§9 Q12) |
| Push notifications to the lock screen | **Not built.** Needs owner approval and keys (section 7) |
| Native iOS / Android store apps | **Not built.** Needs owner decision and accounts (section 7) |

## 4. Safety, connectivity and stale data

- **Driving:** My Day says "Use Taviron only when you are parked. Nothing here needs an answer while you drive." The
  tab bar has no counters or badges, and nothing asks for an immediate reply. Notifications for drivers on an
  active delivery are already deferred by Communications (one catch-up afterwards).
- **Freshness:** My Day shows when its data was read ("Updated 7:41 AM"). After 5 minutes it says "This may be out of
  date … check with dispatch" with a Refresh button. When the phone goes offline it says "No connection". It reloads
  when the app comes back to the foreground or back online.
- **Offline:** not supported for data, by design. The service worker never stores company data. It only serves
  `/offline` when a page cannot load ("nothing is shown here … call dispatch"). Actions require a live server answer.
  Duplicate submits are already prevented by the existing forms (submission keys on tickets and reports).
- **Sessions:** an expired or revoked session sends the person to sign-in on the next request, as in the browser. A
  removed permission takes effect on the next request (every page checks on the server).

## 5. Security

- `/manifest.webmanifest`, `/sw.js`, `/offline` and the icons are reachable without signing in or early access
  (`src/proxy.ts`, `src/server/site-access.ts`). Browsers fetch the manifest without cookies. None of them contains
  company data (checked in `tests/e2e/gate.spec.ts`).
- Everything else keeps the gate and sign-in. Driver logins get the tab bar only; administrative pages still refuse
  them on the server.

## 6. Tests (2026-10-15)

- Unit: `tests/unit/companion.test.ts` (who gets the tab bar, tabs per permission, freshness states) and
  `tests/unit/site-access.test.ts` (exemptions).
- Browser, phone size 390×844 (Chromium), `tests/e2e/companion.spec.ts`:
  - The manifest, icons and service worker are served while signed out; `/driver` is not.
  - A driver gets the tabs, the freshness line, the parked-only notice and a real "New load" update from an
    assignment. **Got it** removes it, and going offline shows "No connection".
  - Office staff get no driver tabs.
  - The service worker controls the app, and `/offline` holds no company data.
- Offline fallback: `tests/unit/service-worker.test.ts` runs `public/sw.js` against stand-ins for the browser APIs. It
  checks that only the offline page and an icon are stored, that a failed page load returns the offline page, and that
  data, actions and POSTs are never handled or stored. A browser test can't prove this reliably here: in the full suite,
  Playwright's offline mode let the service worker's own page request through while blocking the page's CSS. The
  result was an unstyled live page, which can't happen on a real phone with no signal.
- Gate spec: the companion files are reachable with the gate on and carry no company data.
- **Not tested on a real iPhone or Android device**, and not on iOS Safari (Playwright runs Chromium here).

## 7. Owner decisions and dependencies

1. **Install it on your phone (no setup):** open the Taviron site in Safari on iPhone → Share → Add to Home Screen,
   or Chrome on Android → menu → Install app. Sign in as a driver to check My Day.
2. **Lock-screen push notifications (optional, needs approval):** Web Push needs a VAPID key pair as server-only
   environment variables, a table for device subscriptions (one migration), and a sender in the Communications
   delivery path. iOS shows push only for apps added to the home screen (iOS 16.4+). Lock-screen text would show no
   load or customer details ("New update in Taviron"). Say if you want it built; then you set the keys in Vercel.
3. **Store-published native apps (optional, paid accounts):** the proportional route is a thin native shell
   (Capacitor) around this same app. It needs an Apple Developer account ($99/year), a Google Play developer account
   (one-time $25), app signing keys, store listings and privacy labels. These are your decision and your accounts.
   Nothing will be published without them.
