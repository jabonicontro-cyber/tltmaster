import shotData from "./screenshots.json";

// Taviron's feature catalog for the public website (docs/MARKETING.md). One entry per capability, with what it solves,
// where the app shows it, its screenshots and — kept apart on purpose — its build status and whether it may be described
// publicly. The website, the "Not yet" list and the capability checks all read from here, so a feature is described
// the same way everywhere and nothing unbuilt becomes a public claim.
//
// tests/unit/feature-catalog.test.ts keeps this honest: published features must be available, point at app pages that
// exist and at screenshots that exist; every page in the app's navigation must be covered by a feature or listed in
// NOT_MARKETED with its reason; nothing planned may be published.

export type FeatureStatus =
  /** Built and released to every company. */
  | "available"
  /** Built and working in demo companies, but needs an owner step (migration, configuration) before real use. */
  | "in_demo"
  /** Code exists but is not usable yet (for example switched off until configured). */
  | "in_development"
  /** Not built. */
  | "planned";

export type FeatureCategory = "operations" | "dispatch" | "field" | "sales" | "billing" | "fleet" | "people" | "insight" | "platform";

export interface Screenshot {
  id: string;
  file: string;
  feature: string;
  path: string;
  open?: string;
  /** Scroll this text to the top before capturing (the screen's strongest part may be below the fold). */
  scroll?: string;
  /** Open the tab with this name before capturing. */
  tab?: string;
  viewport: "desktop" | "phone";
  /** Text that must be on screen before the capture (the page has finished loading its data). */
  ready: string;
  alt: string;
  caption: string;
}

export const SCREENSHOTS: Screenshot[] = shotData.shots as Screenshot[];

export interface Feature {
  id: string;
  name: string;
  category: FeatureCategory;
  /** The operational problem, in the customer's words. */
  problem: string;
  /** How Taviron handles it — what the person actually does. */
  how: string;
  /** Why it matters, without invented numbers. */
  value: string;
  /** Concrete capabilities a visitor can verify in the demo. */
  points: string[];
  /** What it does not do (yet). Shown where relevant; never hidden. */
  limitations: string[];
  status: FeatureStatus;
  /** May the public website describe it? Only "available" features can be published. */
  published: boolean;
  /** App pages (under src/app/(app)) that demonstrate it. */
  routes: string[];
  /** Screenshot ids (screenshots.json). */
  screenshots: string[];
  related: string[];
  /** Date the description was last checked against the running app. */
  verified: string;
}

