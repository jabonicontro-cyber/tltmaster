/**
 * Platform console UI (owner 2026-11-12: "the same look and feel as the Taviron site"). Every console page builds from
 * these, so the look lives here and not in page-specific classes. They sit inside ConsoleShell's `.console` scope:
 * `brand` utilities and the shared Button/ButtonLink are Taviron action blue there, never a company's colour.
 *
 * - ConsolePageHeader: eyebrow (the nav group, from `groupOf(href)`), display title, intro, the one main action.
 * - Panel / PanelHeader / PanelBody / PanelLink: quiet hairline cards for each section of a page.
 * - StatGrid: figures in the hairline grid; a list named by `label`; `onNavy` inside ConsoleBand.
 * - ConsoleBand: the navy summary band (Launchpad); `aria-label` names it as a region.
 * - ConsoleTabs: the one tab style (segmented links, aria-current on the current one).
 * - DataTable / DataHead / DataRow / DataCell: tables that turn into cards on phones (give cells a `label`).
 * - FilterBar / FilterField: the GET search-and-filter row above a list.
 * - CONSOLE_GROUPS / groupOf / currentLink: the navigation's one source (ui/nav.ts).
 *
 * Buttons: the shared `Button`/`ButtonLink`/`SubmitButton` (variant "primary" once per screen for the next step;
 * "secondary" for filters, edits and other moves; "ghost" for quiet ones). Status pills: the shared `Badge`.
 * Results after a redirect: `AdminFlash` (inline) or `FlashToast` (short confirmations), never both for one action.
 * Colours: theme tokens only (bg-card, text-ink, text-muted, border-line); red (`critical`) only for overdue, failed or
 * urgent states; no `dark:` variants (the theme remaps the palette).
 */
export { ConsolePageHeader } from "./page-header";
export { Panel, PanelBody, PanelHeader, PanelLink } from "./panel";
export { StatGrid, type Stat } from "./stat-grid";
export { ConsoleBand } from "./band";
export { ConsoleTabs, type ConsoleTab } from "./tabs";
export { DataCell, DataHead, DataRow, DataTable } from "./data-table";
export { FilterBar, FilterField } from "./filter-bar";
export { CONSOLE_GROUPS, LAUNCHPAD, currentGroup, currentLink, groupOf } from "./nav";
