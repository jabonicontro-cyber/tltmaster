# Product screenshots for the website

Rules for every screenshot of the Taviron app used on the public website, in decks or in emails.

## What a screenshot may show

- **The real app**, rendered from the code — never a mock-up, and never a screen for a feature that is not
  built (check `src/lib/site/capabilities.ts`).
- **The live demo company only** ("Northfield Aggregates (Demo)", started from `/admin/demo`). Its customers,
  orders, trucks, drivers, tickets and billing are fictional and consistent with each other. Never use a real
  company, and never the local test company (it is full of leftover automated-test records such as "(e2e)").
- **Everything a real customer would see**, including urgent items, warnings and safety states. Do not hide
  or edit them out to make a screen look calmer.
- Captions say "demo company, fictional data".

## What a screenshot must not show

- The yellow demo bar — use **presentation mode** (below); do not remove the bar from the code.
- Development overlays: capture from a production build (`npm run build` + `npx next start`) or the deployed
  site, not the dev server (which shows the Next.js indicator in the bottom-left corner).
- Browser chrome with private bookmarks, other tabs, email addresses of real people, environment variables,
  or anything from the platform area unless the screenshot is about the platform area.

## Presentation mode

In the demo company, the demo bar has a **Presentation mode** link. It hides the bar for the signed-in person
(a cookie, for 8 hours) — nothing else changes: same data, same alerts, same permissions. Bring the bar back
from the user menu (top right) → **Show the demo bar**. Presentation mode does nothing outside a demo company.

## Procedure

Automated: `scripts/capture-screenshots.mjs` signs in, turns on presentation mode and captures the five
screens used on the website at 1440 × 900 (phone 390 × 844), 2× scale. Credentials come from environment
variables only. The signed-in person's name appears in the screens (header, greeting, and as a driver in the
demo), so capture with an account whose display name is a plain person's name — not a test label such as
"Platform" or "e2e".

Manual:

1. Sign in as a platform-team member and open **Live demo** → start (or reset) the demo.
2. In the demo company, click **Presentation mode** in the demo bar.
3. Use a 1440 × 900 window for desktop shots and 390 × 844 for phone shots, at 1× or 2× scale.
4. Capture full screens or clean crops; save as PNG in `public/site/`, replacing the old file with the same name
   so pages keep working.
5. Check each image against the rules above before committing, and note the capture date in the commit
   message.
6. Turn presentation mode off when done (user menu → **Show the demo bar**).