export const FEATURES: Feature[] = [
  {
    id: "command-center",
    name: "Command Center",
    category: "operations",
    problem: "What needs attention today is spread across the whiteboard, group texts and someone's memory.",
    how: "One page for owners, dispatch and the office, arranged by role: urgent orders, orders waiting for a date, unassigned loads, assignment problems, missing or questionable tickets, billing blocks and equipment out of service — each with its owner.",
    value: "Problems surface while they can still be fixed, and everyone can see who is handling what.",
    points: ["Live exceptions from the same records the work happens in", "Assign an exception to a person; hide what is not yours", "Urgent orders: flag, acknowledge, escalate after the company's time limit"],
    limitations: [],
    status: "available",
    published: true,
    routes: ["/command-center"],
    screenshots: ["command-center"],
    related: ["orders", "smart-dispatch", "maintenance"],
    verified: "2026-10-13",
  },
  {
    id: "plan-the-day",
    name: "Plan the day",
    category: "dispatch",
    problem: "Filling loads one at a time spends the right truck on an easy job while a harder load is left without one.",
    how: "Every unassigned load is planned across the whole fleet at once. Hard rules come first — service status, safety defects, shop dates, capacity, trailers, qualifications, time off — then the options are ranked by the priorities you choose. Each plan shows what it covers, what it leaves open and why.",
    value: "Better use of the fleet you already have, with every proposal explained and nothing assigned until a dispatcher approves.",
    points: ["Compare plans for service, estimated revenue, utilization, fewer empty trips or an even workload", "Blocked loads name the truck, trailer or driver that cannot take them, and the rule", "Approval re-checks each assignment against the latest data"],
    limitations: ["Hours of service are not verified (no ELD connection): every proposal is marked Needs review", "Travel distance and drive time are not calculated", "Margin is not evaluated without recorded costs"],
    status: "available",
    published: true,
    routes: ["/dispatch/plan"],
    screenshots: ["plan-the-day"],
    related: ["smart-dispatch", "fleet", "maintenance"],
    verified: "2026-10-13",
  },
  {
    id: "smart-dispatch",
    name: "Dispatch and Smart Dispatch",
    category: "dispatch",
    problem: "Assignments made in a hurry miss an expired medical card, a truck in the shop or a double booking.",
    how: "Loads are planned per order and day. Smart Dispatch suggests a truck and driver for each open load, several days ahead, with its reasons and alternatives; every assignment is checked by the database before it is saved, and a refusal says why.",
    value: "Fewer assignments that fall apart in the morning, and a record of why each choice was made.",
    points: ["A queue of confirmed orders waiting to be scheduled", "Suggestions you approve or reject — never automatic", "Checks for service status, safety reports, capacity, qualifications, expirations and time conflicts"],
    limitations: [],
    status: "available",
    published: true,
    routes: ["/dispatch"],
    screenshots: ["dispatch"],
    related: ["plan-the-day", "driver-portal"],
    verified: "2026-10-13",
  },
  {
    id: "orders",
    name: "Customers, quotes and orders",
    category: "sales",
    problem: "Prices live in one place, the quote in another and the order on a whiteboard.",
    how: "Customers with job sites and billing rules, materials and customer-specific price lists with effective dates, versioned quotes, and orders created once from an accepted quote with the accepted prices.",
    value: "The price a customer agreed to is the price the order carries, and every order shows where it really stands.",
    points: ["Versioned PDF quotes with locked issued versions", "Order lines, schedules, status history and delivered-so-far from accepted tickets", "Standard and customer-specific price lists with effective dates"],
    limitations: ["Quote emails are sent only once an email provider is configured"],
    status: "available",
    published: true,
    routes: ["/customers", "/quotes", "/materials", "/orders"],
    screenshots: ["order"],
    related: ["delivery-tickets", "billing"],
    verified: "2026-10-13",
  },
  {
    id: "driver-portal",
    name: "Driver portal and driver reports",
    category: "field",
    problem: "Drivers get instructions by text and report problems by phone call, and nothing is written down.",
    how: "Each driver sees today's and recent assignments with job instructions on their phone, enters the delivery ticket with photos, and reports delays, equipment problems and breakdowns that dispatch sees at once.",
    value: "The office hears about problems as they happen, with the load and truck already attached.",
    points: ["My Day on the phone", "Tickets with photos", "Delay, equipment and breakdown reports into the dispatcher's queue"],
    limitations: ["No GPS tracking or offline mode yet"],
    status: "available",
    published: true,
    routes: ["/driver", "/field-reports"],
    screenshots: ["driver"],
    related: ["delivery-tickets", "smart-dispatch"],
    verified: "2026-10-13",
  },
  {
    id: "site-directions",
    name: "Checked job site directions",
    category: "field",
    problem: "Gate codes and access notes go out of date, and nobody knows whether the directions a driver follows are still right.",
    how: "Each job site's directions are marked standard or safety/access critical. Office staff mark them verified, which records who checked them and when. Changing the directions clears the check, and the company chooses how often each kind is re-checked.",
    value: "Drivers and dispatch can see whether directions were checked, and critical ones nobody confirmed are flagged before a load goes out.",
    points: ["Verified by whom and when, recorded in the audit log", "Changed directions need a new check", "Unverified critical or overdue directions flagged on the order and the driver's My Day"],
    limitations: ["Needs the 20261115000200 database update before use", "No reminders are sent; the status is shown where the directions are read"],
    status: "in_development",
    published: false,
    routes: ["/customers", "/driver", "/settings"],
    screenshots: [],
    related: ["driver-portal", "orders"],
    verified: "2026-10-15",
  },
  {
    id: "delivery-tickets",
    name: "Delivery tickets",
    category: "field",
    problem: "Paper tickets pile up, get re-keyed, and nobody is sure which quantity is right.",
    how: "Tickets arrive from the driver's phone or office scans and are reviewed beside their order. Corrections are new revisions with a reason; clean tickets can be accepted in bulk.",
    value: "Quantities you can stand behind before anything is billed.",
    points: ["Review queue with the order beside each ticket", "Corrections as revisions — nothing overwritten", "Office scans of paper tickets"],
    limitations: ["Paper tickets are not read automatically (no OCR)"],
    status: "available",
    published: true,
    routes: ["/tickets"],
    screenshots: ["tickets"],
    related: ["billing", "driver-portal"],
    verified: "2026-10-13",
  },
  {
    id: "billing",
    name: "Billing readiness",
    category: "billing",
    problem: "Invoices go out before every load is confirmed — or wait weeks because nobody knows which orders are done.",
    how: "An order becomes billing-ready only when its deliveries are verified in full. Invoice drafts are prepared from verified deliveries for the office to review, and billing handoff batches keep an audit trail with safe reversal.",
    value: "Billing starts from verified work, and partial deliveries never slip into an invoice.",
    points: ["Billing-ready only on full verified delivery", "Invoice drafts for review — not sent and not exported", "Handoff batches with audit trail and safe reversal"],
    limitations: ["Invoices are not issued or sent from Taviron, and there is no accounting integration yet"],
    status: "available",
    published: true,
    routes: ["/billing"],
    screenshots: ["billing"],
    related: ["delivery-tickets", "orders"],
    verified: "2026-10-13",
  },
  {
    id: "order-to-cash",
    name: "Order to cash",
    category: "billing",
    problem: "Nobody can say which confirmed orders are stuck between scheduling, delivery, ticket review and billing.",
    how: "Every open order is placed on one lifecycle — needs scheduling, needs loads, in delivery, tickets, billing review, ready to bill, handed off — with why it is there, the next step and the team that acts, read from the same records as Orders, Dispatch, Tickets and Billing.",
    value: "Stuck orders surface with a reason and an owner instead of waiting for someone to notice.",
    points: ["One lifecycle per open order with the reason and next step", "Needs-attention view, oldest first within each stage", "Read-only: nothing here changes an order"],
    limitations: ["Invoices, receivables and payments are not built; the view ends at Handed off"],
    status: "available",
    published: false,
    routes: ["/order-to-cash"],
    screenshots: [],
    related: ["billing", "orders"],
    verified: "2026-10-14",
  },
  {
    id: "customer-crm",
    name: "Customer relationships and sales pipeline",
    category: "sales",
    problem: "Prospects, follow-ups and what each customer actually orders live in different notebooks and inboxes.",
    how: "Each customer or prospect page keeps the account owner, tags, logged calls and visits, follow-ups, opportunities with stages and values, and a history built from real orders, deliveries and quotes; the pipeline shows open work and what is due this week.",
    value: "Follow-ups stop slipping, and the history is the operation's own record rather than someone's memory.",
    points: ["Prospects become customers on the same record", "Follow-ups with owners and due dates", "History from orders, accepted tickets and quotes"],
    limitations: ["Emails are logged, not sent from here yet", "Pipeline stages are fixed for now"],
    status: "in_development",
    published: false,
    routes: ["/customers/pipeline"],
    screenshots: [],
    related: ["orders"],
    verified: "2026-10-19",
  },
  {
    id: "driver-payroll",
    name: "Driver payroll from delivery tickets",
    category: "billing",
    problem: "Driver pay is worked out by hand from paper tickets, and nobody can trace an amount back to the loads behind it.",
    how: "Each company writes its own pay rules as checked formulas, previews them on real tickets and activates them; a payroll period calculates gross earnings from accepted tickets only, flags what it cannot calculate, and is approved and exported by the owner.",
    value: "Every amount traces to its ticket and rule, and nothing is guessed.",
    points: ["Company-specific, versioned pay rules", "Exceptions instead of guessed amounts", "Owner approval locks the period before export"],
    limitations: ["Gross earnings only: no taxes, withholding or payments", "Export is a CSV file; no payroll provider integration yet"],
    status: "in_development",
    published: false,
    routes: ["/payroll"],
    screenshots: [],
    related: ["billing"],
    verified: "2026-10-18",
  },
  {
    id: "maintenance",
    name: "Maintenance",
    category: "fleet",
    problem: "A truck with a known safety defect gets dispatched because the shop and dispatch use different lists.",
    how: "Work orders with urgency and safety-critical defects; a safety-critical defect takes the truck or trailer out of dispatch until it is cleared. Preventive schedules by time and mileage show what is coming due, and shop visits are checked before any assignment.",
    value: "The shop's knowledge reaches dispatch automatically, before a truck leaves the yard.",
    points: ["Safety-critical defects block dispatch until cleared", "Preventive schedules by days and miles", "Shop dates checked by dispatch and Plan the day"],
    limitations: ["Parts inventory and purchasing are not built yet"],
    status: "available",
    published: true,
    routes: ["/maintenance"],
    screenshots: ["maintenance"],
    related: ["fleet", "plan-the-day"],
    verified: "2026-10-13",
  },
  {
    id: "fleet",
    name: "Fleet and equipment records",
    category: "fleet",
    problem: "Registrations expire unnoticed and nobody knows which trailer goes with which truck.",
    how: "Trucks and trailers with capacities, service status history, assignments and documents such as registrations and inspections with expiry dates; drivers with qualifications and expirations.",
    value: "One record of every unit and driver that dispatch, the shop and the office all use.",
    points: ["Service status with history", "Vehicle documents with expiry dates", "Driver qualifications and expirations checked at assignment"],
    limitations: [],
    status: "available",
    published: true,
    routes: ["/fleet"],
    screenshots: ["fleet"],
    related: ["maintenance", "smart-dispatch"],
    verified: "2026-10-13",
  },
  {
    id: "communications",
    name: "Communications",
    category: "people",
    problem: "Operational messages are lost in personal texts and group chats nobody can audit.",
    how: "Direct and group messages, channels, announcements with acknowledgments, operational alerts with escalation, and a workspace per job that follows dispatch — inside the same system, with message retention and legal holds.",
    value: "The conversation about a job stays with the job, and important notices are acknowledged.",
    points: ["Messages, channels and announcements with acknowledgments", "Operational alerts with priorities and escalation", "Job workspaces linked to dispatch"],
    limitations: [],
    status: "available",
    published: true,
    routes: ["/communications"],
    screenshots: ["communications"],
    related: ["command-center", "driver-portal"],
    verified: "2026-10-13",
  },
  {
    id: "people",
    name: "Employees and time off",
    category: "people",
    problem: "Time-off requests arrive by text and dispatch finds out on the morning of.",
    how: "Employee records with departments and qualifications, time-off requests with approval, and approved leave checked by Smart Dispatch and Plan the day.",
    value: "Dispatch plans around the people who are actually working.",
    points: ["Time-off requests and approvals", "Approved leave is checked by Smart Dispatch and Plan the day", "Employee directory by department"],
    limitations: ["Driver pay calculations are not built"],
    status: "available",
    published: true,
    routes: ["/employees", "/time-off"],
    screenshots: ["employees"],
    related: ["smart-dispatch", "plan-the-day"],
    verified: "2026-10-13",
  },
  {
    id: "reports",
    name: "Reports",
    category: "insight",
    problem: "Monthly numbers are assembled by hand from spreadsheets.",
    how: "An operations and revenue report from recorded loads, tickets and orders.",
    value: "Numbers that come from the work itself, not a separate spreadsheet.",
    points: ["Operations and revenue from recorded loads, tickets and orders"],
    limitations: [],
    status: "available",
    published: true,
    routes: ["/reports"],
    screenshots: ["reports"],
    related: ["billing"],
    verified: "2026-10-13",
  },
  {
    id: "company-controls",
    name: "Company setup, roles and security",
    category: "platform",
    problem: "Office software either lets everyone see everything or needs an IT person to configure.",
    how: "Each company controls its own users, role permissions, branding and settings; a setup checklist shows what is still missing. Every company's records are separated by row-level security, and permissions are checked on the server and again in the database.",
    value: "Separation and permissions you do not have to take on trust.",
    points: ["Role permissions per company", "Company setup checklist", "Row-level security and an audit trail of key changes"],
    limitations: [],
    status: "available",
    published: true,
    routes: ["/settings", "/setup"],
    screenshots: ["setup"],
    related: ["command-center"],
    verified: "2026-10-13",
  },
  {
    id: "ai-plan-explanation",
    name: "AI explanation of a plan",
    category: "dispatch",
    problem: "A plan's trade-offs take time to read.",
    how: "A short plain-language summary of a Plan the day result, checked against Taviron's own figures before it is shown.",
    value: "Faster review of a plan, never a replacement for it.",
    points: [],
    limitations: ["Switched off until the owner configures an AI provider and a model passes evaluation"],
    status: "in_development",
    published: false,
    routes: ["/dispatch/plan"],
    screenshots: [],
    related: ["plan-the-day"],
    verified: "2026-10-13",
  },
  {
    id: "route-planner",
    name: "Route planning",
    category: "dispatch",
    problem: "Nobody can see a truck's whole day — where it goes, in what order and how far — without redrawing it from the board.",
    how: "Each truck's assigned loads become a route from the yard to every delivery site in load order and back, with distances per leg. With a truck-routing provider connected, legs get road miles, driving time and the provider's restriction notices.",
    value: "Dispatch sees the day's driving at a glance, and missing site locations show up before they cause a wrong estimate.",
    points: ["One route per truck from the dispatch board", "Distances per leg; road miles and driving time with truck routing connected", "Sites without a location are listed to fix"],
    limitations: ["Without a routing key, distances are straight lines (labelled)", "Truck dimensions are not recorded yet, so routing uses a standard truck profile", "Routes follow the board's load order; no automatic re-sequencing"],
    status: "available",
    published: false,
    routes: ["/route-planner"],
    screenshots: [],
    related: ["plan-the-day", "smart-dispatch"],
    verified: "2026-10-14",
  },
  {
    id: "dispatch-bases",
    name: "Multiple dispatch bases",
    category: "dispatch",
    problem: "Companies with more than one yard dispatch each from its own trucks and drivers, but one shared list mixes them and nobody can limit who sees which yard.",
    how: "Each truck, trailer, driver and order belongs to a dispatch base. Lists filter by base, Smart Dispatch keeps proposals inside the order's base unless cross-base dispatch is allowed, people can be limited to their bases (enforced by the database), and reports show each base with totals that add up.",
    value: "Each yard runs its own day while the office still sees the whole company, without double counting.",
    points: ["Bases within the plan (Essential 1, Growth 2, Professional 3, Enterprise 5)", "Per-person base access", "Smart Dispatch respects bases and says why", "Per-base report"],
    limitations: ["The dispatch board and maintenance lists do not filter by base yet", "Manual board assignments are not checked against bases"],
    status: "in_development",
    published: false,
    routes: ["/settings"],
    screenshots: [],
    related: ["smart-dispatch", "route-planner"],
    verified: "2026-10-20",
  },
  {
    id: "customer-portal",
    name: "Customer portal",
    category: "platform",
    problem: "Customers call the office to ask where their order is, when the next load arrives, and whether a quote is still valid.",
    how: "Each company invites its customers' contacts to its own branded portal. Customers follow their orders, planned deliveries and confirmed tickets, read and answer quotes, request new quotes, ask questions, and read the company's help articles. The office answers everything from one Customer Portal page; a customer's answer to a quote is confirmed by the office before anything changes.",
    value: "Fewer status calls, faster quote answers, and every customer question in one place.",
    points: ["Branded with the company's name, logo and colour", "Only that customer's own orders, tickets and quotes", "Quote requests without duplicates", "Shareable tracking links that expire"],
    limitations: ["Invoices and online payment are not in the portal (no issued invoices or payment provider yet)", "Invitations are links the office sends; Taviron does not email them yet", "Times are planned windows, not live GPS arrival estimates"],
    status: "in_development",
    published: false,
    routes: ["/customer-portal"],
    screenshots: [],
    related: ["help-center"],
    verified: "2026-10-19",
  },
  {
    id: "help-center",
    name: "Help Center and guided how-tos",
    category: "platform",
    problem: "New office staff and dispatchers learn the system by asking someone, and the same questions reach support again and again.",
    how: "A Help button on every page opens the articles for that page; the Help Center searches step-by-step articles written for each role; guided how-tos highlight the next control without doing anything for you; and a support request is reviewed by the person before it is sent.",
    value: "People answer routine questions themselves, and the team sees which questions Help does not answer yet.",
    points: ["Help for the page you are on", "Searchable articles by role", "Guided how-tos that never act for you", "Support requests with a review step"],
    limitations: ["AI answers are not turned on: they need the owner's AI key and passing evaluation evidence", "Support replies are by email or phone outside Taviron for now"],
    status: "in_development",
    published: false,
    routes: ["/help"],
    screenshots: [],
    related: ["smart-dispatch"],
    verified: "2026-10-20",
  },
];

/** Planned or unreleased work, said plainly on the website ("Not yet — and we will say so"). */
export const NOT_YET: string[] = [
  "Driver pay calculations — waiting on each company's written pay rules",
  "Issuing or sending invoices, and accounting or payroll integrations (QuickBooks Online is the first target, to be verified with a test company)",
  "Travel distance and drive time in dispatch suggestions — truck locations are not recorded yet",
  "Parts inventory and purchasing for maintenance",
  "GPS tracking, offline mode and route or weather intelligence",
  "Automatic reading (OCR) of paper tickets",
  "Online payments and self-service subscriptions",
];

/** App navigation entries deliberately not marketed as a feature of their own, with the reason. */
export const NOT_MARKETED: Record<string, string> = {
  "/route-planner": "Not built (shown as Coming soon in the app); listed in NOT_YET instead.",
};

export const publishedFeatures = () => FEATURES.filter((f) => f.published);
export const screenshotById = (id: string) => SCREENSHOTS.find((s) => s.id === id);
