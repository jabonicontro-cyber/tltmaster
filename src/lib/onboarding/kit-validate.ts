import { forbiddenKeys, INTEGRATIONS, type KitForm } from "./kit";

export const KIT_FORMS: KitForm[] = ["welcome_email", "questionnaire", "dispatch_worksheet", "integrations", "integration_checks", "testing", "go_live", "post_launch"];
export const COMPANY_FORMS: KitForm[] = ["questionnaire", "dispatch_worksheet", "integrations", "testing", "post_launch"];

/** Shared checks before a form is sent to the database (which checks again). Returns a problem or null. */
export function kitFormProblem(form: string, data: unknown, side: "company" | "taviron", config?: Record<string, boolean>): string | null {
  if (!(KIT_FORMS as string[]).includes(form)) return "Unknown form.";
  if (side === "company" && !(COMPANY_FORMS as string[]).includes(form)) return "Taviron completes this part.";
  if (!data || typeof data !== "object" || Array.isArray(data)) return "Nothing to save.";
  if (JSON.stringify(data).length > 190_000) return "This form is too long. Shorten the longest answers.";
  if (forbiddenKeys(data).length) return "Passwords, keys, card numbers and government identifiers are never stored in onboarding forms.";
  if (form === "integration_checks" && config) {
    const items = ((data as { items?: Record<string, { status?: string }> }).items ?? {});
    for (const def of INTEGRATIONS) {
      const status = items[def.key]?.status;
      if (!status) continue;
      if (!def.available && !["unavailable", "not_needed", "not_started"].includes(status)) return `${def.name} is not available in Taviron; record it as not available or not needed, with its fallback.`;
      if (status === "verified" && def.configKey && !config[def.configKey]) return `${def.name} is not configured on this server, so it cannot be marked verified.`;
    }
  }
  return null;
}
