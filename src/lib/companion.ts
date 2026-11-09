import type { Permission } from "@/lib/permissions";

/**
 * Taviron companion app (docs/COMPANION_APP.md): the installable web app drivers add to their phone's home screen.
 * Same backend, sign-in, company isolation and permissions as the rest of Taviron; these helpers only decide what the
 * phone shell shows.
 */

/** Permissions that give someone office, dispatch, shop or sales work: such a person gets the full navigation. */
const OFFICE: Permission[] = ["dispatch.view", "tickets.view", "billing.view", "fleet.view", "field_reports.view", "orders.view", "quotes.view", "maintenance.view"];

/** A login whose only work is driving: My Day is home and the phone shows a bottom tab bar. */
export function isDriverOnly(permissions: readonly string[]): boolean {
  return permissions.includes("driver.portal") && !OFFICE.some((p) => permissions.includes(p));
}

/**
 * A login whose work is the shop (maintenance, but no dispatch, office or sales work and no driver day): My jobs is
 * home and the phone shows the mechanic's tab bar.
 */
const NOT_SHOP: Permission[] = ["dispatch.view", "tickets.view", "billing.view", "orders.view", "quotes.view", "driver.portal"];
export function isMechanicOnly(permissions: readonly string[]): boolean {
  return permissions.includes("maintenance.view") && !NOT_SHOP.some((p) => permissions.includes(p));
}

/**
 * Where a person lands after signing in without a page to return to (B2): a mechanic-only login starts on My jobs, the
 * list of fresh driver defects and their own work. Everyone else keeps the usual landing (null: the Command Center,
 * which itself sends drivers to My Day and accountants to their view).
 */
export function signInHome(permissions: readonly string[]): string | null {
  return isMechanicOnly(permissions) ? "/maintenance/my-jobs" : null;
}

export interface DriverTab { href: string; label: string; match: (path: string) => boolean }

/**
 * The driver's tabs. Each page still checks its own permission on the server; a tab only appears when the login has
 * it (messages need comms.message; time off and the profile are every employee's own).
 */
export function driverTabs(permissions: readonly string[]): DriverTab[] {
  const tabs: DriverTab[] = [{ href: "/driver", label: "My Day", match: (p) => p === "/driver" || p.startsWith("/driver/") }];
  if (permissions.includes("comms.message")) tabs.push({ href: "/communications", label: "Messages", match: (p) => p.startsWith("/communications") });
  tabs.push({ href: "/time-off", label: "Time off", match: (p) => p.startsWith("/time-off") });
  tabs.push({ href: "/profile", label: "Profile", match: (p) => p.startsWith("/profile") });
  return tabs;
}

/**
 * A dispatcher who also drives (UX8): dispatch work plus their own driver day. They keep the full menu, and on a phone
 * also get tabs for the two places they switch between all day.
 */
export function isDispatcherDriver(permissions: readonly string[]): boolean {
  return permissions.includes("driver.portal") && permissions.includes("dispatch.view");
}

/** Tabs for a dispatcher who drives: My Day, Dispatch, Messages, Profile (each page still checks its permission). */
export function dispatcherDriverTabs(permissions: readonly string[]): DriverTab[] {
  const tabs: DriverTab[] = [
    { href: "/driver", label: "My Day", match: (p) => p === "/driver" || p.startsWith("/driver/") },
    { href: "/dispatch", label: "Dispatch", match: (p) => p.startsWith("/dispatch") },
  ];
  if (permissions.includes("comms.message")) tabs.push({ href: "/communications", label: "Messages", match: (p) => p.startsWith("/communications") });
  tabs.push({ href: "/profile", label: "Profile", match: (p) => p.startsWith("/profile") });
  return tabs;
}

/** A job opened from My jobs carries ?from=my-jobs; the tab bar passes it on so My jobs stays highlighted. */
const FROM_MY_JOBS = /[?&]from=my-jobs(&|$)/;

/**
 * The mechanic's tabs (each page still checks its own permission on the server). A work order opened from My jobs
 * keeps "My jobs" highlighted (first-day review 2026-11-09).
 */
export function mechanicTabs(permissions: readonly string[]): DriverTab[] {
  const tabs: DriverTab[] = [
    { href: "/maintenance/my-jobs", label: "My jobs", match: (p) => p.startsWith("/maintenance/my-jobs") || (p.startsWith("/maintenance/work-orders/") && FROM_MY_JOBS.test(p)) },
    { href: "/maintenance/work-orders", label: "All jobs", match: (p) => p.startsWith("/maintenance/work-orders") && !FROM_MY_JOBS.test(p) },
  ];
  if (permissions.includes("comms.message")) tabs.push({ href: "/communications", label: "Messages", match: (p) => p.startsWith("/communications") });
  tabs.push({ href: "/time-off", label: "Time off", match: (p) => p.startsWith("/time-off") });
  tabs.push({ href: "/profile", label: "Profile", match: (p) => p.startsWith("/profile") });
  return tabs;
}

/**
 * How old the data on screen may get before the phone says so. Operational information (loads, times, instructions)
 * is never shown as current once it is older than this or the phone is offline.
 */
export const STALE_AFTER_MS = 5 * 60_000;

export type Freshness = "current" | "stale" | "offline";

export function freshness(renderedAt: number, now: number, online: boolean): Freshness {
  if (!online) return "offline";
  return now - renderedAt > STALE_AFTER_MS ? "stale" : "current";
}
