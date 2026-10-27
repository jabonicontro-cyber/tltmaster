import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Check } from "lucide-react";
import { AreaCards } from "@/components/site/area-sections";
import { Container, CtaLink, FinalCta, PageIntro, SectionHeading, order } from "@/components/site/ui";
import { SEGMENTS, segmentBySlug } from "@/lib/site/areas";
import { TIERS, usd } from "@/lib/site/pricing";

export function generateStaticParams() {
  return SEGMENTS.map((s) => ({ segment: s.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ segment: string }> }): Promise<Metadata> {
  const s = segmentBySlug((await params).segment);
  return s ? { title: `For ${s.label.toLowerCase()}`, description: `${s.summary} ${s.intro}`.slice(0, 300), alternates: { canonical: `/solutions/${s.slug}` } } : {};
}

/** One audience (src/lib/site/areas.ts): what it needs, a demo scenario, the plans that usually fit (pricing.ts). */
export default async function SolutionPage({ params }: { params: Promise<{ segment: string }> }) {
  const seg = segmentBySlug((await params).segment);
  if (!seg) notFound();
  const plans = TIERS.filter((t) => seg.plans.includes(t.key));
  return (
    <>
      <PageIntro title={seg.title}>
        <p><span className="font-semibold text-cloud">{seg.label}. </span>{seg.intro}</p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <CtaLink href={`/demo?interest=${seg.slug}`}>Request a Demo</CtaLink>
          <CtaLink href="/pricing" variant="ghost">Compare Plans</CtaLink>
        </div>
      </PageIntro>

      <section aria-labelledby="needs-title" className="border-t border-silver/10">
        <Container className="py-16 sm:py-20">
          <SectionHeading id="needs-title" title="What matters at this size." />
          <ul className="mt-8 grid gap-4 md:grid-cols-3">
            {seg.needs.map((n, k) => (
              <li key={n.title} style={order(k % 3)} className="site-reveal rounded-xl border border-silver/12 bg-navy-2/50 p-5">
                <h3 className="text-[17px] font-semibold text-cloud">{n.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-silver">{n.text}</p>
              </li>
            ))}
          </ul>
        </Container>
      </section>

      <section aria-labelledby="scenario-title" className="border-t border-silver/10 bg-navy-2/40">
        <Container className="grid gap-10 py-16 sm:py-20 lg:grid-cols-[1fr_1.1fr]">
          <SectionHeading id="scenario-title" title={seg.scenario.title}>
            <p>{seg.scenario.note}</p>
          </SectionHeading>
          <ol className="space-y-4">
            {seg.scenario.steps.map((s, i) => (
              <li key={s} style={order(i % 3)} className="site-reveal flex gap-4 rounded-xl border border-silver/12 bg-navy/60 p-5">
                <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-electric/15 text-sm font-semibold text-electric tabular" aria-hidden>{i + 1}</span>
                <span className="text-[15px] leading-relaxed text-silver">{s}</span>
              </li>
            ))}
          </ol>
        </Container>
      </section>

      <section aria-labelledby="plans-title" className="border-t border-silver/10">
        <Container className="py-16 sm:py-20">
          <SectionHeading id="plans-title" title={plans.length > 1 ? "Plans that usually fit." : "The plan that usually fits."}>
            <p>Plans differ by the number of trucks and dispatch bases. The written service agreement confirms the price; nothing is charged through the website.</p>
          </SectionHeading>
          <ul className="mt-8 grid gap-4 md:grid-cols-2">
            {plans.map((t, k) => (
              <li key={t.key} style={order(k)} className="site-reveal rounded-xl border border-silver/12 bg-navy-2/50 p-6">
                <h3 className="text-xl font-semibold text-cloud">{t.name}</h3>
                <p className="mt-2 text-2xl font-bold text-cloud tabular">{t.from ? "From " : ""}{usd(t.monthlyCents)}<span className="text-base font-medium text-silver"> / month</span></p>
                <ul className="mt-4 space-y-2 text-sm text-silver">
                  <li className="flex gap-2"><Check className="mt-0.5 size-4 text-electric" aria-hidden />Up to {t.trucks} trucks</li>
                  <li className="flex gap-2"><Check className="mt-0.5 size-4 text-electric" aria-hidden />{t.bases === 1 ? "1 dispatch base" : `Up to ${t.bases} dispatch bases`}</li>
                  <li className="flex gap-2"><Check className="mt-0.5 size-4 text-electric" aria-hidden />One-time onboarding {t.from ? "from " : ""}{usd(t.onboardingCents)}, separate from the monthly price</li>
                </ul>
              </li>
            ))}
          </ul>
          {seg.notYet.length > 0 ? (
            <ul className="mt-8 space-y-2 text-sm text-silver/85" aria-label="Not available yet">
              {seg.notYet.map((n) => <li key={n}>{n}</li>)}
            </ul>
          ) : null}
          <div className="mt-8"><CtaLink href="/pricing" variant="ghost">See every plan</CtaLink></div>
        </Container>
      </section>

      <AreaCards id="areas-title" title="Where to look first." slugs={seg.areas} />
      <FinalCta />
    </>
  );
}
