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

- **Navigation:** the floating sidebar marks the current page with a solid light pill. Section tabs are a segmented
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
- **Optical centring of pill text:** with Inter, lowercase text sits about 0.75 px low in a pill with equal padding.
  Pills lift the text by giving 1 px more padding below than above (badges `pt-0.5 pb-[3px] leading-4`; small chips
  `pt-1 pb-[5px]`; tab pills `pt-1.5 pb-[7px] leading-5`). Fractional padding (`pt-[1.5px]`) is rounded away by the
  browser and has no effect. All-caps labels keep equal padding (capitals already sit high).
  Measured with a 4× screenshot of each pill, comparing the ink's top and bottom margins.
- Dates and figures in lists: `whitespace-nowrap tabular`; numbers right-aligned in their column.
