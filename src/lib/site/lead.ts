import { z } from "zod";

const text = (max: number, label: string) => z.string().trim().max(max, `${label} must be ${max} characters or fewer.`);

/** A whole number typed into a form field, or null when left empty. */
const count = (min: number, max: number, label: string) =>
  z.preprocess(
    (v) => (v === undefined || v === null || (typeof v === "string" && v.trim() === "") ? null : typeof v === "string" ? v.trim() : v),
    z.union([
      z.null(),
      z.coerce.number({ error: `Enter the number of ${label}.` }).int(`Enter a whole number of ${label}.`).min(min, `Enter at least ${min}.`).max(max, `Enter at most ${max.toLocaleString("en-US")}.`),
    ]),
  );

/**
 * The demo request and contact forms. Checked again by the database. A demo
 * request needs the company, the number of hauling trucks and of dispatch bases.
 */
export const leadSchema = z
  .object({
    kind: z.enum(["demo", "contact"]),
    name: text(120, "Name").min(1, "Enter your full name."),
    email: z.string().trim().toLowerCase().max(254, "Email is too long.").pipe(z.email("Enter a valid email address.")),
    company_name: text(160, "Company"),
    phone: text(40, "Phone").regex(/^[0-9+().\-\s]*$/, "Use digits, spaces and + ( ) - only."),
    truck_count: count(0, 100_000, "hauling trucks"),
    base_count: count(1, 1_000, "dispatch bases"),
    message: text(4000, "Message"),
    source_path: z.string().max(200).regex(/^\/[a-z-]*$/).catch("/"),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "demo") {
      if (!v.company_name) ctx.addIssue({ code: "custom", path: ["company_name"], message: "Enter your company name." });
      if (v.truck_count === null) ctx.addIssue({ code: "custom", path: ["truck_count"], message: "Enter the number of hauling trucks (0 if none)." });
      if (v.base_count === null) ctx.addIssue({ code: "custom", path: ["base_count"], message: "Enter the number of dispatch bases." });
    }
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
