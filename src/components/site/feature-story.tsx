import Image from "next/image";
import { ArrowRight, Check, CircleDashed } from "lucide-react";
import type { Feature, Screenshot as Shot } from "@/lib/site/features";
import { FEATURES, screenshotById } from "@/lib/site/features";
import { Eyebrow, Screenshot } from "./ui";

// One capability on the platform page, from the feature catalog (src/lib/site/features.ts): the problem, how Taviron
// handles it, why it matters, what you can check in the demo, what it does not do yet, and the real screen. Desktop
// screens sit beside the text (alternating sides); phone screens are shown in a phone frame.

const CATEGORY: Record<Feature["category"], string> = {
  operations: "Operations",
  dispatch: "Dispatch",
  field: "In the field",
  sales: "Sales and orders",
  billing: "Billing",
  fleet: "Fleet and shop",
  people: "People",
  insight: "Insight",
  platform: "Platform",
};

export const featureAnchor = (id: string) => `feature-${id}`;

function Media({ shot }: { shot: Shot }) {
  if (shot.viewport === "phone") {
    return (
      <figure className="mx-auto w-[min(300px,70%)]">
        <div className="overflow-hidden rounded-[30px] border-[6px] border-[#1d2b3d] bg-black shadow-[0_40px_80px_-24px_rgb(0_0_0/0.8)] ring-1 ring-silver/25">
          <Image src={`/site/${shot.file}`} alt={shot.alt} width={780} height={1688} className="h-auto w-full" sizes="300px" />
        </div>
        <figcaption className="mt-3 text-center text-xs text-silver/75">{shot.caption}</figcaption>
      </figure>
    );
  }
  return <Screenshot src={`/site/${shot.file}`} alt={shot.alt} width={2880} height={1800} caption={shot.caption} />;
}

export function FeatureStory({ feature, flip }: { feature: Feature; flip?: boolean }) {
  const shot = feature.screenshots.map(screenshotById).find(Boolean);
  const related = feature.related.map((id) => FEATURES.find((f) => f.id === id && f.published)).filter((f): f is Feature => Boolean(f));
  const titleId = `${featureAnchor(feature.id)}-title`;
  return (
    <section id={featureAnchor(feature.id)} aria-labelledby={titleId} className="scroll-mt-24 border-t border-silver/10 py-16 sm:py-20">
      <div className={`grid items-center gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-14 ${flip ? "lg:[&>*:first-child]:order-last" : ""}`}>
        <div>
          <Eyebrow>{CATEGORY[feature.category]}</Eyebrow>
          <h2 id={titleId} className="mt-3 text-3xl font-bold tracking-tight text-balance text-cloud sm:text-4xl">{feature.name}</h2>
          <p className="mt-5 text-[15px] leading-relaxed text-silver/80"><span className="font-semibold text-cloud">The problem. </span>{feature.problem}</p>
          <p className="mt-3 text-[17px] leading-relaxed text-silver">{feature.how}</p>
          <p className="mt-3 text-[17px] leading-relaxed font-medium text-cloud">{feature.value}</p>
          <ul className="mt-5 space-y-2" aria-label={`${feature.name}: what you can check in the demo`}>
            {feature.points.map((p) => (
              <li key={p} className="flex gap-2 text-sm text-silver">
                <Check className="mt-0.5 size-4 shrink-0 text-electric" aria-hidden />
                <span>{p}</span>
              </li>
            ))}
          </ul>
          {feature.limitations.length > 0 && (
            <ul className="mt-4 space-y-1.5" aria-label={`${feature.name}: not yet`}>
              {feature.limitations.map((l) => (
                <li key={l} className="flex gap-2 text-xs text-silver/70">
                  <CircleDashed className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>{l}</span>
                </li>
              ))}
            </ul>
          )}
          {related.length > 0 && (
            <p className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <span className="text-silver/60">Works with</span>
              {related.map((r) => (
                <a key={r.id} href={`#${featureAnchor(r.id)}`} className="inline-flex items-center gap-1 font-semibold text-electric hover:underline">
                  {r.name} <ArrowRight className="size-3.5" aria-hidden />
                </a>
              ))}
            </p>
          )}
        </div>
        {shot ? <Media shot={shot} /> : null}
      </div>
    </section>
  );
}

/** Capabilities without a screen of their own on this page: a compact, distinct layout (no empty image frames). */
export function FeatureBrief({ feature }: { feature: Feature }) {
  return (
    <article id={featureAnchor(feature.id)} className="scroll-mt-24 rounded-xl border border-silver/10 bg-navy-2 p-6" aria-labelledby={`${featureAnchor(feature.id)}-title`}>
      <Eyebrow className="text-[11px]">{CATEGORY[feature.category]}</Eyebrow>
      <h3 id={`${featureAnchor(feature.id)}-title`} className="mt-2 text-xl font-bold text-cloud">{feature.name}</h3>
      <p className="mt-3 text-sm leading-relaxed text-silver/80">{feature.problem}</p>
      <p className="mt-2 text-sm leading-relaxed text-silver">{feature.how}</p>
      {feature.limitations.length > 0 && <p className="mt-3 text-xs text-silver/65">Not yet: {feature.limitations.join(" ")}</p>}
    </article>
  );
}
