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

- **Published, with screens:** Command Center, Plan the day, Dispatch and Smart Dispatch, Customers / quotes / orders, Billing readiness, Communications,
  Driver portal, Delivery tickets, Maintenance, Fleet.
- **Published, brief only (no screenshot yet):** Employees and time off, Reports,
  Company setup / roles / security.
- **Not published:** AI explanation of a plan (in development), Route planning (planned).

Next screenshots to add, if the demo data shows them well: Time off, Reports, Company setup; a richer Communications
sample (the demo has one workspace conversation).
