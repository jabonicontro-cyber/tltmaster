// "One load, start to finish" (master plan UX16, owner's pick 2026-11-04): the home page follows one load from the quote
// to the invoice, each step on a real screen of the app. Every chapter names the published catalog feature its words
// and its screen come from (src/lib/site/features.ts); tests/unit/site-load-story.test.ts keeps it that way, so the
// story never shows a screen or a claim the website may not make.

export interface LoadStoryChapter {
  /** Short step name, shown above the chapter's heading. */
  step: string;
  title: string;
  body: string;
  points?: string[];
  /** The published catalog feature the chapter describes. */
  feature: string;
  /** Its screenshot (src/lib/site/screenshots.json). */
  shot: string;
}

export const LOAD_STORY: LoadStoryChapter[] = [
  {
    step: "Quote",
    title: "Priced from your own wins and losses.",
    body: "The quote starts from the customer's price list. For every priced line, Taviron shows what your own won and lost quotes charged and suggests a rate with its reasoning. The person sets the price.",
    feature: "pricing-help",
    shot: "pricing-help",
  },
  {
    step: "Order",
    title: "Accepted once, it becomes the order.",
    body: "The accepted quote becomes its order with the accepted prices, once. From then on the order shows where it really stands: loads planned, delivered so far from accepted tickets, and whether it is ready to bill.",
    feature: "orders",
    shot: "order",
  },
  {
    step: "Dispatch",
    title: "Assigned with the rules already checked.",
    body: "Loads are planned against the order and checked before a truck or driver is committed. When something does not fit, Taviron says why.",
    points: [
      "Service status, open safety reports, recorded capacity, driver qualifications and time conflicts are checked on every assignment.",
      "Smart Dispatch suggests a truck and driver for each open load, with its reasons and alternatives. Nothing is assigned until a dispatcher approves.",
      "Confirmed orders without a delivery date wait in a queue instead of disappearing.",
    ],
    feature: "smart-dispatch",
    shot: "dispatch",
  },
  {
    step: "Deliver",
    title: "The ticket starts in the truck.",
    body: "The driver sees the load on the phone with the site, the truck and the planned tons, enters the delivery ticket with photos, and reports a delay or a breakdown that dispatch sees at once. Without signal, the ticket waits on the phone and sends itself when signal returns.",
    feature: "driver-portal",
    shot: "driver",
  },
  {
    step: "Review",
    title: "Checked beside its order.",
    body: "The office reviews each ticket beside the order it belongs to, and enters paper tickets and scans in the same place.",
    points: [
      "Corrections become new revisions with a reason. Nothing is overwritten.",
      "Clean tickets can be accepted together, in one step.",
    ],
    feature: "delivery-tickets",
    shot: "tickets",
  },
  {
    step: "Bill",
    title: "Billed from verified work, once someone approves.",
    body: "An order reaches billing only when its deliveries are verified in full, so partly delivered orders stay out. The invoice draft comes from those deliveries, and nothing is issued or emailed until someone in the office approves it.",
    points: [
      "Bill your way: Taviron issues the invoice once someone approves it, or ready orders are handed off to your own accounting. QuickBooks Online sync is coming soon, not available yet.",
      "Payments are recorded against the invoice, and what each customer owes is shown by how late it is.",
    ],
    feature: "invoicing",
    shot: "invoicing",
  },
];
