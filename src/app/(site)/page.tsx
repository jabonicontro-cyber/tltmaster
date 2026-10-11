import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Check, ClipboardCheck, FileText, Gauge, Receipt, Route, ShieldCheck, Smartphone, Truck, UserCheck, Wrench } from "lucide-react";
import { ProductShowcase } from "@/components/site/product-showcase";
import { Container, CtaLink, Eyebrow, FinalCta, Screenshot, SectionHeading } from "@/components/site/ui";

export const metadata: Metadata = {
  title: { absolute: "Taviron — hauling operations software" },
  description: "Quotes, orders, dispatch, drivers, delivery tickets and billing readiness for aggregate and material hauling companies, in one place.",
};

// Every statement on this page matches a capability listed as available in
// src/lib/site/capabilities.ts. Screens are the real app with fictional demo data.

const FLOW = [
  { icon: FileText, title: "Quote", text: "Customer-specific rates, versioned PDF quotes." },
  { icon: ClipboardCheck, title: "Order", text: "An accepted quote becomes its order, once." },
  { icon: Route, title: "Dispatch", text: "Loads assigned to eligible trucks and drivers." },
  { icon: Smartphone, title: "Deliver", text: "Drivers submit tickets with photos from the phone." },
  { icon: UserCheck, title: "Review", text: "The office checks each ticket against its order." },
  { icon: Receipt, title: "Bill", text: "Fully delivered orders hand off with an audit trail." },
];

const ROLES = [
  { icon: Gauge, title: "Owners", text: "One Command Center for what needs attention today, across the whole operation." },
  { icon: Route, title: "Dispatchers", text: "Today's loads, conflicts caught before assignment, urgent orders first." },
  { icon: Receipt, title: "Office and billing", text: "Ticket review beside the order, and billing only from verified deliveries." },
  { icon: Truck, title: "Drivers", text: "Assignments, job instructions, ticket photos and delay or breakdown reports." },
  { icon: Wrench, title: "Mechanics", text: "Service status with history, so dispatch never assigns a truck that is down." },
];

const TRUST = [
  { title: "Separated by company", text: "Every company's records are isolated in the database, not just hidden on screen." },
  { title: "A full audit trail", text: "Changes to key records — assignments, tickets, billing handoffs — are kept with who made them." },
  { title: "People decide", text: "Suggestions never act on their own. Assignments, ticket acceptance and handoffs need an authorized person." },
];

