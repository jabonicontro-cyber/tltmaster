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
  "orders.edit",
  "settings.manage",
  "users.manage",
  "audit.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ["owner", "office", "dispatcher", "driver"] as const;
export type AppRole = (typeof ROLES)[number];

export const ROLE_LABELS: Record<AppRole, string> = {
  owner: "Owner / Administrator",
  office: "Office staff",
  dispatcher: "Dispatcher",
  driver: "Driver (future)",
};

export interface Access {
  userId: string;
  email: string;
  fullName: string;
  role: AppRole | null;
  active: boolean;
  permissions: Permission[];
}

export function can(access: Pick<Access, "permissions"> | null | undefined, permission: Permission): boolean {
  return Boolean(access?.permissions.includes(permission));
}
