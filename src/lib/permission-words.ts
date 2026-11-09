import { ROLE_LABELS, type AppRole, type Permission } from "@/lib/permissions";

/**
 * What each permission lets a person do, in plain words, for messages when it is missing (first-day finding
 * 2026-11-09: "permission needed (orders.edit)" told a dispatcher nothing). Permission codes are never shown to people.
 */
export const PERMISSION_WORDS: Record<Permission, string> = {
  "customers.view": "seeing customers",
  "customers.edit": "adding and changing customers",
  "materials.view": "seeing materials",
  "materials.edit": "adding and changing materials",
  "pricing.edit": "changing prices and price lists",
  "pricing.override": "overriding prices and giving discounts",
  "quotes.view": "seeing quotes",
  "quotes.edit": "writing and changing quotes",
  "quotes.send": "sending quotes to customers",
  "quotes.status": "marking quotes accepted, declined or canceled",
  "orders.view": "seeing orders",
  "orders.create": "creating new orders",
  "orders.edit": "changing, confirming and canceling orders",
  "orders.schedule": "scheduling orders and moving them through delivery",
  "fleet.view": "seeing trucks, trailers and drivers",
  "fleet.edit": "adding and changing trucks, trailers and drivers",
  "fleet.service": "taking trucks and trailers out of service and back",
  "fleet.assign": "setting the truck each driver usually drives",
  "dispatch.view": "seeing the dispatch board",
  "dispatch.edit": "planning loads and assigning trucks and drivers",
  "tickets.view": "seeing delivery tickets",
  "tickets.edit": "entering and correcting delivery tickets",
  "tickets.review": "accepting and correcting delivery tickets",
  "billing.view": "seeing billing and invoices",
  "billing.manage": "handling billing and invoices",
  "exceptions.assign": "giving open issues to a person",
  "driver.portal": "the driver's My Day",
  "field_reports.view": "seeing driver reports",
  "field_reports.manage": "acknowledging and resolving driver reports",
  "settings.manage": "changing company settings",
  "users.manage": "managing sign-ins and roles",
  "employees.view": "seeing employee records",
  "employees.edit": "changing employee records",
  "employees.compensation": "seeing and changing pay details",
  "time_off.view": "seeing time off",
  "time_off.approve": "approving time off",
  "time_off.balances": "setting up and adjusting time-off balances",
  "schedules.manage": "changing shifts and schedules",
  "maintenance.view": "seeing maintenance and work orders",
  "maintenance.manage": "managing work orders",
  "maintenance.costs": "seeing and recording repair costs",
  "maintenance.clear": "clearing trucks and trailers after safety repairs",
  "comms.message": "sending messages",
  "comms.groups": "starting group conversations",
  "comms.channels": "managing channels",
  "comms.announce": "posting announcements",
  "comms.operations": "creating and managing job workspaces",
  "comms.alerts": "changing, reassigning and resolving alerts",
  "comms.admin": "setting up communications",
  "audit.view": "seeing the change history",
  "payroll.manage": "setting pay rules and approving payroll",
  "safety.view": "seeing safety incidents",
  "safety.manage": "handling safety incidents",
  "accounting.view": "the accountant view",
};

/** Plain words for a permission code; a generic phrase for an unknown one (never the code itself). */
export function permissionWords(code: string | null | undefined): string {
  return (code && PERMISSION_WORDS[code as Permission]) || "this page";
}

const join = (xs: string[]) => (xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * "Creating and changing orders is part of the Owner / Administrator and Office staff roles here. Ask one of them, or
 * ask an owner to add it to your role (Settings → Roles and permissions)." `roles` are the company's roles that hold
 * the permission (read from its role settings); null when they could not be read.
 */
export function missingPermissionText(code: string | null | undefined, roles: AppRole[] | null): string {
  const what = permissionWords(code);
  const What = what.charAt(0).toUpperCase() + what.slice(1);
  const ask = "ask an owner to add it to your role (Settings → Roles and permissions)";
  const named = (roles ?? []).filter((r) => r !== "accountant").map((r) => ROLE_LABELS[r]);
  if (!code || what === "this page") return `Your role does not include this. Ask an owner if you need it.`;
  if (!named.length) return `${What} is not part of your role. If you need it, ${ask}.`;
  return `${What} is not part of your role. Here it is part of the ${join(named)} role${named.length === 1 ? "" : "s"}: ask one of them, or ${ask}.`;
}

/** "the Owner / Administrator and Dispatcher roles" for in-page notes; "the owner's role" when the roles are not known. */
export function rolesPhrase(roles: AppRole[] | null): string {
  const named = (roles ?? []).filter((r) => r !== "accountant").map((r) => ROLE_LABELS[r]);
  return named.length ? `the ${join(named)} role${named.length === 1 ? "" : "s"}` : "the owner's role";
}
