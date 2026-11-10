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
| Mechanic workspace (owner 2026-10-25) | Working: **My jobs** (`/maintenance/my-jobs`) is a shop login's home, with a mechanic tab bar on phones (My jobs, Work orders, Messages, Time off, Profile). Each job shows the next step that fits it (Start this job, Start/Stop timer, My part is done), the running timer is pinned on top, and "Needs a mechanic" lists unled open jobs (most urgent first) to take. Same server actions and database functions as the work order page (crews, timers, statuses from `20261120002900`); nothing bypasses the work order rules. Before that migration the page says "Not available yet" |
| Dispatcher who also drives (UX8, 2026-11-04) | Working: a login with both `driver.portal` and `dispatch.view` keeps the full menu and, on a phone, also gets tabs for My Day, Dispatch, Messages and Profile (`isDispatcherDriver`, `dispatcherDriverTabs` in `src/lib/companion.ts`) |
| Inspection photos and dump body (UX9, 2026-11-04) | Working once `20261120006700` is applied: a defect can carry up to 8 photos (sent after the inspection is saved, to the work order it opened; not kept offline, the driver is told). Dump trucks also check air lines, hoist and body, PTO, tarp and tailgate (not safety items) |
| Inspections (DVIR) | Working (B132, 2026-11-02): pre-trip and post-trip on My Day; defects open work orders, safety defects take the truck out of service; a missing pre-trip is flagged, never blocking |
| Offline day and queued sends | Working (B133, owner 2026-11-02): see section 4 |
| Push notifications to the lock screen | **Not built.** Needs owner approval and keys (section 7) |
| Native iOS / Android store apps | **Not built.** Needs owner decision and accounts (section 7) |

## 4. Safety, connectivity and stale data

- **Driving:** My Day says "Use Taviron only when you are parked. Nothing here needs an answer while you drive." The
  tab bar has no counters or badges, and nothing asks for an immediate reply. Notifications for drivers on an
  active delivery are already deferred by Communications (one catch-up afterwards).
- **Freshness:** My Day shows when its data was read ("Updated 7:41 AM"). After 5 minutes it says "This may be out of
  date … check with dispatch" with a Refresh button. When the phone goes offline it says "No connection". It reloads
  when the app comes back to the foreground or back online.
- **Offline (B133, owner 2026-11-02: cached day + queued sends):**
  - *Saved day.* After My Day loads, the app keeps today's loads on the phone (browser storage, under the signed-in
    person's id): order, load, times, customer and project, site, truck and trailer, instructions, Arrived/Left state,
    the ticket form's lines and units, and the trucks still due an inspection. With no signal the app opens on
    `/offline`, which shows that day headed "Your day as of 9:42. No connection: this may be out of date — check with
    dispatch before acting on it". A saved day older than 18 hours is not shown. The service worker never stores it;
    the page as served carries no company data.
  - *Queued sends.* Without signal, a delivery ticket (without photos — photos need signal), an inspection and an
    Arrived/Left tap are saved on the phone ("Saved on this phone — not sent yet") and listed under **Waiting to send**.
    They are sent, oldest first, as soon as there is signal (on My Day: on load, when the phone comes back online, and
    every 20 seconds). Each goes through the same server action and database checks as a live one. Tickets keep their
    submission key, so a retry never creates a second ticket. Taps keep the time they were tapped
    (`load_stop_mark_at`: at most 16 hours back, never in the future, Left never before Arrived). Inspections keep
    their day (today or yesterday only).
  - *Refusals.* If Taviron refuses an item (for example a delivery time in the future), it stays under Waiting to send
    with the reason until the driver deletes it. It is never dropped silently.
  - *Sign-out.* Sign-out removes the saved day and the queue. If anything is still waiting, the driver is told how
    many items will be deleted first. Items belong to the person who made them and are never sent under someone
    else's sign-in.
  - *Not offline.* Messages, photos, field reports, fuel and trip sheets, time off and anything for another day still
    need signal.
