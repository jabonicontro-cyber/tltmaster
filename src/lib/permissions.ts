// Permission codes. The role → permission mapping lives in the database
// (public.role_permissions) and is editable by the owner; this list only
// gives the codes a type.
export const PERMISSIONS = [
  "customers.view",
  "customers.edit",
  "materials.view",
  "materials.edit",
  "pricing.edit",
  "pricing.override",
  "quotes.view",
  "quotes.edit",
  "quotes.send",
  "quotes.status",
  "orders.view",
  "orders.create",
  "orders.edit",
  "orders.schedule",
  "fleet.view",
  "fleet.edit",
  "fleet.service",
  "fleet.assign",
  "dispatch.view",
  "dispatch.edit",
  "tickets.view",
  "tickets.edit",
  "tickets.review",
  "billing.view",
  "billing.manage",
  "exceptions.assign",
  "driver.portal",
  "field_reports.view",
  "field_reports.manage",
  "settings.manage",
  "users.manage",
  "employees.view",
  "employees.edit",
  "employees.compensation",
  "time_off.view",
  "time_off.approve",
  "time_off.balances",
  "schedules.manage",
  "maintenance.view",
  "maintenance.manage",
  "maintenance.costs",
  "maintenance.clear",
  "comms.message",
  "comms.groups",
  "comms.channels",
  "comms.announce",
  "comms.operations",
  "comms.alerts",
  "comms.admin",
  "audit.view",
  "payroll.manage",
  "safety.view",
  "safety.manage",
  "accounting.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Roles given to people who work in the company (role pickers). */
export const ROLES = ["owner", "office", "dispatcher", "mechanic", "driver"] as const;
/** Every role, including an outside accountant's time-limited, read-only role (B134; given only through Accountant access). */
export type AppRole = (typeof ROLES)[number] | "accountant";

export const ROLE_LABELS: Record<AppRole, string> = {
  owner: "Owner / Administrator",
  office: "Office staff",
  dispatcher: "Dispatcher",
  mechanic: "Mechanic",
  driver: "Driver",
  accountant: "Outside accountant",
};

export interface Access {
  userId: string;
  /** The company this session works in; every query is limited to it by the database. */
  companyId: string | null;
  companyName: string | null;
  email: string;
  fullName: string;
  role: AppRole | null;
  active: boolean;
  permissions: Permission[];
  /** The current company is a demo company (fictional data, no external side effects). */
  isDemo?: boolean;
  /** A role preview shown in the demo company (presentation only; see src/lib/platform/preview.ts). */
  preview?: string | null;
  /** This session is a Taviron support visit (owner permissions until endsAt; 20261120008900). */
  support?: { endsAt: string } | null;
  /** An owner of this company, while Taviron support is inside (the banner). */
  supportInside?: boolean;
  /** Changes Taviron support asked for that wait for an owner (owners and visiting staff; 20261120009200). */
  supportRequests?: number;
}

export function can(access: Pick<Access, "permissions"> | null | undefined, permission: Permission): boolean {
  return Boolean(access?.permissions.includes(permission));
}

/**
 * Starting a new order (the "New order" entry points): orders.create (owner 2026-11-09: dispatchers take phoned-in
 * orders) or orders.edit (which always could). Changing existing orders stays orders.edit.
 */
export function canCreateOrders(access: Pick<Access, "permissions"> | null | undefined): boolean {
  return can(access, "orders.create") || can(access, "orders.edit");
}

/**
 * Who confirms a price typed on an order line without a price-list rate (financial review M1, owner 2026-11-10;
 * public.order_confirm_price checks the same).
 */
export function canConfirmPrices(access: Pick<Access, "permissions"> | null | undefined): boolean {
  return can(access, "pricing.edit") || can(access, "pricing.override") || can(access, "billing.manage");
}

/**
 * A price this person types on an order line without a price-list rate is flagged "Price to be checked": they enter
 * orders without orders.edit and cannot decide prices themselves (private.order_price_check_after_save checks the same).
 */
export function typedPriceChecked(access: Pick<Access, "permissions"> | null | undefined): boolean {
  return !can(access, "orders.edit") && !canConfirmPrices(access);
}

type OrderOwnerFacts = { created_by: string | null; source_quote_id: string | null };

/**
 * A direct order (not from a quote) this person entered themselves, while they hold orders.create. On it they may,
 * without orders.edit: change, confirm or cancel it while it is a draft, flag it urgent and change its stops (owner
 * 2026-11-09, MD1). The database checks the same (private.require_order_transition, private.require_own_order_change).
 */
export function isOwnDirectOrder(access: Pick<Access, "permissions" | "userId"> | null | undefined, order: OrderOwnerFacts): boolean {
  if (!access || !can(access, "orders.create")) return false;
  return order.created_by !== null && order.created_by === access.userId && order.source_quote_id === null;
}

/** Flag an order urgent and change its stops: orders.edit on any order, orders.create on the person's own direct order. */
export function canChangeOrderUrgencyAndStops(access: Pick<Access, "permissions" | "userId"> | null | undefined, order: OrderOwnerFacts): boolean {
  return can(access, "orders.edit") || isOwnDirectOrder(access, order);
}

/**
 * An outside accountant's sign-in (B134): its role can hold only these two permissions (enforced by the database), so
 * the app shows it only the accountant view and the finance pages it may read.
 */
export function isAccountantOnly(permissions: readonly string[]): boolean {
  return permissions.includes("accounting.view") && permissions.every((p) => p === "accounting.view" || p === "billing.view");
}
