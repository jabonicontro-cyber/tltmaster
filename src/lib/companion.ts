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

/** The mechanic's tabs (each page still checks its own permission on the server). */
export function mechanicTabs(permissions: readonly string[]): DriverTab[] {
  const tabs: DriverTab[] = [
    { href: "/maintenance/my-jobs", label: "My jobs", match: (p) => p.startsWith("/maintenance/my-jobs") },
    { href: "/maintenance/work-orders", label: "Work orders", match: (p) => p.startsWith("/maintenance/work-orders") },
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
