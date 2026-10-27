import type { Metadata } from "next";
import Link from "next/link";
import { Container, FinalCta, PageIntro } from "@/components/site/ui";
import { PRODUCT_FAQ, type Faq } from "@/lib/site/faq";
import { PRICING_FAQ } from "@/lib/site/pricing-faq";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Answers about what Taviron does, dispatch and AI, drivers, billing, demos, data protection, pricing, onboarding and support.",
  alternates: { canonical: "/faq" },
};

function Group({ id, title, items }: { id: string; title: string; items: Faq[] }) {
  return (
    <section aria-labelledby={id} className="py-10">
      <h2 id={id} className="site-title text-2xl font-bold text-cloud sm:text-3xl">{title}</h2>
      <div className="mt-6 divide-y divide-silver/10 rounded-xl border border-silver/12 bg-navy-2/50">
        {items.map((f) => (
          <details key={f.q} className="group px-5 py-4">
            <summary className="cursor-pointer list-none text-[17px] font-semibold text-cloud [&::-webkit-details-marker]:hidden">
              <span className="flex items-start justify-between gap-4">
                {f.q}
                <span className="mt-0.5 text-electric transition-transform group-open:rotate-45" aria-hidden>+</span>
              </span>
            </summary>
            <p className="mt-3 text-[15px] leading-relaxed text-silver">{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export default function FaqPage() {
  // The questions and answers as structured data, so search results can show them (schema.org FAQPage).
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [...PRODUCT_FAQ, ...PRICING_FAQ].map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd).replace(/</g, "\\u003c") }} />
      <PageIntro title="Questions, answered plainly.">
        <p>If yours is not here, <Link href="/contact" className="font-semibold text-electric hover:underline">ask us</Link>.</p>
      </PageIntro>
      <Container className="max-w-3xl pb-10">
        <Group id="product-faq" title="The product" items={PRODUCT_FAQ} />
        <Group id="pricing-faq" title="Pricing and going live" items={PRICING_FAQ} />
        <p className="pb-6 text-[15px] text-silver">
          See <Link href="/pricing" className="font-semibold text-electric hover:underline">pricing</Link> and <Link href="/trust" className="font-semibold text-electric hover:underline">Trust &amp; Security</Link> for the details.
        </p>
      </Container>
      <FinalCta />
    </>
  );
}
