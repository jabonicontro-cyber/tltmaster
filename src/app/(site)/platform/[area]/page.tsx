import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AreaCards, ControlsAndLimits, WorkflowSteps } from "@/components/site/area-sections";
import { FeatureBrief, FeatureStory } from "@/components/site/feature-story";
import { Container, CtaLink, FinalCta, PageIntro } from "@/components/site/ui";
import { AREAS, areaBySlug } from "@/lib/site/areas";
import { publishedFeatures } from "@/lib/site/features";

export function generateStaticParams() {
  return AREAS.map((a) => ({ area: a.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ area: string }> }): Promise<Metadata> {
  const a = areaBySlug((await params).area);
  return a ? { title: a.label, description: `${a.summary} ${a.value}`.slice(0, 300), alternates: { canonical: `/platform/${a.slug}` } } : {};
}

/** One platform area (src/lib/site/areas.ts): problem, workflow, the real screens of its published features, controls. */
export default async function PlatformAreaPage({ params }: { params: Promise<{ area: string }> }) {
  const area = areaBySlug((await params).area);
  if (!area) notFound();
  const published = publishedFeatures();
  const features = area.features.map((id) => published.find((f) => f.id === id)).filter((f) => f !== undefined);
  const stories = features.filter((f) => f.screenshots.length > 0);
  const briefs = features.filter((f) => f.screenshots.length === 0);
  return (
    <>
      <PageIntro title={area.title}>
        <p><span className="font-semibold text-cloud">{area.label}. </span>{area.problem}</p>
        <p className="mt-4">{area.value}</p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <CtaLink href={`/demo?interest=${area.slug}`}>Request a Demo</CtaLink>
          <CtaLink href="/pricing" variant="ghost">Compare Plans</CtaLink>
        </div>
      </PageIntro>

      <WorkflowSteps id="workflow-title" title="How it works, step by step." steps={area.workflow} />

      <Container>
        {stories.map((f, i) => (
          <FeatureStory key={f.id} feature={f} flip={i % 2 === 1} />
        ))}
      </Container>
      {briefs.length > 0 ? (
        <Container className="grid gap-4 pb-16 md:grid-cols-2">
          {briefs.map((f) => (
            <FeatureBrief key={f.id} feature={f} />
          ))}
        </Container>
      ) : null}

      <ControlsAndLimits id="controls-title" controls={area.controls} notYet={area.notYet} />
      <AreaCards id="connects-title" title="Connected to the rest of the day." slugs={area.connects} />
      <FinalCta />
    </>
  );
}