- **Signing in without typing (DS1):** the office shows a one-time QR code (Fleet → a driver); the phone's camera opens
  it and the phone is signed in on My Day. My Day then offers face or fingerprint sign-in when the site has passkeys on
  (ACCOUNT_PROVISIONING §7). On iPhone a home-screen app keeps its own sign-in apart from Safari: a code opened from the
  camera signs Safari in, not the installed app (not tested on a device).
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
  checks that only the offline page, an icon and build files (`/_next/static`, the same for every company) are stored,
  that a failed page load returns the offline page, and that data, actions and POSTs are never handled or stored.
- Offline queue: `tests/unit/offline-store.test.ts` covers per-person storage, age limit, one item per key, refusals
  kept, sign-out clearing and storage failures. `tests/e2e/offline-driver.spec.ts` (phone size): a ticket and an
  Arrived tap without signal wait on the phone, the offline page shows the saved day, both reach the office once signal
  returns (one ticket, tapped time kept), and sign-out removes everything. DB rules: `tests/db/wait-times.test.ts`
  (`load_stop_mark_at`) and `tests/db/inspections.test.ts` (today or yesterday). A browser test can't prove this reliably here: in the full suite,
  Playwright's offline mode let the service worker's own page request through while blocking the page's CSS. The
  result was an unstyled live page, which can't happen on a real phone with no signal.
- Gate spec: the companion files are reachable with the gate on and carry no company data.
- **Not tested on a real iPhone or Android device**, and not on iOS Safari (Playwright runs Chromium here).

## 7. Owner decisions and dependencies

**Devices (owner 2026-10-25: iPhone, iPad and Android).** The companion app is the installable web app on all three:
iPhone and iPad through Safari → Share → Add to Home Screen; Android phones and tablets through Chrome → Install app.
Phones show the bottom tab bar; tablets (768 px and wider, e.g. iPad) show the regular sidebar layout. The app follows
the device's orientation (manifest `orientation: "any"`; it was portrait-only before, which locked iPads upright).
Store-published apps are a separate, optional step (item 3 below).

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


### 7a. Store apps (deferred, owner 2026-10-25)

**Current decision (owner, later on 2026-10-25):** keep the home-screen install on iPhone, iPad and Android for now;
store apps come closer to launch. Nothing below is being built until the owner says so; the steps stay here for then.

**Decision:** publish the companion app in the Apple App Store and Google Play, in addition to the home-screen install.
**Approach:** a thin native shell (Capacitor) around the same app; one codebase, same sign-in, permissions and tenant
isolation. Builds run in GitHub Actions (a macOS runner for iOS), so no Mac is needed. Signing keys are stored as GitHub
secrets by the owner, never in the repository.

**Owner steps (accounts are yours; neither exists yet, 2026-10-25):**
1. **D-U-N-S number** (free, a few days): needed to enrol as a company so the stores show the company name, not a
   person's. Request it through Apple's D-U-N-S lookup page (developer.apple.com/enroll/duns-lookup).
2. **Apple Developer Program** ($99/year): developer.apple.com/programs/enroll, as an organization, with the D-U-N-S
   number and a company website (mytaviron.com).
3. **Google Play Console** ($25 once): play.google.com/console/signup, as an organization; Google asks for identity
   and organization verification, and new personal accounts must run a closed test with testers before release.
4. Tell Claude when both are approved; Claude then lists the exact keys to create (App Store Connect API key, Android
   upload key) and where to save them as GitHub secrets.

**What Claude builds meanwhile (no accounts needed):** the Capacitor project, app icons and splash screens, the build
workflows (Android test build first), and the native features that make the app more than a website in a frame
(lock-screen notifications, camera for tickets and defect photos). **Risk, stated plainly:** Apple can reject apps that
are only a wrapped website (App Review guideline 4.2); native notifications and camera use reduce that risk, but approval
is Apple's decision. Store listings need a privacy policy URL (the published privacy page), screenshots and a support
contact, and Apple requires a way to request account deletion from inside the app.
