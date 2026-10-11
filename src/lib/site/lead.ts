import { z } from "zod";

export const FLEET_SIZES = ["1–5 trucks", "6–15 trucks", "16–40 trucks", "41–100 trucks", "More than 100 trucks"] as const;

const text = (max: number, label: string) => z.string().trim().max(max, `${label} must be ${max} characters or fewer.`);

/** The demo request and contact forms. Checked again by the database. */
export const leadSchema = z
  .object({
    kind: z.enum(["demo", "contact"]),
    name: text(120, "Name").min(1, "Enter your name."),
    email: z.string().trim().toLowerCase().max(254, "Email is too long.").pipe(z.email("Enter a valid email address.")),
    company_name: text(160, "Company"),
    phone: text(40, "Phone").regex(/^[0-9+().\-\s]*$/, "Use digits, spaces and + ( ) - only."),
    role_title: text(120, "Role"),
    fleet_size: z.union([z.enum(FLEET_SIZES), z.literal("")]),
    message: text(4000, "Message"),
    source_path: z.string().max(200).regex(/^\/[a-z-]*$/).catch("/"),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "demo" && !v.company_name) ctx.addIssue({ code: "custom", path: ["company_name"], message: "Enter your company name." });
    if (v.kind === "contact" && v.message.length < 10) ctx.addIssue({ code: "custom", path: ["message"], message: "Tell us a little more (at least 10 characters)." });
  });
export type LeadInput = z.infer<typeof leadSchema>;

/** Minimum time a person takes to fill the form; faster submissions are automated. */
export const MIN_FILL_MS = 2500;

/**
 * Spam signals that are dropped silently (the sender is told it worked, and
 * nothing is stored): the hidden "website" field filled in, a form submitted
 * faster than a person can type (when the page measured it), or a message
 * that is mostly links.
 */
export function looksAutomated(input: { website?: unknown; elapsed_ms?: unknown; message?: unknown }): boolean {
  if (typeof input.website === "string" && input.website.trim() !== "") return true;
  if (input.elapsed_ms !== undefined) {
    const elapsed = Number(input.elapsed_ms);
    if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) return true;
  }
  const links = typeof input.message === "string" ? (input.message.match(/https?:\/\//gi) ?? []).length : 0;
  return links > 3;
}

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] ??= issue.message;
  }
  return out;
}
