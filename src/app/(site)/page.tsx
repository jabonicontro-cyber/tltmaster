import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Check, ClipboardCheck, FileText, Gauge, Receipt, Route, ShieldCheck, Smartphone, Truck, UserCheck, Wrench } from "lucide-react";
import { CatalogShot } from "@/components/site/feature-story";
import { ProductShowcase } from "@/components/site/product-showcase";
import { TruckStory, type StoryChapter } from "@/components/site/truck-story";
import { Container, CtaLink, Eyebrow, FinalCta, SectionHeading } from "@/components/site/ui";
import { publishedFeatures } from "@/lib/site/features";

export const metadata: Metadata = {
  title: { absolute: "Taviron — plan the whole hauling operation" },
  description: "Taviron plans loads, trucks, trailers and drivers together under your safety and capacity rules — quotes, dispatch, tickets and billing readiness in one place for aggregate and material haulers.",
};

// Every statement on this page matches a capability listed as available in
// src/lib/site/capabilities.ts. Screens are the real app with fictional demo data.

// The story beside the truck. Each chapter describes what works today; what is still being built says so.
const STORY: StoryChapter[] = [
  {
    id: "intelligence",
    eyebrow: "The whole operation",
    title: "Every load, truck and driver — planned together.",
    body: (
      <>
        <p>Most dispatch tools fill one load at a time. Taviron&apos;s Plan the day weighs every unassigned load against the whole fleet at once, so a truck isn&apos;t spent on an easy load when a harder one needed it.</p>
        <p>Maintenance, time off, qualifications, trailers and existing commitments are part of the same picture.</p>
      </>
    ),
  },
  {
    id: "profitability",
    eyebrow: "Profitability",
    title: "Revenue in view — honestly estimated.",
    body: (
      <>
        <p>Each plan shows the revenue it covers, estimated from your own order rates and labelled as an estimate.</p>
        <p>Margin needs your costs — fuel, wages, maintenance. Until they are recorded, Taviron says so instead of guessing.</p>
      </>
    ),
  },
  {
    id: "reliability",
    eyebrow: "Reliability",
    title: "Promises you can keep.",
    body: (
      <>
        <p>Choose service first and urgent orders and overdue requested dates lead the plan.</p>
        <p>Recorded capacity, driver qualifications, shop dates and open safety reports are checked before anything is proposed — and again when a dispatcher approves.</p>
      </>
    ),
  },
  {
    id: "utilization",
    eyebrow: "Fleet utilization",
    title: "Compare plans, not guesses.",
    body: (
      <>
        <p>See the same day planned for service, revenue, truck utilization, fewer empty trips or an even driver workload — with the trade-offs between them spelled out.</p>
        <p>Where data is missing — hours of service, travel distance, unverified capacity — the plan says &ldquo;needs review&rdquo; rather than pretending.</p>
      </>
    ),
  },
  {
    id: "automation",
    eyebrow: "Less paperwork",
    title: "The office work follows the truck.",
    body: (
      <>
        <p>Tickets start on the driver&apos;s phone, are reviewed beside their order, and only verified deliveries reach billing — with invoice drafts prepared, never sent on their own.</p>
        <p className="text-sm text-silver/80">In development: AI assistance for office work, built on the same checked records. People will still approve every consequential step.</p>
      </>
    ),
  },
];

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
      {/* Opening and story: the truck stays in view while the chapters scroll (src/components/site/truck-story.tsx). */}
      <section className="relative overflow-x-clip" aria-label="Introduction">
        <div className="site-grid-bg pointer-events-none absolute inset-0" aria-hidden />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[620px] bg-[radial-gradient(60%_60%_at_60%_0%,rgb(22_139_255/0.16),transparent)]" aria-hidden />
        <Container className="relative">
          <TruckStory
            intro={
              <div className="max-w-2xl">
                <Eyebrow>Whole-operation planning for haulers</Eyebrow>
                <h1 className="mt-5 text-[2.6rem] leading-[1.05] font-bold tracking-tight text-balance text-cloud sm:text-6xl">
                  A smarter way to run a fleet.
                </h1>
                <p className="mt-6 text-lg leading-relaxed text-silver sm:text-xl">
                  Taviron plans the whole operation at once — loads, trucks, trailers, drivers and the rules that bind them — and shows you the
                  best plan for the priorities you choose. Safety, qualification and capacity rules come first. Nothing moves until a person approves it.
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
            }
            chapters={STORY}
          />
        </Container>
      </section>

      {/* The real product: screens from the live demo company (fictional data). */}
      <section aria-labelledby="product-title" className="overflow-x-clip border-t border-silver/10">
        <Container className="py-16 sm:py-20">
          <SectionHeading id="product-title" eyebrow="The real product" title="This is the app, not a mock-up.">
            <p>Every screen on this page is Taviron itself, captured from the live demo company with fictional data.</p>
          </SectionHeading>
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
          <CatalogShot id="dispatch" />
        </Container>
      </section>

      {/* Tickets and drivers */}
      <section className="border-t border-silver/10 bg-navy-2">
        <Container className="grid items-center gap-12 py-20 sm:py-24 lg:grid-cols-[1.15fr_0.85fr]">
          <CatalogShot id="tickets" className="lg:order-first" />
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

      {/* Every capability, from the feature catalog: one line each, linking to its section on the platform page. */}
      <section aria-labelledby="capabilities-title" className="border-t border-silver/10">
        <Container className="py-20 sm:py-24">
          <SectionHeading id="capabilities-title" eyebrow="The whole platform" title="One system for the office, dispatch, the shop and the trucks.">
            <p>Each of these is in the app today, shown with the demo company&apos;s fictional data on the platform page.</p>
          </SectionHeading>
          <ul className="mt-12 grid gap-px overflow-hidden rounded-xl border border-silver/10 bg-silver/10 sm:grid-cols-2 lg:grid-cols-3">
            {publishedFeatures().map((f) => (
              <li key={f.id} className="bg-navy">
                <Link href={`/platform#feature-${f.id}`} className="group flex h-full flex-col p-5 hover:bg-navy-2 focus-visible:bg-navy-2">
                  <span className="flex items-center justify-between gap-3 font-semibold text-cloud">
                    {f.name}
                    <ArrowRight className="size-4 shrink-0 text-silver/40 transition-transform group-hover:translate-x-0.5 group-hover:text-electric motion-reduce:transition-none" aria-hidden />
                  </span>
                  <span className="mt-1.5 text-sm leading-relaxed text-silver/85">{f.value}</span>
                </Link>
              </li>
            ))}
            {/* Closes the grid evenly whatever the number of capabilities: it fills the rest of the last row. */}
            <li className={`bg-navy-2 ${publishedFeatures().length % 2 === 0 ? "sm:col-span-2" : "sm:col-span-1"} ${["lg:col-span-3", "lg:col-span-2", "lg:col-span-1"][publishedFeatures().length % 3]}`}>
              <Link href="/platform" className="group flex h-full flex-col justify-center p-5 hover:bg-navy">
                <span className="flex items-center gap-2 font-semibold text-electric">
                  See every capability on the real app <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden />
                </span>
                <span className="mt-1.5 text-sm text-silver/85">Screens from the demo company, what each one does — and what it does not do yet.</span>
              </Link>
            </li>
          </ul>
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
