// The public website's platform areas and solutions (docs/MARKETING.md). Each area groups published features from the
// catalog (src/lib/site/features.ts) and adds the workflow, the controls and the "not yet" that belong to it. Every
// statement here describes behaviour that exists today; anything still being built is said to be not yet available.
// tests/unit/site-areas.test.ts checks that areas only use published features and that every page is public.

import type { Tier } from "./pricing";

export interface PlatformArea {
  slug: "dispatch" | "fleet" | "customers" | "intelligence" | "automation" | "control";
  /** Navigation label. */
  label: string;
  title: string;
  /** Short line for menus and cards. */
  summary: string;
  problem: string;
  value: string;
  /** The real workflow, step by step. */
  workflow: Array<{ step: string; detail: string }>;
  /** Restrictions, approvals and what people still decide. */
  controls: string[];
  /** Published catalog features shown on the page, in order. */
  features: string[];
  /** Plainly stated: not built or not switched on yet. */
  notYet: string[];
  /** Where it connects (other area slugs). */
  connects: PlatformArea["slug"][];
}

export const AREAS: PlatformArea[] = [
  {
    slug: "dispatch",
    label: "Smart Dispatch & Load Management",
    title: "Dispatch that checks the rules before it suggests anything.",
    summary: "Loads, assignments and the day's plan, with every constraint checked first.",
    problem: "A dispatcher juggles requested dates, truck capacity, driver qualifications, time off and the shop schedule in their head — and a missed detail shows up as a late or refused load.",
    value: "Smart Dispatch and Plan the day only propose trucks and drivers that pass the company's hard rules, explain every load they cannot cover, and leave the decision to the dispatcher.",
    workflow: [
      { step: "Confirmed order waits to be scheduled", detail: "Orders without a delivery date sit in Needs scheduling until someone picks a day, so nothing is forgotten." },
      { step: "Loads are planned", detail: "The order's quantity becomes loads on its days; the load builder proposes the split and adds loads only after approval." },
      { step: "Smart Dispatch proposes", detail: "Each suggestion pairs a truck, trailer and driver that pass service status, open safety reports, capacity, qualifications, expirations, time off and time conflicts." },
      { step: "The dispatcher approves", detail: "Approval re-checks the assignment against the latest data; a change since the suggestion stops it with the reason." },
      { step: "The driver delivers", detail: "The assignment appears on the driver's phone; the delivery ticket with photos goes to the office for review." },
    ],
    controls: [
      "Suggestions never assign on their own: a dispatcher approves or rejects each one.",
      "A truck with an open safety-critical defect, a shop visit or an expired document is excluded, with the reason shown.",
      "Hours of service are not tracked (no ELD connection), so every proposal says the dispatcher must confirm them.",
    ],
    features: ["smart-dispatch", "plan-the-day", "delivery-tickets"],
    notYet: ["Hours of service from an ELD", "Travel distance and drive time in plans", "GPS tracking of trucks"],
    connects: ["fleet", "customers", "intelligence"],
  },
  {
    slug: "fleet",
    label: "Fleet & Maintenance",
    title: "The shop and dispatch work from the same truck record.",
    summary: "Equipment records, work orders, preventive schedules and restrictions dispatch respects.",
    problem: "A truck reported with bad brakes gets assigned anyway because the note never reached dispatch — or a service comes due without anyone noticing.",
    value: "A driver's report becomes a work order; a safety-critical defect restricts the truck until an authorized inspection clears it, and dispatch cannot assign it in the meantime.",
    workflow: [
      { step: "A driver reports a problem", detail: "Equipment and breakdown reports from the phone reach the dispatcher's queue and can open a work order." },
      { step: "The shop works the order", detail: "Status, urgency, findings, labor, parts and costs are kept on the work order and in the truck's history." },
      { step: "Safety-critical work restricts the truck", detail: "Until an authorized person clears it after inspection, Smart Dispatch and the board exclude it." },
      { step: "Preventive schedules come due", detail: "Schedules by days or miles flag overdue service and create one work order each time, however often they run." },
    ],
    controls: [
      "Only people with the clearance permission can release a restricted truck.",
      "Shop dates are checked by dispatch and Plan the day before anything is proposed.",
      "Vehicle documents carry expiry dates that dispatch checks under the company's policy.",
    ],
    features: ["maintenance", "fleet"],
    notYet: ["Parts inventory and purchasing", "Telematics readings (miles are entered, not read from the truck)"],
    connects: ["dispatch", "intelligence"],
  },
  {
    slug: "customers",
    label: "Customer & Order Management",
    title: "From the first quote to a delivery ready to bill.",
    summary: "Customers, price lists, quotes, orders, tickets and billing readiness, connected.",
    problem: "A quote lives in email, the order in a spreadsheet and the delivery tickets in a folder — so what was promised, delivered and billed never quite match.",
    value: "One chain of records: the accepted quote becomes its order once, deliveries are verified against it, and only fully verified orders become ready to bill.",
    workflow: [
      { step: "Price it", detail: "Standard and customer-specific price lists with effective dates; quotes are versioned PDFs and issued versions are locked." },
      { step: "Accept it", detail: "An accepted quote converts to one order, with its prices — a retry or double click does not make a second." },
      { step: "Deliver it", detail: "Loads are dispatched and every delivery ticket is reviewed beside its order; corrections are new revisions." },
      { step: "Hand it to billing", detail: "Differences between ordered and delivered quantities must be acknowledged; ready orders are handed off to accounting in batches with an audit trail." },
    ],
    controls: [
      "Accepted prices on a quote-linked order cannot be edited.",
      "Billing readiness comes only from accepted tickets; nothing is approved for billing automatically.",
      "Invoice drafts are previews: nothing is issued, sent or exported from Taviron.",
    ],
    features: ["orders", "delivery-tickets", "billing"],
    notYet: ["Issuing invoices and recording payments", "An accounting integration", "Quote emails until an email provider is configured"],
    connects: ["dispatch", "intelligence"],
  },
  {
    slug: "intelligence",
    label: "Operational Intelligence & AI",
    title: "Know what's happening. Understand why. Decide what comes next.",
    summary: "What needs attention, why, and the evidence behind it — with people deciding.",
    problem: "Problems hide across the board, the shop and the ticket pile until a customer calls.",
    value: "Taviron reads the same records the work happens in and surfaces what needs attention with the reason and the record to open — measured, never guessed.",
    workflow: [
      { step: "See what needs attention", detail: "The Command Center ranks urgent orders, loads without a truck, assignment problems, missing tickets, billing blocks and equipment out of service, each with its owner." },
      { step: "Understand why", detail: "Every item names its reason — the rule a load breaks, the ticket that is missing — and links to the record." },
      { step: "Compare the options", detail: "Plan the day shows the same day planned for different priorities, with the trade-offs and every load it cannot cover explained." },
      { step: "Decide", detail: "People approve assignments, accept tickets and hand off billing. Reports measure what happened from recorded loads, tickets and orders." },
    ],
    controls: [
      "Suggestions and plans propose; an authorized person approves every consequential step.",
      "Where data is missing — hours of service, distances, costs — the screens say so instead of estimating.",
      "Estimated revenue is labelled as an estimate; margin is not shown without recorded costs.",
    ],
    features: ["command-center", "plan-the-day", "reports"],
    notYet: [
      "AI assistance is built but not switched on: Ask Taviron (read-only questions about your own records) and AI explanations of a plan need a configured provider and a passing evaluation first.",
      "When switched on, AI only reads and drafts; it never assigns, sends, bills or changes records.",
    ],
    connects: ["dispatch", "fleet", "customers"],
  },
  {
    slug: "automation",
    label: "Automation & Connected Workflows",
    title: "The next step reaches the right person, with the record attached.",
    summary: "Alerts, escalations, approvals and handoffs between the office, dispatch, the shop and drivers.",
    problem: "Hand-offs between the office, dispatch, the shop and drivers depend on someone remembering to call.",
    value: "Taviron routes the next step to the person who can act on it, escalates what is urgent, and records who approved what — without acting on its own.",
    workflow: [
      { step: "An event happens", detail: "An urgent order is flagged, a driver reports a delay or breakdown, a ticket arrives, a truck goes out of service." },
      { step: "The right people are told", detail: "Operational alerts carry a priority; urgent orders escalate after the company's time limit until someone acknowledges them." },
      { step: "Work stays connected", detail: "Job workspaces are linked to dispatch; messages and announcements can require acknowledgment." },
      { step: "A person approves", detail: "Ticket acceptance, billing handoffs and time-off approvals need an authorized person; a failed step stays visible in the Command Center." },
    ],
    controls: [
      "Acknowledging an alert is not resolving it: critical items stay visible until resolved.",
      "Handoffs can be safely reversed, with the reason recorded.",
      "Nothing is sent to customers or drivers outside the app without explicit configuration.",
    ],
    features: ["communications", "driver-portal", "billing"],
    notYet: ["Text-message and push delivery outside the app", "A general rules engine for custom automations"],
    connects: ["dispatch", "customers", "control"],
  },
  {
    slug: "control",
    label: "Integrations, Reporting & Control",
    title: "Who can see and do what, and a record of what was done.",
    summary: "Roles and permissions, company isolation, activity history, reports and imports.",
    problem: "As a company grows, the question shifts from whether the work got done to who did it, who may see it and whether the numbers can be trusted.",
    value: "Permissions per role, each company's data separated in the database, an audit trail of key changes and reports measured from your own records.",
    workflow: [
      { step: "Set up the company", detail: "Roles, permissions, settings and the company setup checklist." },
      { step: "Bring your data", detail: "Customers, equipment and people come in through a reviewed spreadsheet import during onboarding." },
      { step: "Work with permissions", detail: "Every page and action checks the person's role on the server and again in the database." },
      { step: "Review what happened", detail: "Key changes keep who made them; reports measure operations and revenue from recorded data." },
    ],
    controls: [
      "Every company's records are separated by row-level security in the database, not just hidden on screen.",
      "Money in reports is shown only to people with billing access.",
      "Personal data is used only to run the service (see the privacy notice).",
    ],
    features: ["company-controls", "reports", "people"],
    notYet: ["Accounting, ELD and payment integrations", "Self-service data export"],
    connects: ["intelligence", "automation"],
  },
];

