import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Check, Minus } from "lucide-react";
import { Container, CtaLink, FinalCta, PageIntro, SectionHeading } from "@/components/site/ui";
import { COMPARISONS } from "@/lib/site/compare";

export function generateStaticParams() {
  return COMPARISONS.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const c = COMPARISONS.find((x) => x.slug === slug);
  return c ? { title: c.label, description: c.description, alternates: { canonical: `/compare/${c.slug}` } } : {};
}

/** An honest comparison with a way of working (src/lib/site/compare.ts): no named competitors, and the other side's strengths said. */
export default async function ComparePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = COMPARISONS.find((x) => x.slug === slug);
  if (!c) notFound();
  const other = COMPARISONS.find((x) => x.slug !== c.slug);
  return (
    <>
      <PageIntro title={c.title}>
        <p>{c.intro}</p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <CtaLink href="/demo">Request a Demo</CtaLink>
          <CtaLink href="/calculator" variant="ghost">What does paperwork cost you?</CtaLink>
        </div>
      </PageIntro>

      <section aria-labelledby="compare-title">
        <Container className="py-16 sm:py-20">
          <SectionHeading id="compare-title" title="Side by side, job by job." />
          {/* A table on wide screens; on phones each row stacks into a card (the header row is hidden there). */}
          <table className="mt-10 w-full border-separate border-spacing-0 text-left">
            <caption className="sr-only">{c.otherLabel} compared with Taviron</caption>
            <thead className="hidden md:table-header-group">
              <tr className="text-sm text-silver">
                <th scope="col" className="w-[22%] pb-3 font-semibold">The job</th>
                <th scope="col" className="w-[36%] pb-3 font-semibold">{c.otherLabel}</th>
                <th scope="col" className="pb-3 font-semibold text-cloud">Taviron today</th>
              </tr>
            </thead>
            <tbody>
              {c.rows.map((r) => (
                <tr key={r.topic} className="site-reveal grid gap-2 border-t border-silver/12 py-5 md:table-row">
                  <th scope="row" className="font-semibold text-cloud md:border-t md:border-silver/12 md:py-5 md:pr-6 md:align-top">{r.topic}</th>
                  <td className="flex gap-2.5 text-[15px] leading-relaxed text-silver md:table-cell md:border-t md:border-silver/12 md:py-5 md:pr-6 md:align-top">
                    <Minus className="mt-1 size-4 shrink-0 text-silver/60 md:hidden" aria-hidden />
                    <span><span className="sr-only md:hidden">{c.otherLabel}: </span>{r.other}</span>
                  </td>
                  <td className="flex gap-2.5 text-[15px] leading-relaxed text-cloud md:table-cell md:border-t md:border-silver/12 md:py-5 md:align-top">
                    <Check className="mt-1 size-4 shrink-0 text-electric md:hidden" aria-hidden />
                    <span><span className="sr-only md:hidden">Taviron: </span>{r.taviron}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Container>
      </section>

      <section aria-labelledby="fair-title" className="border-t border-silver/10 bg-navy-2">
        <Container className="grid gap-12 py-16 sm:py-20 lg:grid-cols-2">
          <div>
            <h2 id="fair-title" className="site-title text-2xl font-bold text-cloud sm:text-3xl">When the other way may suit you better.</h2>
            <ul className="mt-6 space-y-4">
              {c.fairPoints.map((p) => (
                <li key={p} className="border-t border-silver/15 pt-4 text-[15px] leading-relaxed text-silver">{p}</li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="site-title text-2xl font-bold text-cloud sm:text-3xl">What Taviron does not do yet.</h2>
            <ul className="mt-6 space-y-4">
              {c.notYet.map((p) => (
                <li key={p} className="border-t border-silver/15 pt-4 text-[15px] leading-relaxed text-silver">{p}</li>
              ))}
            </ul>
            <p className="mt-6 text-sm text-silver/80">
              Every Taviron statement on this page is a feature you can see in the demo.{" "}
              <Link href="/platform" className="font-semibold text-electric hover:underline">See the real screens</Link>
            </p>
          </div>
        </Container>
      </section>

      {other ? (
        <Container className="py-12">
          <Link href={`/compare/${other.slug}`} className="site-lift group block rounded-xl border border-silver/12 bg-navy-2/60 p-6 hover:border-electric/50">
            <span className="text-sm text-silver">Another comparison</span>
            <span className="mt-1 block text-lg font-semibold text-cloud group-hover:text-electric">{other.label}</span>
          </Link>
        </Container>
      ) : null}
      <FinalCta />
    </>
  );
}
