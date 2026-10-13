import type { Access, AppRole, Permission } from "@/lib/permissions";

// Role previews in the demo company. A preview is presentation only: it can
// only take permissions away from what the person really has (the
// intersection), never add any — and the server and database keep enforcing
// the real permissions. Previews apply only inside a demo company.
export const PREVIEW_ROLES = ["owner", "dispatcher", "multi", "office", "driver", "mechanic"] as const;
export type PreviewRole = (typeof PREVIEW_ROLES)[number];

export const PREVIEW_LABELS: Record<PreviewRole, string> = {
  owner: "Owner",
  dispatcher: "Dispatcher",
  multi: "Dispatcher who also drives",
  office: "Office",
  driver: "Driver",
  mechanic: "Mechanic",
};

/** The company roles whose permissions a preview shows (multi-role = the union). */
export const PREVIEW_SOURCES: Record<PreviewRole, AppRole[]> = {
  owner: ["owner"],
  dispatcher: ["dispatcher"],
  multi: ["dispatcher", "driver"],
  office: ["office"],
  driver: ["driver"],
  mechanic: ["mechanic"],
};

export const PREVIEW_COOKIE = "taviron-preview";

/** Presentation mode (demo company only): hides the demo badge and the welcome dialog for screenshots and live demos. */
export const PRESENTATION_COOKIE = "taviron-presentation";

/**
 * Fallback memory of the demo welcome when the database cannot keep it (migration 20261109000100 not applied):
 * "<company>.<user>" pairs, newest last. The database row (user_preferences 'demo_welcome') is the account-wide record.
 */
export const DEMO_WELCOME_COOKIE = "taviron-demo-welcome";
export const welcomeToken = (companyId: string, userId: string) => `${companyId}.${userId}`;
export function welcomedInCookie(value: string | undefined, token: string): boolean {
  return (value ?? "").split(",").includes(token);
}
/** Adds a pair, keeping the cookie small (the last 6 demo companies or people on this browser). */
export function withWelcomeToken(value: string | undefined, token: string): string {
  const list = (value ?? "").split(",").filter((t) => t && t !== token);
  return [...list, token].slice(-6).join(",");
}

export function parsePreviewRole(value: string | null | undefined): PreviewRole | null {
  return value && (PREVIEW_ROLES as readonly string[]).includes(value) ? (value as PreviewRole) : null;
}

/**
 * The access a preview presents: the real permissions intersected with the
 * previewed role's permissions in this company. Never more than `access`.
 */
export function applyPreview(access: Access, preview: PreviewRole, rolePermissions: Array<{ role: string; permission: string }>): Access {
  const sources = new Set<string>(PREVIEW_SOURCES[preview]);
  const shown = new Set(rolePermissions.filter((r) => sources.has(r.role)).map((r) => r.permission));
  const permissions = access.permissions.filter((p): p is Permission => shown.has(p));
  // A dispatcher who also drives sees the dispatcher's home; a single role shows as itself.
  const role: AppRole = preview === "multi" ? "dispatcher" : preview;
  return { ...access, permissions, role, preview };
}
