// What the public website says Taviron does (N15). Each "available" point
// names the app pages where it can be checked (tests/unit/site-capabilities.test.ts
// fails when a page goes missing). Anything not built yet belongs in PLANNED,
// which the website shows under "Not yet". Update this file — and run through
// docs/RELEASE_CHECKLIST.md — whenever a release changes what the app can do.

export interface Capability {
  title: string;
  points: string[];
  /** App pages (under src/app/(app)) that demonstrate the points. */
  evidence: string[];
}

export const AVAILABLE: Capability[] = [
  {
    title: "Command Center",
    points: ["One page for owners, dispatch and the office, arranged by role", "Live exceptions: urgent orders, orders waiting to be scheduled, unassigned loads, assignment problems, missing or questionable tickets, billing blocks, equipment out of service", "Assign an exception to a person; hide what is not yours to handle; personal layout"],
    evidence: ["/command-center"],
  },
  {
    title: "Customers, materials and pricing",
    points: ["Customers with contacts, job sites, billing details and PO rules", "Materials, charge items and units per company", "Standard and customer-specific price lists with effective dates"],
    evidence: ["/customers", "/materials"],
  },
  {
    title: "Quotes",
    points: ["Versioned quotes with locked issued versions", "PDF quotes; email sending once an email provider is configured", "Accepting a quote creates its confirmed order once, with the accepted prices"],
    evidence: ["/quotes", "/orders"],
  },
  {
    title: "Orders",
    points: ["Order lines, schedules and status history", "Urgent orders: flag, acknowledge, escalate after a time limit set by the company", "Delivered-so-far progress from accepted tickets"],
    evidence: ["/orders"],
  },
  {
    title: "Dispatch",
    points: ["Loads planned per order and day; a queue of confirmed orders waiting to be scheduled", "Smart Dispatch suggests a truck and driver for each open load, several days ahead, with its reasons and alternatives — nothing is assigned until a dispatcher approves", "Assignments checked for service status, open safety reports, recorded capacity, driver qualifications and expirations, and time conflicts — with the reason shown when one is refused"],
    evidence: ["/dispatch"],
  },
  {
    title: "Driver portal",
    points: ["Today's and recent assignments with job instructions, on the phone", "Delivery tickets with photos", "Delay, equipment and breakdown reports"],
    evidence: ["/driver"],
  },
  {
    title: "Delivery tickets",
    points: ["Review queue with the order beside each ticket", "Corrections as new revisions — nothing overwritten", "Office scans of paper tickets; bulk accept of clean tickets"],
    evidence: ["/tickets"],
  },
  {
    title: "Billing readiness",
    points: ["An order becomes billing-ready only when its deliveries are verified in full — partial deliveries stay out", "Invoice drafts prepared from verified deliveries for the office to review (not sent and not exported)", "Billing handoff batches with an audit trail and safe reversal"],
    evidence: ["/billing"],
  },
  {
    title: "Reports and fleet",
    points: ["Operations and revenue report from recorded loads, tickets and orders", "Trucks and trailers with capacities and service status history; drivers with qualifications and expirations", "Users by role; each company controls its own role permissions and its logo and colors in the app"],
    evidence: ["/reports", "/fleet", "/settings"],
  },
];

export const PLANNED: string[] = [
  "Driver pay calculations — waiting on each company's written pay rules",
  "Issuing or sending invoices, and accounting or payroll integrations (QuickBooks Online is the first target, to be verified with a test company)",
  "Travel distance and drive time in dispatch suggestions — truck locations are not recorded yet",
  "Maintenance work orders, preventive schedules and parts",
  "GPS tracking, offline mode and route or weather intelligence",
  "Automatic reading (OCR) of paper tickets",
  "Online payments and self-service subscriptions",
];
