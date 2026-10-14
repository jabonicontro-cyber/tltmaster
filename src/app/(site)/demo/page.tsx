import type { Metadata } from "next";
import { LeadForm } from "@/components/site/lead-form";
import { Container, PageIntro } from "@/components/site/ui";

export const metadata: Metadata = {
  title: "Request a demo",
  description: "Ask for a walkthrough of Taviron with the live demo company and fictional data.",
};

const STEPS = [
  { title: "Tell us about your operation", text: "A few details help us show the parts that matter to you." },
  { title: "A guided walkthrough", text: "The Taviron team shows the live demo company — fictional customers, orders, trucks and drivers — from each role's point of view." },
  { title: "Your questions, your data", text: "If it fits, we talk through how your records would be imported and checked before anything goes live." },
];

export default async function DemoPage({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <>
      <PageIntro title="See Taviron run a hauling day.">
        <p>No sales script and no commitment. A walkthrough of the real product with fictional demo data.</p>
      </PageIntro>
      <section>
        <Container className="grid gap-10 py-16 lg:grid-cols-[1fr_1.4fr]">
          <ol className="space-y-6">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-4">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-electric/60 text-sm font-bold text-electric">{i + 1}</span>
                <div>
                  <h2 className="font-bold text-cloud">{s.title}</h2>
                  <p className="mt-1 text-sm text-silver">{s.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <LeadForm kind="demo" sent={sp.sent === "1"} initialError={sp.error?.slice(0, 200)} />
        </Container>
      </section>
    </>
  );
}
