import type { Metadata } from "next";
import { Container, FinalCta, PageIntro, order } from "@/components/site/ui";

export const metadata: Metadata = {
  title: "About",
  description: "Why Taviron exists and the principles it is built on.",
  alternates: { canonical: "/about" },
};

const PRINCIPLES = [
  { title: "Shared records, not copies", text: "The office, dispatch and the trucks work from the same orders, loads and tickets. Progress and exceptions are derived from them — never retyped." },
  { title: "Honest about what it knows", text: "Missing or stale data is shown as missing, never as “no problems”. Estimates stay separate from actual delivered quantities." },
  { title: "People decide", text: "Taviron flags, checks and recommends. Dispatch changes, ticket acceptance, billing handoffs and anything that commits the company are done by an authorized person." },
  { title: "Your company stays yours", text: "Each company's numbering, pricing, permissions and settings are its own. No company's habits become everyone's defaults." },
  { title: "Built with operators", text: "Features are shaped by how hauling work actually runs — and what is not built yet is stated plainly." },
];

export default function AboutPage() {
  return (
    <>
      <PageIntro title="Software for the work between the quarry and the job site.">
        <p>
          Hauling runs on phone calls, group texts, whiteboards and paper tickets. Taviron exists to put that work in one place — so a load, a ticket and an invoice all
          tell the same story.
        </p>
      </PageIntro>
      <section>
        <Container className="py-16">
          <h2 className="text-2xl font-black text-cloud">What we hold ourselves to</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {PRINCIPLES.map((p, n) => (
              <div key={p.title} style={order(n % 3)} className="site-reveal rounded-2xl border border-silver/10 bg-navy-2 p-6 shadow-card">
                <h3 className="font-bold text-cloud">{p.title}</h3>
                <p className="mt-2 text-sm text-silver">{p.text}</p>
              </div>
            ))}
          </div>
          <p className="mt-10 max-w-3xl text-silver">
            Taviron is in early access: companies join by invitation and are set up with the Taviron team. If that sounds like your operation, we would like to hear
            from you.
          </p>
        </Container>
      </section>
      <FinalCta />
    </>
  );
}
