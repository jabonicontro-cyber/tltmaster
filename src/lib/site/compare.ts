// Comparison pages for the public website (master plan B88: "honest comparison content"). They compare Taviron with
// ways of working, never with a named competitor: no claims about another company's product. Every Taviron row names
// the published catalog feature it rests on (tests/unit/site-pages.test.ts), and what Taviron does not do yet is said.

export interface CompareRow {
  /** The job, in the customer's words. */
  topic: string;
  /** How it usually goes with the other way of working (general practice, not a product claim). */
  other: string;
  /** What Taviron does today. */
  taviron: string;
  /** Published catalog feature behind the Taviron cell. */
  feature: string;
}

export interface Comparison {
  slug: "spreadsheets" | "dispatch-only";
  /** Menu label. */
  label: string;
  title: string;
  description: string;
  intro: string;
  otherLabel: string;
  rows: CompareRow[];
  /** When the other way is the better fit: said plainly. */
  fairPoints: string[];
  /** What Taviron does not do yet, relevant to this comparison. */
  notYet: string[];
}

export const COMPARISONS: Comparison[] = [
  {
    slug: "spreadsheets",
    label: "Taviron vs spreadsheets and whiteboards",
    title: "Taviron vs spreadsheets, whiteboards and group texts.",
    description: "What changes when a hauling company moves its orders, dispatch, tickets and shop from spreadsheets, a whiteboard and group texts to one connected system.",
    intro: "Most hauling companies start with a spreadsheet for orders, a whiteboard for tomorrow's trucks, a group text for drivers and a box of paper tickets. It works until one person is out, a truck goes down, or billing waits on a ticket nobody can find.",
    otherLabel: "Spreadsheets and whiteboards",
    rows: [
      { topic: "What needs attention today", other: "Spread across the board, texts and someone's memory.", taviron: "One Command Center lists urgent orders, unassigned loads, missing tickets and trucks out of service, each with an owner.", feature: "command-center" },
      { topic: "Planning tomorrow", other: "Rewritten by hand; rules live in the dispatcher's head.", taviron: "Plan the day weighs every open load against the whole fleet and checks qualifications, capacity, time off and the shop first.", feature: "plan-the-day" },
      { topic: "Assigning a truck", other: "Nothing stops a truck that was reported with bad brakes.", taviron: "Every assignment is checked against service status, open safety reports, documents and time conflicts, with the reason when it is refused.", feature: "smart-dispatch" },
      { topic: "Telling drivers", other: "Group texts and phone calls; changes get missed.", taviron: "Each driver sees their own assignments and job instructions on the phone and can report a delay or breakdown.", feature: "driver-portal" },
      { topic: "Delivery tickets", other: "Paper in the truck, retyped at the office, sometimes lost.", taviron: "Tickets with photos start on the driver's phone and are reviewed beside their order; corrections keep a history.", feature: "delivery-tickets" },
      { topic: "Getting to an invoice", other: "Someone checks every ticket against the order before billing.", taviron: "Only fully delivered, verified orders reach billing, with invoice drafts prepared for review and never sent on their own.", feature: "billing" },
      { topic: "The shop", other: "A separate notebook or spreadsheet that dispatch never sees.", taviron: "Work orders, preventive schedules and restrictions sit on the same truck record dispatch uses.", feature: "maintenance" },
      { topic: "Who did what", other: "Cells get overwritten; nobody knows who changed a quantity.", taviron: "Key changes to assignments, tickets and billing handoffs are kept with who made them and when.", feature: "company-controls" },
    ],
    fairPoints: [
      "A spreadsheet costs nothing and everyone already knows it. For a handful of trucks and one person doing everything, it may be enough.",
      "Moving takes some setup: your customers, materials, trucks and people need to be entered or imported, and the team needs a short walkthrough.",
    ],
    notYet: ["GPS tracking of trucks", "Hours of service from an ELD", "Sending invoices or payments (drafts are prepared for your own system)"],
  },
  {
    slug: "dispatch-only",
    label: "All-in-one vs dispatch-only software",
    title: "One connected system, or a dispatch tool plus everything else.",
    description: "The difference between a dispatch-only tool and one system that also runs the shop, people and time off, and billing readiness for a hauling company.",
    intro: "Dispatch tools are good at the board and the tickets. But the reasons a load goes wrong often start somewhere else: a truck in the shop, a driver on vacation, an expired document. When those live in other systems, dispatch finds out late.",
    otherLabel: "Dispatch-only tool",
    rows: [
      { topic: "Truck in the shop", other: "Maintenance lives in another system or on paper, so dispatch has to be told.", taviron: "A shop visit or safety-critical defect restricts the truck where dispatch assigns it, until an authorized person clears it.", feature: "maintenance" },
      { topic: "How long a repair takes", other: "A guess, if anyone is asked.", taviron: "Work orders show time estimates that learn from your own shop's recorded labour, labelled with how much history they rest on.", feature: "maintenance-estimates" },
      { topic: "Driver availability", other: "Time off is kept elsewhere and checked by memory.", taviron: "Approved time off is part of every assignment check, so a driver on vacation is never proposed.", feature: "people" },
      { topic: "Expired documents", other: "Tracked in a separate file, if at all.", taviron: "Driver qualifications and truck documents with expiry dates are checked before an assignment.", feature: "fleet" },
      { topic: "People and time off", other: "A separate HR tool or spreadsheet.", taviron: "Employees, time off requests and balances in the same system as dispatch.", feature: "people" },
      { topic: "Talking to the team", other: "Texts and calls outside the record.", taviron: "Conversations, announcements and operational alerts linked to the loads and trucks they are about.", feature: "communications" },
      { topic: "How fast the office works", other: "Hard to know without a stopwatch.", taviron: "Time to plan tomorrow and days from delivery to billing-ready, measured from your own use and never estimated.", feature: "speed-metrics" },
    ],
    fairPoints: [
      "If you already run a maintenance system and HR tool you are happy with, a dispatch-only tool may slot in with less change.",
      "Some dispatch tools connect to GPS and electronic logs today; Taviron does not yet.",
    ],
    notYet: ["GPS tracking of trucks", "Hours of service from an ELD", "Scale-house electronic tickets"],
  },
];

export const COMPARE_PATHS = COMPARISONS.map((c) => `/compare/${c.slug}`);
