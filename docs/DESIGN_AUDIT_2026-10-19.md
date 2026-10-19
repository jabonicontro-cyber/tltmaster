# Website and shared design audit — 2026-10-19

Local dev server (not the deployed site), measured with Playwright + axe-core. Widths 390 / 768 / 1280 (site header also
800–1024); light and dark theme for app, admin and state pages; reduced motion emulated.

## Pages inspected

| Area | Paths |
| --- | --- |
| Public site | `/`, `/pricing`, `/platform`, `/solutions`, `/about`, `/contact`, `/demo`, `/privacy`, `/terms` |
| Sign-in and security | `/login`, `/signup`, `/forgot-password`, `/mfa` (platform user). `/early-access` not covered (gate off in dev) |
| Customer portal | `/portal/<slug>/login`, `/portal/<slug>` (closed-portal state) |
| Company workspace (owner) | `/command-center`, `/dispatch`, `/orders`, an order, `/customers`, `/setup` (incl. onboarding), `/settings`, `/search`, `/customer-portal`, `/fleet/trucks`, `/help`, `/profile` |
| Owner console | `/admin`, `/admin/onboarding`, `/admin/testing-lab`, `/admin/companies` |
| States | `/no-access`, a missing order, `/settings` as a driver |

## Defects and fixes (shared components first)

| # | Defect | Root cause | Fix | Status |
| --- | --- | --- | --- | --- |
| 1 | Site header: "Sign in" / "Request a demo" wrapped to two lines at 768–830 px on every public page | Desktop nav switched on at `md` though it needs ~840 px | `src/components/site/site-header.tsx`: desktop nav and CTAs from `lg`, menu below; `whitespace-nowrap` | Fixed, verified (768/800 menu, 1024 CTA 36 px) |
| 2 | Accessible names that do not start with the visible text (axe `label-content-name-mismatch`, serious) on every app/admin page | `aria-label` overriding visible text | Company home links, account menus (app + console), console logo, dispatch Prev/Next, 7-day outlook: visible text first, details as sr-only text | Fixed, axe clean on `/command-center`, `/dispatch`, `/orders`, `/setup`, `/admin` |
| 3 | `/mfa` used a different frame and Title Case headings | Standalone page | `src/app/mfa/page.tsx`: same frame as sign-in (Taviron mark on navy, card, footer), sentence-case headings | Fixed, screenshot |
| 4 | Not-found state had no heading | `EmptyState` title was a `<p>` | `EmptyState` takes `as="h1"`; `(app)/not-found.tsx` uses it | Fixed. **Remaining:** title stays the page's ("Order · Taviron") and the status is 200 because `(app)/loading.tsx` starts streaming before `notFound()` (Next.js behaviour; `noindex` is added). Changing that means rethinking the loading boundaries |
| 5 | Closed/unknown portal showed a "?" tile | Fallback initial | `src/app/portal/[slug]/layout.tsx`: no tile without a company | Fixed |
| 6 | Dispatch "Go" looked like text and was 32 px next to a 40 px date field | `ghost` style | Secondary style, `h-9` like the field | Fixed |
| 7 | A driver on Settings saw every field disabled with no explanation | No read-only note | `/settings`: "You can view these settings…" note without `settings.manage` | Fixed |
| 8 | Console tab bar cut mid-word at 390/768 with no hint | `overflow-x-auto` only | `src/components/admin/admin-nav.tsx`: scroll snap + fading right edge below `lg` | Fixed, screenshot |
| 9 | "Sign Out" in the portal vs "Sign out" elsewhere | Wording | Portal layout | Fixed |

## Checked and fine (no change)

No horizontal overflow on any page/width/theme. Brand lockups within 1 px (site, sign-in, console with PLATFORM badge,
light/dark/390). H1 and first card share the left edge on every page (app 16/24/104 px, console 16/24/32, site
16/24/88). Heading sizes consistent. No unlabeled inputs. axe: no serious/critical issues on public, sign-in and portal
pages; no dark-mode contrast violations at 1280. Visible focus on the first 10 tab stops of every page. Nothing animates
under reduced motion. Every internal link on public/sign-in pages resolves; external links only to mytaviron.com. No
`dark:` variants; `bg-white` only where justified (print, logos, QR code). Homepage hero unchanged (static, no animation).

## Not covered / remaining

- `/early-access` and the portal sign-in form (portal closed locally) — next audit.
- Contrast beyond axe's checks; production build (this audit ran on the dev server).
- Not-found page title and HTTP status (see #4).
