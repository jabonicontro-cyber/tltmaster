import type { Metadata } from "next";
import { ArrowRight, ClipboardCheck, FileText, Gauge, Receipt, Route, ShieldCheck, Smartphone, Truck, Wrench } from "lucide-react";
import { HeroScene } from "@/components/site/hero-scene";
import { Container, CtaLink, Eyebrow, FinalCta, Screenshot, SectionHeading } from "@/components/site/ui";

export const metadata: Metadata = {
  title: { absolute: "Taviron — hauling operations software" },
  description: "Orders, dispatch, drivers, delivery tickets and billing readiness for aggregate and material hauling companies, in one place.",
};

const FLOW = [
  { icon: FileText, title: "Quote", text: "Customer-specific rates, versions and PDF quotes." },
  { icon: ClipboardCheck, title: "Order", text: "Accepted quotes become orders with lines and schedules." },
  { icon: Route, title: "Dispatch", text: "Plan loads and assign trucks and qualified drivers." },
  { icon: Smartphone, title: "Deliver", text: "Drivers see their work and submit tickets from the phone." },
  { icon: ClipboardCheck, title: "Review", text: "The office checks every ticket against the order." },
  { icon: Receipt, title: "Billing-ready", text: "Verified quantities hand off to billing with an audit trail." },
];

const ROLES = [
  { icon: Gauge, title: "Owners", text: "One Command Center for what needs attention today, across every part of the operation." },
  { icon: Route, title: "Dispatchers", text: "A board of today's loads, conflicts flagged before they happen, urgent orders up front." },
  { icon: Receipt, title: "Office and billing", text: "Ticket review with the order beside it, and a clean handoff of verified deliveries." },
  { icon: Truck, title: "Drivers", text: "Assignments, job instructions, ticket photos and delay or breakdown reports on the phone." },
  { icon: Wrench, title: "Mechanics", text: "Out-of-service status with history, so dispatch never assigns a truck that is down." },
];

export default function HomePage() {
  return (
    <>
      <section className="site-grid-bg relative overflow-hidden">
        <div className="pointer-events-none absolute -top-48 right-[-10%] h-[36rem] w-[36rem] rounded-full bg-brand/20 blur-3xl" aria-hidden />
        <Container className="relative grid items-center gap-10 py-16 sm:py-24 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold text-white/80">
              <span className="size-1.5 rounded-full bg-brand" aria-hidden /> Now in early access
            </p>
            <h1 className="mt-5 text-4xl leading-[1.05] font-black tracking-tight text-white sm:text-6xl">
              Run the hauling day from <span className="text-brand">one screen</span>.
            </h1>
            <p className="mt-5 max-w-xl text-lg text-white/70">
              Taviron connects quotes, orders, dispatch, drivers, delivery tickets and billing readiness for aggregate and material hauling companies — so the office,
              dispatch and the trucks work from the same records.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <CtaLink href="/demo">Request a demo</CtaLink>
              <CtaLink href="/platform" variant="ghost">
                Explore the platform
              </CtaLink>
            </div>
          </div>
          <HeroScene />
        </Container>
      </section>

      <section className="border-y border-white/10 bg-[#0f1012]">
        <Container className="py-14">
          <Eyebrow>From quote to billing-ready</Eyebrow>
          <ol className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            {FLOW.map((f, i) => (
              <li key={f.title} className="relative rounded-lg border border-white/10 bg-white/[0.03] p-4">
                <div className="flex items-center gap-2">
                  <f.icon className="size-5 text-brand" aria-hidden />
                  <span className="text-xs font-bold text-white/40">{String(i + 1).padStart(2, "0")}</span>
                </div>
                <h3 className="mt-3 font-bold text-white">{f.title}</h3>
                <p className="mt-1 text-sm text-white/60">{f.text}</p>
                {i < FLOW.length - 1 ? <ArrowRight className="absolute top-1/2 -right-3 hidden size-4 -translate-y-1/2 text-white/25 lg:block" aria-hidden /> : null}
              </li>
            ))}
          </ol>
        </Container>
      </section>

      <section>
        <Container className="grid items-center gap-12 py-20 lg:grid-cols-2">
          <SectionHeading eyebrow="Command Center" title="What needs attention, before it becomes a phone call.">
            <p>
              Urgent orders, unassigned loads, assignment problems, missing or questionable tickets, billing blocks and equipment out of service — derived live from the
              same records everyone works in, sorted by what matters first, and shown to the people whose job it is.
            </p>
          </SectionHeading>
          <Screenshot src="/site/command-center.png" alt="The Taviron Command Center showing today's orders, loads needing attention and urgent orders for a demo company" width={1440} height={900} caption="Command Center — demo company, fictional data." />
        </Container>
      </section>

      <section className="border-t border-white/10 bg-[#0f1012]">
        <Container className="grid items-center gap-12 py-20 lg:grid-cols-2">
          <Screenshot className="lg:order-first" src="/site/dispatch.png" alt="The Taviron dispatch board with loads assigned to trucks and drivers" width={1440} height={900} caption="Dispatch board — demo company, fictional data." />
          <SectionHeading eyebrow="Dispatch" title="Assign with the rules already checked.">
            <p>
              Loads are planned against each order. Assigning a truck and driver checks service status, driver qualifications and expirations, and time conflicts —
              and says why when something does not fit, instead of letting it through.
            </p>
          </SectionHeading>
        </Container>
      </section>

      <section>
        <Container className="grid items-center gap-12 py-20 lg:grid-cols-[1fr_auto]">
          <SectionHeading eyebrow="Drivers and tickets" title="The ticket starts in the truck, not in a shoebox.">
            <p>
              Drivers see their assignments with job instructions, submit delivery tickets with photos, and report delays or breakdowns from their phone. The office
              reviews each ticket beside its order, corrects with a full revision history, and accepts clean tickets in bulk.
            </p>
          </SectionHeading>
          <div className="mx-auto w-[260px] overflow-hidden rounded-[28px] border-4 border-white/15 bg-black shadow-2xl shadow-black/60">
            <Screenshot src="/site/driver.png" alt="The Taviron driver portal on a phone, showing today's assignment" width={390} height={844} className="rounded-none border-0" />
          </div>
        </Container>
      </section>

      <section className="border-t border-white/10 bg-[#0f1012]">
        <Container className="py-20">
          <SectionHeading eyebrow="Every role" title="Built around the people who move the material.">
            <p>Each person sees what their role allows. Permissions are enforced on the server and in the database, not just hidden in the screen.</p>
          </SectionHeading>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {ROLES.map((r) => (
              <div key={r.title} className="rounded-lg border border-white/10 bg-white/[0.03] p-5">
                <r.icon className="size-6 text-brand" aria-hidden />
                <h3 className="mt-3 font-bold text-white">{r.title}</h3>
                <p className="mt-1 text-sm text-white/60">{r.text}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <section>
        <Container className="grid gap-8 py-20 md:grid-cols-[auto_1fr] md:items-start">
          <ShieldCheck className="size-10 text-brand" aria-hidden />
          <div>
            <h2 className="text-2xl font-black text-white">Your company&apos;s data stays your company&apos;s.</h2>
            <p className="mt-3 max-w-3xl text-white/65">
              Every company is separated at the database level, changes to key records are kept in an audit trail, and nothing — a dispatch change, a ticket acceptance, a billing
              handoff — happens without an authorized person doing it. Taviron recommends; people decide.
            </p>
          </div>
        </Container>
      </section>

      <FinalCta />
    </>
  );
}
