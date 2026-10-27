import type { Metadata } from "next";
import Link from "next/link";
import { PaperworkCalculator } from "@/components/site/paperwork-calculator";
import { Container, FinalCta, PageIntro } from "@/components/site/ui";

export const metadata: Metadata = {
  title: "Ticket paperwork calculator",
  description: "Work out how many office hours delivery-ticket paperwork takes your hauling company each week, and what it costs a year, from your own numbers.",
  alternates: { canonical: "/calculator" },
};

export default function CalculatorPage() {
  return (
    <>
      <PageIntro title="What does ticket paperwork cost you?">
        <p>Every load makes a ticket, and every ticket is collected, typed, checked against its order and sometimes chased. Put in your own numbers to see what that adds up to.</p>
      </PageIntro>
      <Container className="py-14 sm:py-16">
        <PaperworkCalculator />
      </Container>
      <section aria-labelledby="calc-next" className="border-t border-silver/10 bg-navy-2">
        <Container className="grid gap-10 py-16 sm:py-20 lg:grid-cols-3">
          <h2 id="calc-next" className="site-title text-2xl font-bold text-cloud sm:text-3xl">Where Taviron changes that work.</h2>
          <p className="text-[15px] leading-relaxed text-silver">
            Drivers submit tickets with photos from the phone, so nothing is retyped from paper. The office reviews each ticket beside its order, and only verified deliveries reach billing.{" "}
            <Link href="/platform#feature-delivery-tickets" className="font-semibold text-electric hover:underline">How tickets work</Link>
          </p>
          <p className="text-[15px] leading-relaxed text-silver">
            We don&apos;t publish a savings figure: we&apos;d rather measure yours. Once you run on Taviron, it measures how long planning and ticket review really take, from your own use.{" "}
            <Link href="/platform#feature-speed-metrics" className="font-semibold text-electric hover:underline">Speed, measured</Link>
          </p>
        </Container>
      </section>
      <FinalCta />
    </>
  );
}
