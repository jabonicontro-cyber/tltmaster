// General help for customers using a company's portal (B66). These describe only what the portal itself does, so
// they are true for every company; company policies (pricing, delivery rules, payment terms) are written and
// published by each company in its own portal help articles, never here.

export type PortalGeneralArticle = { id: string; title: string; category: string; body: string };

export const PORTAL_GENERAL_HELP: PortalGeneralArticle[] = [
  {
    id: "order-status",
    title: "What do the order statuses mean?",
    category: "Using This Portal",
    body: [
      "Received / Confirmed: the company has your order.",
      "Scheduled: delivery dates are set. Planned deliveries show their date and time window.",
      "Delivering / Partly delivered: deliveries have started.",
      "Delivered: every planned delivery is done.",
      "On hold or Canceled: contact the company if you did not expect this.",
      "Times are planned windows, not live arrival estimates.",
    ].join("\n"),
  },
  {
    id: "delivery-confirmed",
    title: "Why does a delivery say “Being checked”?",
    category: "Using This Portal",
    body: "Each delivery has a ticket. The company's office checks every ticket before it counts as confirmed, so a new delivery may show as “Being checked” for a short while. Confirmed quantities are what the office has accepted.",
  },
  {
    id: "quotes",
    title: "How do quotes work here?",
    category: "Using This Portal",
    body: "Use Request a Quote to tell the company what you need. They reply with a priced quote, which appears under Your Quotes. You can accept or decline it there; the company confirms your answer before anything is scheduled. A quote past its “valid until” date can no longer be accepted — request a new one.",
  },
  {
    id: "tickets",
    title: "Where are my delivery tickets?",
    category: "Using This Portal",
    body: "Open an order to see its delivery tickets. Each ticket opens a printable copy with the date, material and quantity.",
  },
  {
    id: "support",
    title: "How do I ask a question?",
    category: "Using This Portal",
    body: "Open Support and choose New Request. Pick the order it is about, if any. The company's reply appears in the same request.",
  },
  {
    id: "invoices",
    title: "Where are my invoices?",
    category: "Using This Portal",
    body: "Invoices are not shown in this portal yet. The company sends them from its accounting system; contact them for a copy or a statement.",
  },
];
