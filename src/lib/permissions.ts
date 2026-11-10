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

/**
 * Permissions that show or change money (owner rule SEC4, 2026-11-09): every billing.* and pricing.* permission, pay,
 * compensation, accounting, repair costs and the audit records. A sign-in holding one signs in with a password and
 * two-step verification; QR codes and face or fingerprint sign-in are only for driver sign-ins without them (DS1). The
 * database has the same rule (private.is_money_permission, migration 20261120017100).
 */
/**
 * The permissions that show or change money (owner decision 2026-11-09, master plan §12 SEC4): two-step verification is
 * always required for them in a real company, and QR or face sign-in is refused. Every billing.* and pricing.*
 * permission counts too (isMoneyPermission), including future ones. The same list as private.money_permissions().
 */
export const MONEY_PERMISSIONS = [
  "billing.view",
  "billing.manage",
  "accounting.view",
  "payroll.manage",
  "employees.compensation",
  "pricing.edit",
  "pricing.override",
  "maintenance.costs",
  "audit.view",
  // Company settings set the default sales tax rate; user management can hand any money permission to any account.
  "settings.manage",
  "users.manage",
] as const;

export function isMoneyPermission(permission: string): boolean {
  return permission.startsWith("billing.") || permission.startsWith("pricing.") || (MONEY_PERMISSIONS as readonly string[]).includes(permission);
}

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
 * An outside accountant's sign-in (B134): its role can hold only these two permissions (enforced by the database), so
 * the app shows it only the accountant view and the finance pages it may read.
 */
export function isAccountantOnly(permissions: readonly string[]): boolean {
  return permissions.includes("accounting.view") && permissions.every((p) => p === "accounting.view" || p === "billing.view");
}
