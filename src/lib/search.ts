// Global search (Phase 8): one query box over the records a person may open. Each group is searched only with the
// permission that opens its page, and the database's row-level security still decides which rows come back.
import type { Permission } from "@/lib/permissions";

export type SearchGroupKey = "customers" | "orders" | "quotes" | "tickets" | "trucks" | "trailers" | "drivers" | "people";

export type SearchHit = { id: string; title: string; detail: string; href: string };

export const SEARCH_GROUPS: Array<{ key: SearchGroupKey; label: string; permission: Permission }> = [
  { key: "customers", label: "Customers", permission: "customers.view" },
  { key: "orders", label: "Orders", permission: "orders.view" },
  { key: "quotes", label: "Quotes", permission: "quotes.view" },
  { key: "tickets", label: "Delivery Tickets", permission: "tickets.view" },
  { key: "trucks", label: "Trucks", permission: "fleet.view" },
  { key: "trailers", label: "Trailers", permission: "fleet.view" },
  { key: "drivers", label: "Drivers", permission: "fleet.view" },
  { key: "people", label: "People", permission: "employees.view" },
];

/** The groups this person may search (never more than their permissions open). */
export function searchableGroups(permissions: readonly Permission[]) {
  return SEARCH_GROUPS.filter((g) => permissions.includes(g.permission));
}

/** A cleaned query (2–80 characters), or null. */
export function cleanQuery(q: string | null | undefined): string | null {
  const v = (q ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return v.length >= 2 ? v : null;
}

/**
 * The query as a PostgREST `ilike` pattern: % and _ are literal (escaped), and the characters PostgREST's
 * `or=(...)` filter syntax treats specially — commas, parentheses, quotes — are dropped so input can never change
 * the filter itself.
 */
export function ilikePattern(q: string): string {
  const safe = q.replace(/[(),"'\\]/g, " ").replace(/[%_]/g, (c) => `\\${c}`).trim();
  return `%${safe}%`;
}