function Points({ items }: { items: string[] }) {
  return (
    <ul className="mt-6 space-y-3">
      {items.map((t) => (
        <li key={t} className="flex gap-3 text-[15px] leading-relaxed text-silver">
          <Check className="mt-1 size-4 shrink-0 text-electric" aria-hidden />
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="site-grid-bg pointer-events-none absolute inset-0" aria-hidden />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(60%_60%_at_50%_0%,rgb(22_139_255/0.14),transparent)]" aria-hidden />
        <Container className="relative pt-16 pb-14 sm:pt-24 sm:pb-20 md:pb-28">
          <div className="max-w-3xl">
            <Eyebrow>For aggregate and material haulers</Eyebrow>
            <h1 className="mt-5 text-[2.5rem] leading-[1.08] font-bold tracking-tight text-balance text-cloud sm:text-6xl">
              Every load, from quote to billing, in one record.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-silver sm:text-xl">
              Taviron connects quotes, orders, dispatch, drivers, delivery tickets and billing readiness — so the office, dispatch and the trucks work from the same
              information instead of whiteboards, group texts and re-keyed spreadsheets.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <CtaLink href="/demo">
                Request a demo <ArrowRight className="size-4" aria-hidden />
              </CtaLink>
              <CtaLink href="/platform" variant="ghost">
                See what it does today
              </CtaLink>
            </div>
            <p className="mt-4 text-sm text-silver/75">Early access. A free walkthrough with fictional demo data — no trial to set up.</p>
          </div>
          <ProductShowcase />
        </Container>
      </section>

      {/* Workflow */}
      <section aria-labelledby="flow-title" className="border-y border-silver/10 bg-navy-2">
        <Container className="py-14 sm:py-16">
          <h2 id="flow-title" className="text-sm font-semibold text-silver">
            One record carries every job through the day
          </h2>
          <ol className="mt-6 grid gap-px overflow-hidden rounded-xl border border-silver/10 bg-silver/10 sm:grid-cols-2 lg:grid-cols-6">
            {FLOW.map((f, i) => (
              <li key={f.title} className="bg-navy-2 p-5">
                <div className="flex items-center justify-between">
                  <f.icon className="size-5 text-electric" aria-hidden />
                  <span className="font-mono text-xs text-silver/60">{String(i + 1).padStart(2, "0")}</span>
                </div>
                <h3 className="mt-4 font-semibold text-cloud">{f.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-silver/90">{f.text}</p>
              </li>
            ))}
          </ol>
        </Container>
      </section>

      {/* Dispatch */}
      <section>
        <Container className="grid items-center gap-12 py-20 sm:py-24 lg:grid-cols-[0.85fr_1.15fr]">
          <div>
            <SectionHeading eyebrow="Dispatch" title="Assign with the rules already checked.">
              <p>Loads are planned against each order and checked before a truck or driver is committed — and when something does not fit, Taviron says why.</p>
            </SectionHeading>
            <Points
              items={[
                "Service status, open safety reports, recorded capacity, driver qualifications and time conflicts are checked on every assignment.",
                "Smart Dispatch suggests a truck and driver for each open load, with its reasons and alternatives. Nothing is assigned until a dispatcher approves.",
                "Confirmed orders without a delivery date wait in a queue instead of disappearing.",
              ]}
            />
          </div>
          <Screenshot src="/site/dispatch.png" alt="Dispatch for a demo company: an urgent order awaiting acknowledgement and Smart Dispatch proposals of a truck and driver for each open load, not yet assigned" width={2880} height={1800} caption="Dispatch board — demo company, fictional data." />
        </Container>
      </section>

      {/* Tickets and drivers */}
      <section className="border-t border-silver/10 bg-navy-2">
        <Container className="grid items-center gap-12 py-20 sm:py-24 lg:grid-cols-[1.15fr_0.85fr]">
          <Screenshot className="lg:order-first" src="/site/tickets.png" alt="Delivery Tickets for a demo company: loads awaiting a ticket, with tabs for tickets needing review, submitted, accepted and voided" width={2880} height={1800} caption="Delivery tickets — demo company, fictional data." />
          <div>
            <SectionHeading eyebrow="Tickets to billing" title="Quantities you can stand behind.">
              <p>The ticket starts in the truck, not in a shoebox — and an order reaches billing only when its deliveries are verified.</p>
            </SectionHeading>
            <Points
              items={[
                "Drivers see their assignments on the phone and submit tickets with photos; the office enters paper tickets and scans.",
                "Each ticket is reviewed beside its order. Corrections become new revisions with a reason — nothing is overwritten.",
                "Partly delivered orders stay out of billing; invoice drafts are prepared for review, not sent.",
              ]}
            />
          </div>
        </Container>
      </section>

      {/* Roles */}
      <section>
        <Container className="py-20 sm:py-24">
          <SectionHeading eyebrow="Every role" title="Built around the people who move the material.">
            <p>Each person sees what their role allows. Permissions are enforced on the server and in the database.</p>
          </SectionHeading>
          <ul className="mt-12 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-5">
            {ROLES.map((r) => (
              <li key={r.title} className="border-t border-silver/15 pt-5">
                <r.icon className="size-5 text-electric" aria-hidden />
                <h3 className="mt-4 font-semibold text-cloud">{r.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-silver/90">{r.text}</p>
              </li>
            ))}
          </ul>
        </Container>
      </section>

      {/* Trust */}
      <section className="border-t border-silver/10 bg-navy-2">
        <Container className="grid gap-12 py-20 sm:py-24 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <ShieldCheck className="size-8 text-electric" aria-hidden />
            <h2 className="mt-5 text-3xl font-bold tracking-tight text-balance text-cloud">Your company&apos;s data stays your company&apos;s.</h2>
            <p className="mt-4 text-[17px] leading-relaxed text-silver">Taviron recommends; people decide.</p>
            <Link href="/platform" className="mt-6 inline-flex items-center gap-1.5 rounded text-[15px] font-semibold text-electric hover:underline">
              What is available today, and what is planned <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
          <dl className="grid gap-8 sm:grid-cols-3 lg:gap-6">
            {TRUST.map((t) => (
              <div key={t.title} className="border-t border-silver/15 pt-5">
                <dt className="font-semibold text-cloud">{t.title}</dt>
                <dd className="mt-1.5 text-sm leading-relaxed text-silver/90">{t.text}</dd>
              </div>
            ))}
          </dl>
        </Container>
      </section>

      <FinalCta />
    </>
  );
}
