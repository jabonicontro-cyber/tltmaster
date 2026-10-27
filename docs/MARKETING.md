# Marketing: feature catalog, screenshots and the feature-to-website workflow

How the public website stays accurate as Taviron grows (owner requirement, 2026-10-13: "Premium Marketing Experience,
Fully Realized Demo Screenshots, and Automatic Feature Showcases").

## 1. One catalog

`src/lib/site/features.ts` is the single source for what the website says Taviron does. Each feature has:

| Field | Meaning |
| --- | --- |
| `id`, `name`, `category` | Stable id, display name, group |
| `problem`, `how`, `value` | The operational problem, what the person actually does in Taviron, and why it matters (no invented numbers) |
| `points`, `limitations` | What a visitor can check in the demo; what it does not do yet (shown, never hidden) |
| `status` | `available`, `in_demo` (works in demos, waits on an owner step), `in_development`, `planned` |
| `published` | Whether the website may describe it. Only `available` features can be published |
| `routes` | App pages that demonstrate it |
| `screenshots` | Ids in `src/lib/site/screenshots.json` |
| `related` | Other features it works with (cross-links on the platform page) |
| `verified` | Date the copy was last checked against the running app |

`NOT_YET` lists planned work the site states plainly. `NOT_MARKETED` lists app pages deliberately left out, with the
reason.

The platform page (`/platform`) is generated from the catalog:
- a feature with a screenshot gets a full story section (problem, how, value, points, limitations, the real screen,
  related links);
- a feature without one gets a compact brief, so the page never shows an empty image frame;
- `capabilities.ts` (`AVAILABLE`, `PLANNED`) is derived from the catalog for the older checks.

## 2. Status is not publication

Building a feature internally never makes it a public claim on its own:

- An entry is `published: false` until a person sets it, after checking the feature in the demo.
- `tests/unit/feature-catalog.test.ts` fails if anything `planned` or `in_development` is published.
- Material claims still follow the release checklist: pricing, legal statements, security certifications, customer
  names or endorsements, and positioning changes.

## 3. Automatic checks

`tests/unit/feature-catalog.test.ts` runs in the normal suite. It fails when:

- a page in the app's navigation (`src/components/layout/nav.ts`) is covered by no feature and not listed in
  `NOT_MARKETED`. This is how a new feature is detected;
- a published feature points at an app page that no longer exists;
- a published feature lists a screenshot that is missing from `public/site/`;
- a screenshot entry belongs to no feature, has weak alt text, or lacks the "demo company / fictional" caption;
- an image in `public/site/` is used nowhere (orphaned);
- published copy uses claims Taviron cannot back: QuickBooks, GPS tracking, OCR, payroll integration, online payment,
  drive time, automatic assignment, EDI, "optimal", "guarantee";
- a published feature has not been re-verified in 120 days;
- ids or names are duplicated, or related ids are unknown.

`tests/unit/site-capabilities.test.ts` keeps the older checks. Link and route checks: the e2e site specs open every
public page.

## 4. Screenshots

- **Shot list:** `src/lib/site/screenshots.json`. Each shot gives the app page, the viewport, the text that proves
  the page has finished loading, the alt text and the caption.
- **Capture:** `scripts/capture-screenshots.mjs` (docs/SCREENSHOTS.md for the rules), against a production build.
  - It signs in, checks it is inside the demo company and turns on presentation mode.
  - Each shot must pass a **quality gate** before it is written:
    - the ready text is visible;
    - nothing is loading (no spinner, no "Loading…");
    - fonts are loaded and every image has loaded;
    - no sideways overflow;
    - no demo badge and no development overlay;
    - no error page and no console errors.
  - A rejected shot is not written, and the script exits non-zero.
  - `public/site/manifest.json` records each accepted capture: file, feature, page, viewport, time and source host.
- **Data:** fictional demo company only, never a real company or production data. See docs/DEMO_TENANTS.md for the
  sample data each feature needs.

## 5. When a feature ships (part of the definition of done)

1. **Detect:** the catalog test fails if the feature added a navigation entry. Otherwise the feature's own plan names
   its marketing impact.
2. **Catalog:** add or update the entry in `src/lib/site/features.ts` with copy written from what the demo actually
   shows. Leave it `published: false` until it is checked.
3. **Screenshot:** if the feature deserves a screen, add a shot to `screenshots.json`. Make sure the demo samples
   exercise it (`src/server/demo/samples.ts`), then run the capture script against a production build.
4. **Related pages:** the platform page updates from the catalog. Check whether the homepage story, Solutions or
   Pricing text mentions the area.
5. **Check:**
   - `npx vitest run tests/unit/feature-catalog.test.ts tests/unit/site-capabilities.test.ts`;
   - the site e2e specs;
   - look at `/platform` at desktop and phone sizes.
6. **Publish:** set `published: true` and `verified` to today, and ship through the normal release process
   (RELEASE_CHECKLIST §3). Nothing is published outside it.

## 6. Current coverage (2026-10-13)

- **Published, with screens:** Command Center, Plan the day, Dispatch and Smart Dispatch, Customers / quotes / orders,
  Billing readiness, Communications, Driver portal, Delivery tickets, Maintenance, Fleet, Employees and time off
  (the employee directory), Reports, Company setup / roles / security (the setup checklist).
- **Published, brief only:** none.
- **Not published:** AI explanation of a plan (in development), Route planning (built and marked available in the catalog; not published — publishing is a person's decision).

Next screenshots to add, if the demo data shows them well: Time off approvals (the demo has two pending requests), a
richer Communications sample (the demo has one workspace conversation).

## 7. Website structure (2026-10-20)

Positioning: **"Your entire trucking operation. Connected."** with **"See what's happening. Know what to do next."**;
homepage calls to action **Explore the Platform** and **Request a Demo**.

| Where | Source | Notes |
| --- | --- | --- |
| Navigation and footer | `src/lib/site/nav.ts` (`SITE_NAV`, `FOOTER_GROUPS`); `src/components/site/site-nav.tsx` | Disclosure menus (keyboard, Escape, outside click); the phone menu lists the same groups. |
| Platform areas `/platform/{dispatch,fleet,customers,intelligence,automation,control}` | `src/lib/site/areas.ts` (`AREAS`) | Each area: problem, value, workflow steps, the real screens of its **published** catalog features, controls, "Not available yet", connections. |
| Solutions `/solutions/{small-fleets,growing-fleets,enterprise}` | `SEGMENTS` in the same file | Needs, a demo scenario, and the plans that usually fit, read from `src/lib/site/pricing.ts`. |
| `/trust`, `/faq` | the pages; `src/lib/site/faq.ts`, `src/lib/site/pricing-faq.ts` | Pricing questions are written once and shown on `/pricing` and `/faq`. |
| Public page list | `SITE_PAGES` in `src/lib/site/paths.ts` | Exact paths only; robots and `sitemap.xml` (only when `SITE_INDEXING=on`) read it. |

Rules kept by `tests/unit/site-areas.test.ts`: areas use only published features; every navigation and footer link is a
public page with a page file; solutions name real plans; no percentages, testimonials or guarantees in area text.
`tests/e2e/website.spec.ts` checks every page renders with one heading, every link resolves, the menus work by keyboard
and on a phone, a demo request keeps the visitor's interest (`/demo?interest=<area or solution>` prefills the message),
and nothing scrolls sideways.

**Resources (2026-10-27, B88):** comparisons `src/lib/site/compare.ts` (each Taviron row names its published feature;
no competitor names, figures or testimonials), the paperwork calculator `src/lib/site/calculator.ts` (pure arithmetic on
the visitor's numbers, nothing pre-filled or sent), public guides `src/lib/site/guides.ts` (an allowlist of Help Center
articles for published features; settings and administration stay in the app), and What's new from
`src/lib/site/releases.ts` (only `published` entries with an approval; the menu links it once one exists). Checked by
`tests/unit/site-pages.test.ts` and `tests/e2e/website.spec.ts`. Link previews use `public/og/taviron.png`
(`node scripts/site/render-og-image.mjs` after the Command Center screenshot changes); every page has a canonical
address on `PUBLIC_WEBSITE_URL`.

Not done, needing a decision: analytics (the privacy notice says the site sets no analytics cookies), publishing the
hosting providers and data locations, a public Help Center, an interactive guided demo on the website (today the demo is
a walkthrough led by the Taviron team), and new screenshots for areas without one.
