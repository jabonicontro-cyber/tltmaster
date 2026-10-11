// The two emails a website demo request or contact message triggers. Plain
// text plus a branded HTML version of the same content; no promised response
// time, no pricing or offers. Pure functions so the wording is tested; sending
// and recording happen in src/server/leads/notify.ts.
import { renderEmailHtml } from "@/lib/email/html";

export interface LeadForEmail {
  kind: "demo" | "contact";
  name: string;
  email: string;
  company_name: string;
  phone: string;
  truck_count: number | null;
  base_count: number | null;
  message: string;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name.trim();

/** To the prospect: confirms receipt and that the team will follow up. */
export function confirmationEmail(lead: LeadForEmail): { subject: string; text: string; html: string } {
  const what = lead.kind === "demo" ? "demo request" : "message";
  const subject = lead.kind === "demo" ? "We received your Taviron demo request" : "We received your message to Taviron";
  const greeting = `Hello ${firstName(lead.name)},`;
  const thanks = `Thank you — your ${what} reached the Taviron team${lead.company_name ? ` (${lead.company_name})` : ""}.`;
  const next = lead.kind === "demo"
    ? "We will follow up by email to arrange a walkthrough. The demo is free and uses fictional data."
    : "We will reply by email.";
  const why = "You received this email because this address was entered on the Taviron website. If that was not you, you can ignore it.";
  return {
    subject,
    text: [greeting, "", thanks, next, "", why, "", "— The Taviron team"].join("\n"),
    html: renderEmailHtml({ preheader: thanks, heading: subject, paragraphs: [greeting, thanks, next, "— The Taviron team"], footer: why }),
  };
}

/** To the Taviron team: every detail of the lead, with a link to it. */
export function notificationEmail(lead: LeadForEmail, opts: { leadUrl: string; created: boolean }): { subject: string; text: string; html: string } {
  const label = lead.kind === "demo" ? "Demo request" : "Contact message";
  const intro = `${opts.created ? "New" : "Repeat"} ${label.toLowerCase()} from the website.`;
  const details: Array<[string, string]> = [
    ["Name", lead.name],
    ["Email", lead.email],
    ["Company", lead.company_name],
    ["Phone", lead.phone],
  ];
  if (lead.kind === "demo") details.push(["Hauling trucks", String(lead.truck_count ?? "")], ["Dispatch bases", String(lead.base_count ?? "")]);
  details.push([lead.kind === "demo" ? "Would most like to improve" : "Message", lead.message]);
  const lines = [
    intro,
    "",
    `Name: ${lead.name}`,
    `Email: ${lead.email}`,
    `Company: ${lead.company_name || "—"}`,
    `Phone: ${lead.phone || "—"}`,
  ];
  if (lead.kind === "demo") {
    lines.push(`Hauling trucks: ${lead.truck_count ?? "—"}`, `Dispatch bases: ${lead.base_count ?? "—"}`);
  }
  lines.push("", lead.kind === "demo" ? "What they would most like Taviron to improve:" : "Message:", lead.message || "—", "", `Open the lead: ${opts.leadUrl}`);
  const subject = `${label}: ${lead.company_name || lead.name}${opts.created ? "" : " (sent again)"}`;
  return {
    subject,
    text: lines.join("\n"),
    html: renderEmailHtml({
      preheader: intro,
      heading: subject,
      paragraphs: [intro],
      details,
      action: { label: "Open the lead", url: opts.leadUrl },
      footer: "Sent to the Taviron team inbox (LEAD_NOTIFY_EMAIL) for a form submitted on the Taviron website.",
    }),
  };
}
