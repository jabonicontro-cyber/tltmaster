// General help for customers using a company's portal (B66). These describe only what the portal itself does, so
// they are true for every company; company policies (pricing, delivery rules, payment terms) are written and
// published by each company in its own portal help articles, never here.
//
// Each article says what THIS portal shows (walkthrough 2026-11-14, W1: help said invoices were not shown on a portal
// that showed them). The answers follow the company's portal switches; when a switch is not known (someone signed out
// reading a public help page) the answer is worded so it is true either way.

import type { PortalFeatures } from "@/lib/portal";

export type PortalGeneralArticle = { id: string; title: string; category: string; body: string };

/** The portal switches an answer depends on; undefined = not known to the reader (signed out). */
export type PortalHelpFeatures = Partial<PortalFeatures>;

const CATEGORY = "Using This Portal";

/** The general articles for this portal, in reading order. Articles for switched-off sections are left out. */
export function portalGeneralHelp(f: PortalHelpFeatures = {}, say: (text: string) => string = (t) => t): PortalGeneralArticle[] {
  const out: PortalGeneralArticle[] = [];
  const add = (id: string, title: string, body: string) => out.push({ id, title: say(title), category: CATEGORY, body: say(body) });

  if (f.orders !== false) {
    add("order-status", "What do the order statuses mean?", [
      "Received / Confirmed: the company has your order.",
      "Scheduled: delivery dates are set. Planned deliveries show their date and time window.",
      "Delivering / Partly delivered: deliveries have started.",
      "Delivered: every planned delivery is done.",
      "On hold or Canceled: contact the company if you did not expect this.",
      "Times are planned windows, not live arrival estimates. A planned time that has passed without a recorded delivery says so.",
    ].join("\n"));
    add("delivery-confirmed", "Why does a delivery say “Being checked”?",
      "Each delivery has a ticket. The company's office checks every ticket before it counts as confirmed, so a new delivery may show as “Being checked” for a short while. Confirmed quantities are what the office has accepted.");
  }

  if (f.documents === true) {
    add("tickets", "Where are my delivery tickets?",
      "Open Tickets to see every delivery ticket, newest first. You can choose dates, and a job site when your tickets went to more than one, and download the list as a CSV file. Each ticket opens a printable copy with the date, material and quantity; each order also lists its own tickets.");
  } else if (f.documents === false) {
    add("tickets", "Where are my delivery tickets?",
      "Ticket copies are not shown in this portal. Each order shows how much was delivered; ask the company for a copy of a ticket.");
  } else {
    add("tickets", "Where are my delivery tickets?",
      "When the company shows tickets in this portal, they are under Tickets once you sign in, and on each order. Otherwise ask the company for a copy.");
  }

  if (f.booking === true) {
    add("booking", "How do I book loads?",
      "Open Book loads, choose an open day, how many loads, the time of day and where they go, then send the request. Nothing is scheduled until the company approves it; their answer appears under Your requests. You can withdraw a request while it is still waiting.");
  }

  if (f.orders === true) {
    add("job-sites", "How do I tell the company about a job site?",
      "Open Job sites to give the gate code, where to drop, a site contact and photos. The company's office checks what you send before drivers see it.");
  }

  if (f.quotes !== false) {
    add("quotes", "How do quotes work here?",
      "Use Request a Quote to tell the company what you need. They reply with a priced quote, which appears under Your Quotes. You can accept or decline it there; the company confirms your answer before anything is scheduled. A quote past its “valid until” date can no longer be accepted: ask for a new one.");
  }

  if (f.support !== false) {
    add("support", "How do I ask a question?",
      "Open Support and choose New Request. Pick the order, ticket or invoice it is about, if any. The company's reply appears in the same request.");
  }

  if (f.invoices === true) {
    add("invoices", "Where are my invoices?",
      "Open Invoices to see every invoice with what is still open and what is past due, and your account balance at the top. Each invoice opens a printable copy.");
  } else if (f.invoices === false) {
    add("invoices", "Where are my invoices?",
      "Invoices are not shown in this portal. The company sends them to you directly; contact them for a copy or a statement.");
  } else {
    add("invoices", "Where are my invoices?",
      "When the company shows invoices in this portal, they are under Invoices once you sign in, with your account balance. Otherwise the company sends them to you directly; contact them for a copy or a statement.");
  }

  add("pay", "How do I pay my invoice?",
    "Payments are not made in this portal. Payment is arranged directly with the company: contact them to ask how they accept payment or where to send it.");

  return out;
}

/** Every general article in every variant (the help search and the "no business rules" check read them all). */
export const PORTAL_GENERAL_HELP: PortalGeneralArticle[] = [
  ...portalGeneralHelp({ orders: true, quotes: true, documents: true, support: true, booking: true, invoices: true }),
  ...portalGeneralHelp({ orders: true, quotes: true, documents: false, support: true, invoices: false }).filter((a) => a.id === "tickets" || a.id === "invoices"),
  ...portalGeneralHelp({}).filter((a) => a.id === "tickets" || a.id === "invoices"),
];
