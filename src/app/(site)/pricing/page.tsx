import type { Metadata } from "next";
import { Check, Info } from "lucide-react";
import { Container, CtaLink, FinalCta, PageIntro } from "@/components/site/ui";
import { PRICING, foundingMonthlyCents, usd } from "@/lib/site/pricing";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Proposed Taviron pricing: from $499 per month per company, with a founding-customer offer for the first ten companies. Subject to confirmation.",
};

const INCLUDED = [
  "Command Center, quotes, orders and dispatch",
  "Driver portal on the phone, with ticket photos",
  "Delivery ticket review and billing readiness",
  "Fleet, drivers, qualifications and equipment status",
  "Users by role with company-controlled permissions",
  "Team-led setup and import of your existing records",
];

const FAQ = [
  {
    q: "Is this the final price?",
    a: "No. These figures are a proposal. Pricing, what is included, and any limits are confirmed in a written agreement before anything is billed.",
  },
  {
    q: "When does billing start?",
    a: "For founding customers, at go-live — when your company starts running real work in Taviron — not at sign-up or during setup.",
  },
  {
    q: "Can I pay on this website?",
    a: "No. Nothing is charged through this website, and there is no automatic subscription. Billing is arranged directly with the Taviron team.",
  },
  {
    q: "What does the founding-customer offer require?",
    a: "It is offered to the first ten companies that go live. Its exact terms, including how long the discount lasts, are part of the written agreement.",
  },
];

export default function PricingPage() {
  const base = usd(PRICING.baseMonthlyCents);
  const founding = usd(foundingMonthlyCents());
  return (
    <>
      <PageIntro eyebrow="Pricing" title="Simple, per-company pricing.">
        <p>One monthly price for your company. Proposed figures below — every one of them is subject to confirmation.</p>
      </PageIntro>

      <section>
        <Container className="grid gap-6 py-16 lg:grid-cols-2">
          <div className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-8">
            <h2 className="text-sm font-bold tracking-[0.2em] text-white/55 uppercase">Taviron</h2>
            <p className="mt-4 flex items-baseline gap-2">
              <span className="text-sm text-white/60">From</span>
              <span className="text-5xl font-black tracking-tight text-white">{base}</span>
              <span className="text-white/60">/ month</span>
            </p>
            <p className="mt-1 text-sm text-white/50">Proposed price per company · subject to confirmation</p>
            <ul className="mt-8 space-y-3">
              {INCLUDED.map((i) => (
                <li key={i} className="flex gap-2 text-sm text-white/75">
                  <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                  {i}
                </li>
              ))}
            </ul>
            <div className="mt-auto pt-8">
              <CtaLink href="/demo">Request a demo</CtaLink>
            </div>
          </div>

          <div className="relative flex flex-col overflow-hidden rounded-2xl border border-brand/50 bg-gradient-to-b from-brand/15 to-white/[0.02] p-8">
            <p className="w-fit rounded-full bg-brand px-3 py-1 text-xs font-bold tracking-wide text-white">Founding customers</p>
            <h2 className="mt-4 text-2xl font-black text-white">First {PRICING.foundingCustomerLimit} companies</h2>
            <p className="mt-4 flex items-baseline gap-2">
              <span className="text-5xl font-black tracking-tight text-white">{founding}</span>
              <span className="text-white/60">/ month</span>
            </p>
            <p className="mt-1 text-sm text-white/60">
              {PRICING.foundingDiscountPercent}% off the proposed {base} · subject to confirmation
            </p>
            <ul className="mt-8 space-y-3">
              <li className="flex gap-2 text-sm text-white/80">
                <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                {PRICING.foundingDiscountPercent}% off the monthly price
              </li>
              <li className="flex gap-2 text-sm text-white/80">
                <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                Onboarding fee waived during the beta
              </li>
              <li className="flex gap-2 text-sm text-white/80">
                <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                Billing starts at go-live, not at sign-up
              </li>
            </ul>
            <div className="mt-auto pt-8">
              <CtaLink href="/demo">Ask about a founding spot</CtaLink>
            </div>
          </div>
        </Container>
        <Container>
          <p className="flex gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-4 text-sm text-white/65">
            <Info className="mt-0.5 size-4 shrink-0 text-white/50" aria-hidden />
            All pricing on this page is proposed and subject to confirmation in a written agreement. It is not an offer, and nothing is charged through this website.
            Taxes, if any, are not included.
          </p>
        </Container>
      </section>

      <section>
        <Container className="py-16">
          <h2 className="text-2xl font-black text-white">Questions</h2>
          <dl className="mt-6 grid gap-4 md:grid-cols-2">
            {FAQ.map((f) => (
              <div key={f.q} className="rounded-lg border border-white/10 bg-white/[0.03] p-5">
                <dt className="font-bold text-white">{f.q}</dt>
                <dd className="mt-2 text-sm text-white/65">{f.a}</dd>
              </div>
            ))}
          </dl>
        </Container>
      </section>

      <FinalCta />
    </>
  );
}
