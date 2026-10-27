import type { Metadata } from "next";
import { Check, Info } from "lucide-react";
import { Container, CtaLink, FinalCta, PageIntro } from "@/components/site/ui";
import { CUSTOM, EXTRA_TRAINING_CENTS, TIERS, annualMonthlyCents, usd } from "@/lib/site/pricing";
import { PRICING_FAQ as FAQ } from "@/lib/site/pricing-faq";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Taviron pricing by fleet size and dispatch bases: Essential, Growth, Professional, Enterprise and Custom, with annual-commitment pricing and a one-time onboarding fee.",
  alternates: { canonical: "/pricing" },
};

// Every tier includes the same software; tiers differ by how many hauling trucks and
// dispatch bases they cover. Only capabilities that exist today are listed.
const INCLUDED = [
  "Command Center, customers, quotes and orders",
  "Dispatch board with Smart Dispatch suggestions you approve",
  "Driver portal on the phone, with ticket photos",
  "Delivery ticket review and billing readiness",
  "Fleet, drivers, qualifications and equipment status",
  "Users by role, with your company's own permissions and branding",
];

const ONBOARDING = [
  "Company setup",
  "Fleet and employee setup, including import of your existing records",
  "Basic workflow configuration",
  `One live training session (more: ${usd(EXTRA_TRAINING_CENTS)} per session of up to 60 minutes)`,
];

export default function PricingPage() {
  return (
    <>
      <PageIntro title="Priced by the size of your operation.">
        <p>
          One monthly price per company, set by your number of hauling trucks and dispatch bases. Every tier includes the whole platform. Prices are in US dollars, before
          applicable taxes.
        </p>
      </PageIntro>

      <section aria-labelledby="tiers-title">
        <h2 id="tiers-title" className="sr-only">Tiers</h2>
        <Container className="pt-14">
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {TIERS.map((t) => (
              <li key={t.key} aria-label={t.name} className="flex flex-col rounded-xl border border-silver/15 bg-navy-2 p-6">
                <h3 className="text-lg font-semibold text-cloud">{t.name}</h3>
                <p className="mt-1 text-sm text-silver/85">
                  Up to {t.trucks} hauling trucks and {t.bases === 1 ? "1 dispatch base" : `up to ${t.bases} dispatch bases`}
                </p>
                <p className="mt-6 flex flex-wrap items-baseline gap-x-1.5">
                  {t.from ? <span className="w-full text-sm text-silver">From</span> : null}
                  <span className="text-4xl font-semibold tracking-tight text-cloud tabular-nums">{usd(t.monthlyCents)}</span>
                  <span className="text-sm whitespace-nowrap text-silver">/ month</span>
                </p>
                <p className="mt-1.5 text-sm text-silver/85">
                  {t.from ? "From " : ""}
                  <span className="font-semibold text-cloud tabular-nums">{usd(annualMonthlyCents(t.monthlyCents))}</span> / month with a 12-month commitment
                </p>
                <p className="mt-5 border-t border-silver/10 pt-4 text-sm text-silver">
                  One-time onboarding: <span className="font-semibold text-cloud tabular-nums">{usd(t.onboardingCents)}</span>
                </p>
                <div className="mt-auto pt-6">
                  <CtaLink href="/demo" className="w-full">Book a Demo</CtaLink>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex flex-col gap-5 rounded-xl border border-silver/15 bg-navy-2 p-6 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-lg font-semibold text-cloud">Custom</h3>
              <p className="mt-1 text-sm text-silver">
                More than {CUSTOM.aboveTrucks} hauling trucks, several dispatch bases, or needs that go beyond a standard setup. Priced by quote; onboarding from{" "}
                <span className="font-semibold text-cloud tabular-nums">{usd(CUSTOM.onboardingFromCents)}</span>, quoted by scope.
              </p>
            </div>
            <CtaLink href="/contact" variant="ghost" className="shrink-0">Contact Us</CtaLink>
          </div>
        </Container>
      </section>

      <section>
        <Container className="grid gap-10 py-16 md:grid-cols-2">
          <div>
            <h2 className="text-xl font-semibold text-cloud">Every tier includes</h2>
            <ul className="mt-5 space-y-3">
              {INCLUDED.map((i) => (
                <li key={i} className="flex gap-3 text-[15px] text-silver">
                  <Check className="mt-1 size-4 shrink-0 text-electric" aria-hidden />
                  {i}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="text-xl font-semibold text-cloud">Onboarding includes</h2>
            <ul className="mt-5 space-y-3">
              {ONBOARDING.map((i) => (
                <li key={i} className="flex gap-3 text-[15px] text-silver">
                  <Check className="mt-1 size-4 shrink-0 text-electric" aria-hidden />
                  {i}
                </li>
              ))}
            </ul>
            <p className="mt-5 text-sm text-silver/80">
              Support: email, Monday to Friday, 9 a.m.–5 p.m. Central, excluding U.S. federal holidays, with a first response targeted within one business day.
            </p>
          </div>
        </Container>
        <Container>
          <p className="flex gap-2 rounded-2xl border border-[#0c1a2b]/[0.06] bg-navy-2 p-4 text-sm text-silver">
            <Info className="mt-0.5 size-4 shrink-0 text-silver/70" aria-hidden />
            Prices are per company, in US dollars, before applicable taxes. Your tier, prices and terms are confirmed in a written service agreement; nothing is charged
            through this website.
          </p>
        </Container>
      </section>

      <section>
        <Container className="py-16">
          <h2 className="text-2xl font-semibold text-cloud">Questions</h2>
          <dl className="mt-6 grid gap-4 md:grid-cols-2">
            {FAQ.map((f) => (
              <div key={f.q} className="rounded-2xl border border-silver/15 bg-navy-2 p-5 shadow-card">
                <dt className="font-semibold text-cloud">{f.q}</dt>
                <dd className="mt-2 text-sm leading-relaxed text-silver">{f.a}</dd>
              </div>
            ))}
          </dl>
        </Container>
      </section>

      <FinalCta />
    </>
  );
}
