# Taviron design system (app and platform console)

Redesign of 2026-10-25 (master plan B90). The owner's references: Stripe's dashboard (large figures, quiet
labels, segmented periods), soft rounded panels, floating pill navigation with a dark active state. Goal: calm,
modern and uncluttered while every control stays one step away. These rules apply to company workspaces, the
driver/mechanic phone views and the platform console (`/admin`). The public website follows them in its own palette.

## Tokens (`src/app/globals.css`)

- Panels: `rounded-panel border border-line/70 bg-card shadow-card` (or the `Card` component). Menus, dialogs and
  floating bars: `shadow-float`. Controls: `rounded-control` (inputs) or `rounded-full` (buttons, pills, tabs).
- Colours only through the theme tokens (`bg-card`, `bg-surface`, `text-ink`, `text-muted`, `border-line`,
  `bg-strong`, `text-brand-fg`); urgency and safety use `critical`, never `brand`. No `dark:` variants.

## Patterns

- **Navigation (owner 2026-10-27):** light mode has a light rail, dark mode a graphite one (`--color-nav`), in every
  workspace; the current page is a filled pill in the company's accent (`bg-nav-active`). Selected chips, tabs and the
  current view use `bg-strong`, which is the company's accent too. The company's "document color" only colours printed
  quote headings.
- **Dark mode (owner's references 2026-10-27):** neutral graphite, cards one step lighter than the page with a hairline
  top highlight, a faint accent glow at the top of the page; colour only where it means something.
- **Figures and charts:** `StatTile` (icon chip, label, large figure, one line of context), `Ring` for a share of a whole,
  bars for a week or a pipeline, change chips only against a measured earlier period. Explanations go behind `InfoTip`.
- **Tabs:** section tabs are a segmented
  control: `rounded-full bg-ink/[0.05] p-1`; the current tab `bg-card text-ink shadow-xs`. Second-level tabs are quieter
  (`bg-ink/[0.07]` on the current one, no container).
- **Figures:** summary numbers are large and tight: `text-[1.875rem]` to `text-[2.5rem]`, `leading-none`/`leading-tight`,
  `font-semibold tracking-[-0.03em] tabular`. A label above in `text-sm text-muted`, context below.
- **Actions:** one filled button for the next step; editing outlined (`secondary`); other moves `ghost`; destructive
  actions apart and red. Row-level secondary controls may appear on hover/focus, but always on touch screens
  (`[@media(hover:hover)]:opacity-0 … group-hover:opacity-100 group-focus-within:opacity-100`).
- **Faces:** where people are listed (Schedule, Dispatch, drivers, time off, crews, communications) show `Avatar` with
  `src`/`fallbackSrc` from `src/server/data/faces.ts` (photo, then illustrated avatar, then initials).
- **No doubled headings:** when a section heading names the content, the card inside has no title (`CardHeader`
  with only a description).

## Alignment rules (checked by eye and by measurement)

- **Lists with several values per row use fixed columns** (CSS grid or a table), never values that follow each other
  in a flex row: a badge after a variable-width number or date drifts from row to row.
- **Show labels, not raw values:** statuses go through their badge component (`OrderStatusBadge`, …), never
  `status.replaceAll("_", " ")`.
- **Centred text in every pill and button (owner 2026-10-26, applies everywhere):** Inter is shipped with the app
  (`next/font` in `src/app/layout.tsx`); before that it was only named, so computers without Inter (most Macs) drew
  Helvetica Neue and the old one-pixel padding nudges put the words off-centre. Rules: pills and buttons have a fixed
  height and `items-center`, with even padding (never a `pt-…`/`pb-…` nudge); the words go in a span with `pill-text`
  (`globals.css`: trims the text box to capitals and baseline, so the middle is exact in every browser). `Badge`,
  `Button` and `ButtonLink` do this themselves (`src/components/ui/pill-text.tsx`); a hand-made pill wraps its words
  the same way. Not on truncated text (trimming clips the line); those keep a fixed height and `items-center`.
  Checked from layout: the trimmed text box's centre equals the pill's centre (`off-centre 0.00`).
- Dates and figures in lists: `whitespace-nowrap tabular`; numbers right-aligned in their column.
