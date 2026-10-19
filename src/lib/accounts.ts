// Account provisioning and first sign-in (docs/ACCOUNT_PROVISIONING.md; migration 20261120001200). Pure helpers shared
// by the server and the browser: temporary passwords, presets, password rules, where a person lands, and the text of
// the instructions. A temporary password exists only in memory: generated on the server, shown to the administrator
// who issued it, never stored or logged.

import type { AppRole } from "@/lib/permissions";

/** Letters and digits without look-alikes (no 0/O, 1/l/I), so a printed sheet is easy to type on a phone. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/**
 * A random temporary password like "Kp7m-4xqr-9tzb": 12 random characters (~59 bits) in three groups, with a capital
 * and a digit so common password rules accept it. Uses the Web Crypto API (server and browser).
 */
export function generateTemporaryPassword(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  for (;;) {
    const bytes = random(32);
    const chars: string[] = [];
    for (const b of bytes) {
      if (b >= 248) continue; // 248 = 31 × 8: no modulo bias
      chars.push(ALPHABET[b % ALPHABET.length]);
      if (chars.length === 12) break;
    }
    if (chars.length < 12 || !chars.some((c) => /[2-9]/.test(c)) || !chars.some((c) => /[a-z]/.test(c))) continue;
    const letter = chars.findIndex((c) => /[a-z]/.test(c));
    chars[letter] = chars[letter].toUpperCase();
    return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
  }
}

export interface RolePreset {
  id: "driver" | "mechanic" | "dispatcher" | "office";
  label: string;
  role: AppRole;
  jobTitle: string;
  /** What they will see first after signing in. */
  lands: string;
}

/** Practical starting points; the role (and its permissions in Settings → Roles) is what grants access. */
export const ROLE_PRESETS: RolePreset[] = [
  { id: "driver", label: "Driver", role: "driver", jobTitle: "Driver", lands: "My Day (their loads, tickets and notices) — built for a phone" },
  { id: "mechanic", label: "Mechanic", role: "mechanic", jobTitle: "Mechanic", lands: "Maintenance (work orders and the shop)" },
  { id: "dispatcher", label: "Dispatcher", role: "dispatcher", jobTitle: "Dispatcher", lands: "Dispatch (the board and Plan the day)" },
  { id: "office", label: "Office employee", role: "office", jobTitle: "Office", lands: "Command Center (quotes, orders, tickets, billing)" },
];

/**
 * Where a person starts after signing in, from their verified role and permissions (read on the server, never from
 * the browser). Falls back to the Command Center when the role's usual page is not open to them.
 */
export function homePathFor(role: AppRole | null | undefined, permissions: readonly string[]): string {
  const has = (p: string) => permissions.includes(p);
  if (role === "driver" && has("driver.portal")) return "/driver";
  if (role === "mechanic" && has("maintenance.view")) return "/maintenance";
  if (role === "dispatcher" && has("dispatch.view")) return "/dispatch";
  return "/command-center";
}

export const PASSWORD_RULES = [
  "At least 10 characters",
  "Not your username",
  "Not the temporary password you were given",
] as const;

/** First problem with a new password, or null. The provider applies its own rules too. */
export function passwordProblem(password: string, confirm: string, username: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 72) return "Use at most 72 characters.";
  if (username && password.toLowerCase().includes(username.toLowerCase())) return "Do not use your username in your password.";
  if (password !== confirm) return "The two passwords do not match.";
  return null;
}

export interface InstructionInput {
  personName: string;
  companyName: string;
  username: string;
  loginUrl: string;
  /** Present only in the "with password" package the administrator explicitly asked for. */
  temporaryPassword?: string;
  expiresAt: string;
  kind: "employee" | "portal";
}

/** Plain-text instructions for copying (the password only when explicitly included). */
export function instructionsText(i: InstructionInput, expiresLabel: string): string {
  const lines = [
    `${i.companyName} — your ${i.kind === "portal" ? "customer portal" : "Taviron"} sign-in`,
    "",
    `Hello ${i.personName},`,
    "",
    `1. Open ${i.loginUrl}`,
    `2. Username: ${i.username}`,
    i.temporaryPassword
      ? `3. Temporary password: ${i.temporaryPassword}`
      : "3. Temporary password: given to you separately by your administrator",
    "4. Choose your own password when asked. Only you will know it.",
    "",
    `The temporary password stops working ${expiresLabel}. If it has expired or you forgot your password, ask ${i.companyName} for a new sign-in sheet.`,
    "Keep your password private. Do not share your sign-in with anyone.",
  ];
  return lines.join("\n");
}

/** The status words an administrator sees, from the verified state (never the password). */
export function signInStatus(s: { status: "setup_required" | "complete"; expired: boolean; active: boolean; banned: boolean; lastSignInAt: string | null; completedAt: string | null }): { label: string; tone: "gray" | "amber" | "green" | "blue" | "critical-soft" } {
  if (!s.active) return { label: "Turned off", tone: "gray" };
  if (s.status === "setup_required") return s.expired ? { label: "Setup expired", tone: "critical-soft" } : { label: "Setup required", tone: "amber" };
  if (s.lastSignInAt && s.completedAt && s.lastSignInAt > s.completedAt) return { label: "Active", tone: "green" };
  return { label: "First sign-in completed", tone: "blue" };
}