export function areaBySlug(slug: string): PlatformArea | undefined {
  return AREAS.find((a) => a.slug === slug);
}

export interface Segment {
  slug: "small-fleets" | "growing-fleets" | "enterprise";
  label: string;
  title: string;
  summary: string;
  intro: string;
  needs: Array<{ title: string; text: string }>;
  scenario: { title: string; steps: string[]; note: string };
  /** Plan keys that usually fit (src/lib/site/pricing.ts). */
  plans: Tier["key"][];
  areas: PlatformArea["slug"][];
  notYet: string[];
}

export const SEGMENTS: Segment[] = [
  {
    slug: "small-fleets",
    label: "Small fleets",
    title: "Run the day from one screen, not five.",
    summary: "Daily dispatch, equipment and customers in one organized workspace.",
    intro: "When the owner also dispatches, simplicity matters more than options. Taviron keeps the day's loads, the trucks that can run and the customers' orders together, with good defaults.",
    needs: [
      { title: "Today's loads at a glance", text: "The board shows what is assigned, what is not, and what changed." },
      { title: "Trucks you can actually send", text: "Service status, shop dates and safety reports are checked before a truck is suggested." },
      { title: "Tickets without the paper chase", text: "Drivers submit tickets with photos; the office reviews them beside the order." },
    ],
    scenario: {
      title: "Assign a load while checking the truck and the driver",
      steps: [
        "Open the day's board and pick a load without a truck.",
        "Smart Dispatch suggests a truck and driver that pass the rules — and lists the trucks it left out and why.",
        "Approve the suggestion; the assignment is re-checked and appears on the driver's phone.",
      ],
      note: "Shown in the demo company with fictional data.",
    },
    plans: ["essential"],
    areas: ["dispatch", "fleet", "customers"],
    notYet: [],
  },
  {
    slug: "growing-fleets",
    label: "Growing fleets",
    title: "More trucks, more customers — the same clear picture.",
    summary: "Connected workflows and early warnings as the operation gets busier.",
    intro: "With more trucks and more customer commitments, problems no longer fit on a whiteboard. Taviron connects dispatch, the shop and the office so a problem in one shows up where it matters.",
    needs: [
      { title: "Commitments you can keep", text: "Urgent orders and requested dates lead the plan; orders without a date are never lost." },
      { title: "The shop and dispatch in step", text: "A restricted truck drops out of dispatch the moment it is restricted." },
      { title: "Problems before the phone rings", text: "The Command Center ranks what needs attention today, with its owner." },
    ],
    scenario: {
      title: "A maintenance problem threatens a scheduled delivery",
      steps: [
        "A driver reports a brake problem; the shop opens a safety-critical work order from the report, which restricts the truck.",
        "The truck's assigned loads appear in the Command Center as assignment problems.",
        "The dispatcher compares the trucks and drivers that can still take each load and approves a reassignment.",
      ],
      note: "Shown in the demo company with fictional data; the dispatcher makes every assignment.",
    },
    plans: ["growth", "professional"],
    areas: ["dispatch", "fleet", "intelligence", "automation"],
    notYet: [],
  },
  {
    slug: "enterprise",
    label: "Enterprise operations",
    title: "Consistent rules across a larger organization.",
    summary: "Role-based access, approvals, auditability and reporting for complex operations.",
    intro: "Larger operations need the same rules applied everywhere, people seeing only what their role allows, and a record of who decided what.",
    needs: [
      { title: "Role-based access", text: "Permissions per role, checked on the server and in the database for every action." },
      { title: "Approval controls", text: "Assignments, ticket acceptance, billing handoffs and time off need an authorized person." },
      { title: "Auditability and reporting", text: "Key changes keep who made them; reports are measured from recorded data." },
    ],
    scenario: {
      title: "An operational risk is reviewed by the right manager",
      steps: [
        "An urgent order is flagged and not acknowledged within the company's time limit.",
        "It escalates in the Command Center until someone with the permission acknowledges it.",
        "The manager assigns the follow-up to a person; the history shows who did what and when.",
      ],
      note: "Shown in the demo company with fictional data.",
    },
    plans: ["enterprise"],
    areas: ["control", "automation", "intelligence"],
    notYet: [
      "Multiple dispatch bases with per-person base access are built and shown in the plan demos, but not yet generally available — ask us about your locations.",
      "Single sign-on and accounting integrations are not available yet.",
    ],
  },
];

export function segmentBySlug(slug: string): Segment | undefined {
  return SEGMENTS.find((s) => s.slug === slug);
}

export const AREA_PATHS = AREAS.map((a) => `/platform/${a.slug}`);
export const SEGMENT_PATHS = SEGMENTS.map((s) => `/solutions/${s.slug}`);
