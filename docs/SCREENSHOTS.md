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

- The "Demo" badge on the account button or the demo welcome dialog — use **presentation mode** (below).
- Development overlays: capture from a production build (`npm run build` + `npx next start`) or the deployed
  site, not the dev server (which shows the Next.js indicator in the bottom-left corner).
- Browser chrome with private bookmarks, other tabs, email addresses of real people, environment variables,
  or anything from the platform area unless the screenshot is about the platform area.

## Presentation mode

In the demo company, the profile menu (top right) has **Presentation mode**. It hides the "Demo" badge and the
welcome dialog for the signed-in person (a cookie, for 8 hours) — nothing else changes: same data, same alerts, same
permissions. Turn it off the same way (it shows a check while on). **Change view** keeps working while presenting.
Presentation mode does nothing outside a demo company.

## Procedure

Automated: `scripts/capture-screenshots.mjs` reads the shot list in `src/lib/site/screenshots.json` (the feature
catalog's screenshots, docs/MARKETING.md).

- It signs in, closes the demo welcome and turns on presentation mode from the profile menu.
- It captures at 1440 × 900 (phone 390 × 844), 2× scale.
- Each shot must pass the quality gate (docs/MARKETING.md §4) before it is written. A rejected shot is reported and
  not saved.
- `public/site/manifest.json` records each accepted capture.
- `--only id,id` captures a subset.
- Credentials come from environment variables only. The signed-in person's name appears in the screens (header, greeting, and as a driver in the
demo), so capture with an account whose display name is a plain person's name — not a test label such as
"Platform" or "e2e".

Manual:

1. Sign in as a platform-team member and open **Live demo** → start (or reset) the demo.
2. In the demo company, open the profile menu (top right) → **Presentation mode**.
3. Use a 1440 × 900 window for desktop shots and 390 × 844 for phone shots, at 1× or 2× scale.
4. Capture full screens or clean crops; save as PNG in `public/site/`, replacing the old file with the same name
   so pages keep working.
5. Check each image against the rules above before committing, and note the capture date in the commit
   message.
6. Turn presentation mode off when done (profile menu → **Presentation mode**).
