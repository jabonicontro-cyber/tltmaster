import type { Metadata } from "next";
import Link from "next/link";
import { Check, ClipboardCheck, FileText, Gauge, Receipt, Route, ShieldCheck, Smartphone, Truck, UserCheck, Wrench } from "lucide-react";
import { CatalogShot } from "@/components/site/feature-story";
import { ProductShowcase } from "@/components/site/product-showcase";
import { Container, CtaLink, FinalCta, SectionHeading } from "@/components/site/ui";
import { SEGMENTS } from "@/lib/site/areas";
import { TIERS, usd } from "@/lib/site/pricing";
import { publishedFeatures } from "@/lib/site/features";

export const metadata: Metadata = {
  title: { absolute: "Taviron — Your entire trucking operation. Connected." },
  description: "See what's happening. Know what to do next. Taviron connects quotes, orders, dispatch, drivers, delivery tickets, maintenance and billing readiness for trucking and hauling companies — with people approving every consequential step.",
  alternates: { canonical: "/" },
};

// Every statement on this page matches a capability listed as available in
// src/lib/site/capabilities.ts. Screens are the real app with fictional demo data.

// What Taviron does today, one card each; what is still being built says so.
type StoryChapter = { id: string; title: React.ReactNode; body: React.ReactNode };
const STORY: StoryChapter[] = [
  {
    id: "intelligence",
    title: "Every load, truck and driver, planned together.",
    body: (
      <>
        <p>Most dispatch tools fill one load at a time. Taviron&apos;s Plan the day weighs every unassigned load against the whole fleet at once, so a truck isn&apos;t spent on an easy load when a harder one needed it.</p>
        <p>Maintenance, time off, qualifications, trailers and existing commitments are part of the same picture.</p>
      </>
    ),
  },
  {
    id: "profitability",
    title: "Revenue in view, honestly estimated.",
    body: (
      <>
        <p>Each plan shows the revenue it covers, estimated from your own order rates and labelled as an estimate.</p>
        <p>Margin needs your costs — fuel, wages, maintenance. Until they are recorded, Taviron says so instead of guessing.</p>
      </>
    ),
  },
  {
    id: "reliability",
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
      {/* Opening: the message and the real product (src/components/site/product-showcase.tsx). A static hero replaced
          the scroll-driven 3D truck (owner 2026-10-19: reliable on every screen, no WebGL, nothing drawn that the
          product does not do). */}
      <section className="relative overflow-x-clip" aria-labelledby="hero-title">
        <div className="site-grid-bg pointer-events-none absolute inset-0" aria-hidden />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[620px] bg-[radial-gradient(60%_60%_at_60%_0%,rgb(22_139_255/0.16),transparent)]" aria-hidden />
        <Container className="relative pt-16 pb-20 sm:pt-24 sm:pb-28">
          <div className="max-w-3xl">
            <h1 id="hero-title" className="site-display text-[2.6rem] font-bold text-cloud sm:text-6xl">
              Your entire trucking operation. Connected.
            </h1>
            <p className="mt-6 text-xl font-medium text-cloud sm:text-2xl">See what&apos;s happening. Know what to do next.</p>
            <p className="mt-4 text-lg leading-relaxed text-silver">
              Quotes, orders, dispatch, drivers, delivery tickets, maintenance and billing readiness in one set of connected records. Taviron checks your
              safety, qualification and capacity rules before it suggests anything — and nothing moves until a person approves it.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <CtaLink href="/platform">Explore the Platform</CtaLink>
              <CtaLink href="/demo" variant="ghost">
                Request a Demo
              </CtaLink>
            </div>
            <p className="mt-4 text-sm text-silver/75">Early access. A free walkthrough with fictional demo data — no trial to set up.</p>
          </div>
          <ProductShowcase />
          <p className="mt-6 text-center text-sm text-silver/75">The real app, captured from the live demo company with fictional data — not a mock-up.</p>
        </Container>
      </section>

      {/* What it does today: each statement matches an available capability; what is still being built says so. */}
      <section aria-labelledby="story-title" className="border-t border-silver/10">
        <Container className="py-16 sm:py-20">
          <SectionHeading id="story-title" title="One plan for the whole day." />
          <div className="mt-10 grid gap-6 md:grid-cols-2">
            {STORY.map((c) => (
              <article key={c.id} className="rounded-xl border border-silver/10 bg-navy-2 p-6 sm:p-7">
                <h3 className="text-xl font-semibold text-cloud">{c.title}</h3>
                <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-silver">{c.body}</div>
              </article>
            ))}
          </div>
        </Container>
      </section>


      {/* Intelligence in action: one real situation from the demo company, the evidence and the human decision. */}
      <section aria-labelledby="intel-title" className="border-t border-silver/10 bg-navy-2">
        <Container className="grid items-center gap-12 py-20 sm:py-24 lg:grid-cols-[0.85fr_1.15fr]">
          <div>
            <SectionHeading id="intel-title" title="Know what's happening. Understand why. Decide what comes next.">
              <p>A driver reports a brake problem on a truck booked for tomorrow. Here is what Taviron does — and what it leaves to you.</p>
            </SectionHeading>
            <ol className="mt-6 space-y-4">
              {[
                ["Detect", "The shop opens a safety-critical work order from the report, which restricts the truck at once; its assigned loads appear in the Command Center as assignment problems."],
                ["Explain", "Each item names the reason and links to the load, the truck and the work order."],
                ["Compare", "Smart Dispatch lists the trucks and drivers that can still take each load — and the ones it left out, with the rule."],
                ["Decide", "A dispatcher approves the reassignment; approval re-checks it against the latest data. The truck stays restricted until an authorized inspection clears it."],
              ].map(([t, d], i) => (
                <li key={t} className="flex gap-4">
                  <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-electric/15 text-sm font-semibold text-electric tabular" aria-hidden>{i + 1}</span>
                  <p className="text-[15px] leading-relaxed text-silver"><span className="font-semibold text-cloud">{t}. </span>{d}</p>
                </li>
              ))}
            </ol>
            <p className="mt-6 text-sm text-silver/80">Shown in the demo company with fictional data. AI assistance is built but not switched on yet; everything above works without it.</p>
            <Link href="/platform/intelligence" className="mt-4 inline-block text-[15px] font-semibold text-electric hover:underline">How Taviron surfaces what needs attention</Link>
          </div>
          <CatalogShot id="command-center" />
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
                  <span className="text-xs text-silver/60 tabular-nums">{i + 1}</span>
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
            <SectionHeading title="Assign with the rules already checked.">
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
            <SectionHeading title="Quantities you can stand behind.">
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
          <SectionHeading id="capabilities-title" title="One system for the office, dispatch, the shop and the trucks.">
            <p>Each of these is in the app today, shown with the demo company&apos;s fictional data on the platform page.</p>
          </SectionHeading>
          <ul className="mt-12 grid gap-px overflow-hidden rounded-xl border border-silver/10 bg-silver/10 sm:grid-cols-2 lg:grid-cols-3">
            {publishedFeatures().map((f) => (
              <li key={f.id} className="bg-navy">
                <Link href={`/platform#feature-${f.id}`} className="group flex h-full flex-col p-5 hover:bg-navy-2 focus-visible:bg-navy-2">
                  <span className="font-semibold text-cloud group-hover:text-electric">{f.name}</span>
                  <span className="mt-1.5 text-sm leading-relaxed text-silver/85">{f.value}</span>
                </Link>
              </li>
            ))}
            {/* Closes the grid evenly whatever the number of capabilities: it fills the rest of the last row. */}
            <li className={`bg-navy-2 ${publishedFeatures().length % 2 === 0 ? "sm:col-span-2" : "sm:col-span-1"} ${["lg:col-span-3", "lg:col-span-2", "lg:col-span-1"][publishedFeatures().length % 3]}`}>
              <Link href="/platform" className="group flex h-full flex-col justify-center p-5 hover:bg-navy">
                <span className="font-semibold text-electric group-hover:underline">See every capability on the real app</span>
                <span className="mt-1.5 text-sm text-silver/85">Screens from the demo company, what each one does — and what it does not do yet.</span>
              </Link>
            </li>
          </ul>
        </Container>
      </section>


      {/* Solutions and plans */}
      <section aria-labelledby="solutions-title" className="border-t border-silver/10">
        <Container className="py-20 sm:py-24">
          <SectionHeading id="solutions-title" title="The same platform, sized to your operation.">
            <p>Plans differ by the number of hauling trucks and dispatch bases; every plan includes the whole platform.</p>
          </SectionHeading>
          <ul className="mt-10 grid gap-4 md:grid-cols-3">
            {SEGMENTS.map((s) => (
              <li key={s.slug}>
                <Link href={`/solutions/${s.slug}`} className="group flex h-full flex-col rounded-xl border border-silver/12 bg-navy-2/60 p-6 hover:border-electric/50">
                  <span className="text-lg font-semibold text-cloud">{s.label}</span>
                  <span className="mt-2 flex-1 text-sm leading-relaxed text-silver">{s.summary}</span>
                  <span className="mt-4 text-sm font-semibold text-electric group-hover:underline">For {s.label.toLowerCase()}</span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-12 grid gap-8 rounded-xl border border-silver/12 bg-navy-2/60 p-6 sm:p-8 lg:grid-cols-[1fr_1.2fr]">
            <div>
              <h3 className="text-xl font-semibold text-cloud">From {usd(TIERS[0].monthlyCents)} a month for up to {TIERS[0].trucks} trucks.</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-silver">A one-time onboarding fee is separate from the monthly price. The subscription starts at your go-live, not while you set up and test.</p>
              <div className="mt-6 flex flex-wrap gap-3">
                <CtaLink href="/pricing">Compare Plans</CtaLink>
                <CtaLink href="/demo" variant="ghost">Request a Walkthrough</CtaLink>
              </div>
            </div>
            <ol className="grid gap-3 sm:grid-cols-2">
              {["Choose a plan", "Set up the company, bases, users and permissions", "Import and check your data", "Connect what you need", "Test your essential workflows", "Agree the go-live date"].map((t, i) => (
                <li key={t} className="flex gap-3 text-sm text-silver">
                  <span className="text-electric tabular" aria-hidden>{i + 1}.</span>
                  <span>{t}</span>
                </li>
              ))}
            </ol>
          </div>
        </Container>
      </section>

      {/* Roles */}
      <section>
        <Container className="py-20 sm:py-24">
          <SectionHeading title="Built around the people who move the material.">
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
            <h2 className="mt-5 site-title text-3xl font-bold text-cloud">Your company&apos;s data stays your company&apos;s.</h2>
            <p className="mt-4 text-[17px] leading-relaxed text-silver">Taviron recommends; people decide.</p>
            <Link href="/trust" className="mt-6 inline-block rounded text-[15px] font-semibold text-electric hover:underline">
              Trust &amp; Security: what is in place, and what is not yet
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
