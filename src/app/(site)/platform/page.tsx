import type { Metadata } from "next";
import { Check, Clock } from "lucide-react";
import { Container, FinalCta, PageIntro, Screenshot, SectionHeading } from "@/components/site/ui";

export const metadata: Metadata = {
  title: "Platform",
  description: "What Taviron does today: Command Center, quotes and pricing, orders, dispatch, driver portal, delivery tickets, billing readiness, fleet and security.",
};

const MODULES = [
  {
    title: "Command Center",
    points: ["One page for owners, dispatch and the office, arranged by role", "Live exceptions: urgent orders, unassigned loads, assignment problems, missing or questionable tickets, billing blocks, equipment out of service", "Assign an exception to a person; hide what is not yours to handle; personal layout"],
  },
  {
    title: "Customers, materials and pricing",
    points: ["Customers with contacts, job sites, billing details and PO rules", "Materials, charge items and units per company", "Standard and customer-specific price lists with effective dates"],
  },
  {
    title: "Quotes",
    points: ["Versioned quotes with locked issued versions", "PDF quotes; email sending once an email provider is configured", "Accepted quotes convert to orders"],
  },
  {
    title: "Orders",
    points: ["Order lines, schedules and status history", "Urgent orders: flag, acknowledge, escalate after a time limit set by the company", "Delivered-so-far progress from accepted tickets"],
  },
  {
    title: "Dispatch",
    points: ["Loads planned per order and day", "Assignments checked for service status, driver qualifications and expirations, and time conflicts", "Reasons shown when an assignment is refused"],
  },
  {
    title: "Driver portal",
    points: ["Today's and recent assignments with job instructions, on the phone", "Delivery tickets with photos", "Delay, equipment and breakdown reports"],
  },
  {
    title: "Delivery tickets",
    points: ["Review queue with the order beside each ticket", "Corrections as new revisions — nothing overwritten", "Office scans of paper tickets; bulk accept of clean tickets"],
  },
  {
    title: "Billing readiness",
    points: ["Orders become billing-ready only from verified deliveries", "Billing handoff batches with an audit trail and safe reversal", "Verified delivery inputs prepared for payroll (no pay calculations)"],
  },
  {
    title: "Fleet and people",
    points: ["Trucks and trailers with capacities and service status history", "Drivers with qualifications and expirations", "Users by role; each company controls its own role permissions"],
  },
];

const NOT_YET = [
  "Driver pay calculations — waiting on each company's written pay rules",
  "Accounting or payroll integrations (QuickBooks Online is the first target, to be verified with a test company)",
  "Maintenance work orders, preventive schedules and parts",
  "GPS tracking, offline mode and route or weather intelligence",
  "Automatic reading (OCR) of paper tickets",
  "Online payments and self-service subscriptions",
];

export default function PlatformPage() {
  return (
    <>
      <PageIntro eyebrow="Platform" title="Everything the hauling day touches, connected.">
        <p>One system of record for the office, dispatch and the trucks. Here is what it does today — and, just as plainly, what it does not do yet.</p>
      </PageIntro>

      <section>
        <Container className="py-16">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {MODULES.map((m) => (
              <div key={m.title} className="rounded-lg border border-white/10 bg-white/[0.03] p-6">
                <h2 className="text-lg font-bold text-white">{m.title}</h2>
                <ul className="mt-3 space-y-2">
                  {m.points.map((p) => (
                    <li key={p} className="flex gap-2 text-sm text-white/65">
                      <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <section className="border-t border-white/10 bg-[#0f1012]">
        <Container className="grid items-center gap-12 py-20 lg:grid-cols-2">
          <SectionHeading eyebrow="Tickets to billing" title="Quantities you can stand behind.">
            <p>
              A ticket is reviewed against its order before it counts. Corrections create a new revision with the reason, so the history is never lost — and only
              verified deliveries make an order ready for billing.
            </p>
          </SectionHeading>
          <Screenshot src="/site/tickets.png" alt="The Taviron delivery ticket review queue" width={1440} height={900} caption="Ticket review — demo company, fictional data." />
        </Container>
      </section>

      <section>
        <Container className="grid items-center gap-12 py-20 lg:grid-cols-2">
          <Screenshot className="lg:order-first" src="/site/order.png" alt="A Taviron order with its lines, loads and delivered-so-far progress" width={1440} height={900} caption="Order detail — demo company, fictional data." />
          <SectionHeading eyebrow="Orders" title="Every order shows where it really stands.">
            <p>Planned loads, assignments, delivered quantities from accepted tickets, and billing state — from the same shared records, not a separate spreadsheet.</p>
          </SectionHeading>
        </Container>
      </section>

      <section className="border-t border-white/10 bg-[#0f1012]">
        <Container className="grid gap-10 py-20 lg:grid-cols-2">
          <SectionHeading eyebrow="Security" title="Separation you do not have to take on trust.">
            <ul className="mt-2 space-y-2 text-sm">
              <li>Every company&apos;s records are separated by row-level security in the database.</li>
              <li>Permissions are checked on the server and again in the database for every action.</li>
              <li>Changes to key records are kept in an audit trail.</li>
              <li>Sign-in with email verification; access by invitation.</li>
            </ul>
          </SectionHeading>
          <div>
            <h2 className="flex items-center gap-2 text-xl font-bold text-white">
              <Clock className="size-5 text-brand" aria-hidden /> Not yet — and we will say so
            </h2>
            <ul className="mt-4 space-y-2">
              {NOT_YET.map((n) => (
                <li key={n} className="rounded-md border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-white/65">
                  {n}
                </li>
              ))}
            </ul>
          </div>
        </Container>
      </section>

      <FinalCta />
    </>
  );
}
