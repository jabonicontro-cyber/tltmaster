import type { Metadata } from "next";
import { Clock, ShieldCheck } from "lucide-react";
import { FeatureBrief, FeatureStory, featureAnchor } from "@/components/site/feature-story";
import { Container, FinalCta, PageIntro, SectionHeading } from "@/components/site/ui";
import { NOT_YET, publishedFeatures } from "@/lib/site/features";

export const metadata: Metadata = {
  title: "Platform",
  description: "What Taviron does today, feature by feature: Command Center, Plan the day, dispatch with Smart Dispatch, quotes and orders, the driver portal, delivery tickets, maintenance, fleet, billing readiness, communications and security — and what it does not do yet.",
};

// Generated from the feature catalog (src/lib/site/features.ts; docs/MARKETING.md). Features with a screen get a full
// story section; the rest get a compact brief, so no section shows an empty frame.
export default function PlatformPage() {
  const features = publishedFeatures();
  const stories = features.filter((f) => f.screenshots.length > 0);
  const briefs = features.filter((f) => f.screenshots.length === 0);
  return (
    <>
      <PageIntro eyebrow="Platform" title="Everything the hauling day touches, connected.">
        <p>One system of record for the office, dispatch, the shop and the trucks. Every screen below is the real app, with the demo company&apos;s fictional data — and, just as plainly, each capability says what it does not do yet.</p>
      </PageIntro>

      <nav aria-label="Capabilities" className="sticky top-16 z-20 border-b border-silver/10 bg-navy/90 backdrop-blur">
        <Container>
          <ul className="flex gap-2 overflow-x-auto py-3 text-sm [scrollbar-width:none]">
            {features.map((f) => (
              <li key={f.id} className="shrink-0">
                <a href={`#${featureAnchor(f.id)}`} className="inline-flex min-h-9 items-center rounded-full border border-silver/15 px-3.5 text-silver hover:border-electric/60 hover:text-cloud">
                  {f.name}
                </a>
              </li>
            ))}
          </ul>
        </Container>
      </nav>

      <Container>
        {stories.map((f, i) => (
          <FeatureStory key={f.id} feature={f} flip={i % 2 === 1} />
        ))}
      </Container>

      {briefs.length > 0 && <section aria-labelledby="more-title" className="border-t border-silver/10 bg-navy-2/40">
        <Container className="py-16 sm:py-20">
          <SectionHeading id="more-title" eyebrow="Also in the platform" title="The rest of the day, in the same records." />
          <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {briefs.map((f) => (
              <FeatureBrief key={f.id} feature={f} />
            ))}
          </div>
        </Container>
      </section>}

      <section className="border-t border-silver/10">
        <Container className="grid gap-12 py-20 lg:grid-cols-2">
          <SectionHeading eyebrow="Security" title="Separation you do not have to take on trust.">
            <ul className="mt-2 space-y-3 text-[15px]">
              {[
                "Every company's records are separated by row-level security in the database.",
                "Permissions are checked on the server and again in the database for every action.",
                "Changes to key records are kept in an audit trail.",
                "Sign-in with email verification; access by invitation.",
              ].map((t) => (
                <li key={t} className="flex gap-2.5"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-electric" aria-hidden /><span>{t}</span></li>
              ))}
            </ul>
          </SectionHeading>
          <div>
            <h2 className="flex items-center gap-2 text-xl font-bold text-cloud">
              <Clock className="size-5 text-electric" aria-hidden /> Not yet — and we will say so
            </h2>
            <ul className="mt-4 space-y-2">
              {NOT_YET.map((n) => (
                <li key={n} className="rounded-md border border-silver/10 bg-navy-2 px-4 py-2.5 text-sm text-silver">{n}</li>
              ))}
            </ul>
          </div>
        </Container>
      </section>

      <FinalCta />
    </>
  );
}
