// The two emails a website demo request or contact message triggers. Plain
// text, no promised response time, no pricing or offers. Pure functions so the
// wording is tested; sending and recording happen in src/server/leads/notify.ts.

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
export function confirmationEmail(lead: LeadForEmail): { subject: string; text: string } {
  const what = lead.kind === "demo" ? "demo request" : "message";
  return {
    subject: lead.kind === "demo" ? "We received your Taviron demo request" : "We received your message to Taviron",
    text: [
      `Hello ${firstName(lead.name)},`,
      "",
      `Thank you — your ${what} reached the Taviron team${lead.company_name ? ` (${lead.company_name})` : ""}.`,
      lead.kind === "demo"
        ? "We will follow up by email to arrange a walkthrough. The demo is free and uses fictional data."
        : "We will reply by email.",
      "",
      "You received this email because this address was entered on the Taviron website. If that was not you, you can ignore it.",
      "",
      "— The Taviron team",
    ].join("\n"),
  };
}

/** To the Taviron team: every detail of the lead, with a link to it. */
export function notificationEmail(lead: LeadForEmail, opts: { leadUrl: string; created: boolean }): { subject: string; text: string } {
  const label = lead.kind === "demo" ? "Demo request" : "Contact message";
  const lines = [
    `${opts.created ? "New" : "Repeat"} ${label.toLowerCase()} from the website.`,
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
  return { subject: `${label}: ${lead.company_name || lead.name}${opts.created ? "" : " (sent again)"}`, text: lines.join("\n") };
}
