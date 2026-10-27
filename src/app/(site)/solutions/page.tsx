import type { Metadata } from "next";
import { Building2, Gauge, Receipt, Route, Truck, Users, Wrench } from "lucide-react";
import { Container, FinalCta, PageIntro, SectionHeading, order } from "@/components/site/ui";

export const metadata: Metadata = {
  title: "Solutions",
  description: "How Taviron fits aggregate and material haulers, dump truck fleets and growing operations — and each role inside them.",
  alternates: { canonical: "/solutions" },
};

const COMPANIES = [
  {
    icon: Building2,
    title: "Aggregate and material haulers",
    text: "Stone, sand, fill, topsoil, salt and other bulk material sold and delivered by the ton, load, yard or hour — with customer-specific pricing and job sites.",
  },
  {
    icon: Truck,
    title: "Dump truck fleets",
    text: "Many loads a day across many jobs: plan loads per order, assign trucks and qualified drivers, and keep ticket paperwork from piling up.",
  },
  {
    icon: Users,
    title: "Growing operations",
    text: "When the whiteboard, the group text and the spreadsheet stop keeping up — and owners who still drive need the same tools as everyone else.",
  },
];

const ROLES = [
  { icon: Gauge, title: "Owner", items: ["Everything that needs attention in one Command Center", "Who handles which exception, and what changed", "Company settings, users and role permissions"] },
  { icon: Route, title: "Dispatcher", items: ["Today's loads and urgent orders first", "Smart Dispatch suggestions you approve or reject — never automatic", "Driver delay and breakdown reports as they happen"] },
  { icon: Receipt, title: "Office and billing", items: ["Quotes, customers and orders", "Ticket review beside the order; office scans of paper tickets", "Invoice drafts and billing handoff only from verified deliveries"] },
  { icon: Truck, title: "Driver", items: ["Assignments and job instructions on the phone", "Tickets with photos", "Delay, equipment and breakdown reports"] },
  { icon: Wrench, title: "Mechanic", items: ["Out-of-service and return-to-service with history", "Equipment reports from drivers", "Dispatch sees what is down immediately"] },
];

export default function SolutionsPage() {
  return (
    <>
      <PageIntro title="For the companies that keep job sites supplied.">
        <p>Taviron is built for hauling operations, not adapted from generic field-service software. Every company keeps its own numbering, pricing, permissions and settings.</p>
      </PageIntro>

      <section>
        <Container className="py-16">
          <div className="grid gap-4 md:grid-cols-3">
            {COMPANIES.map((c, n) => (
              <div key={c.title} style={order(n % 3)} className="site-reveal rounded-2xl border border-silver/10 bg-navy-2 p-6 shadow-card">
                <c.icon className="size-7 text-electric" aria-hidden />
                <h2 className="mt-4 text-lg font-bold text-cloud">{c.title}</h2>
                <p className="mt-2 text-sm text-silver">{c.text}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <section className="border-t border-silver/10 bg-navy-2">
        <Container className="py-20">
          <SectionHeading title="One system, five ways in.">
            <p>People who wear more than one hat — an owner who also dispatches, an office manager who also drives — get each role&apos;s tools without extra logins.</p>
          </SectionHeading>
          <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-5">
            {ROLES.map((r, n) => (
              <div key={r.title} style={order(n % 3)} className="site-reveal rounded-2xl border border-silver/10 bg-navy p-5">
                <r.icon className="size-6 text-electric" aria-hidden />
                <h3 className="mt-3 font-bold text-cloud">{r.title}</h3>
                <ul className="mt-2 space-y-1.5 text-sm text-silver">
                  {r.items.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <section>
        <Container className="py-20">
          <SectionHeading title="Team-led onboarding, not a blank screen.">
            <p>
              The Taviron team sets up your company with you: your customers, materials, trucks and drivers are imported from your spreadsheets, checked for mistakes and
              duplicates, and reviewed before anything goes live. An import can be reversed without touching anything else.
            </p>
          </SectionHeading>
        </Container>
      </section>

      <FinalCta />
    </>
  );
}
