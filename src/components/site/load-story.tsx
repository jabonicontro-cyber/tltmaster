import { Check } from "lucide-react";
import { LOAD_STORY } from "@/lib/site/load-story";
import { CatalogMedia } from "./feature-story";
import { Container, SectionHeading } from "./ui";

// "One load, start to finish" (master plan UX16): one load followed down a single path, from the quote to the invoice,
// each step beside its real screen. The path between the steps fills in as the visitor scrolls (globals.css,
// .site-story-fill, a view timeline); with reduced motion, or in browsers without view timelines, it is simply drawn.
// On a phone the path runs down the left edge and each screen sits under its step.
export function LoadStory() {
  return (
    <section aria-labelledby="load-story-title" className="border-t border-silver/10">
      <Container className="py-20 sm:py-24">
        <SectionHeading id="load-story-title" title="One load, start to finish.">
          <p>Follow a single load through Taviron, from the price the customer agrees to the invoice the office approves. Every screen is the real app, with the demo company&apos;s fictional data.</p>
        </SectionHeading>
        <ol className="mt-14" aria-label="One load, step by step">
          {LOAD_STORY.map((c, i) => {
            const last = i === LOAD_STORY.length - 1;
            return (
              <li key={c.step} className="relative pb-16 pl-12 last:pb-0 sm:pl-16 lg:pb-24">
                {!last && (
                  <span aria-hidden className="absolute top-10 bottom-0 left-[15px] w-0.5 overflow-hidden rounded-full bg-silver/20 sm:top-12 sm:left-[19px]">
                    <span className="site-story-fill block h-full w-full origin-top bg-electric" />
                  </span>
                )}
                <span aria-hidden className="absolute top-0 left-0 inline-flex size-8 items-center justify-center rounded-full border-2 border-electric bg-navy text-sm font-semibold text-electric tabular sm:size-10">
                  {i + 1}
                </span>
                <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
                  <div className="site-reveal lg:pt-1">
                    <p className="text-sm font-semibold text-electric sm:pt-2 lg:pt-2.5">
                      <span className="sr-only">Step {i + 1}: </span>
                      {c.step}
                    </p>
                    <h3 className="mt-3 text-2xl font-semibold text-cloud sm:text-[1.75rem] sm:leading-tight">{c.title}</h3>
                    <p className="mt-4 text-[17px] leading-relaxed text-silver">{c.body}</p>
                    {c.points && (
                      <ul className="mt-5 space-y-3">
                        {c.points.map((t) => (
                          <li key={t} className="flex gap-3 text-[15px] leading-relaxed text-silver">
                            <Check className="mt-1 size-4 shrink-0 text-electric" aria-hidden />
                            <span>{t}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <CatalogMedia id={c.shot} />
                </div>
              </li>
            );
          })}
        </ol>
      </Container>
    </section>
  );
}
