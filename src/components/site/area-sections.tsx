import Link from "next/link";
import { ArrowRight, CircleDashed, ShieldCheck } from "lucide-react";
import { AREAS, type PlatformArea } from "@/lib/site/areas";
import { Container, SectionHeading } from "./ui";

// Sections shared by the platform area and solutions pages (src/lib/site/areas.ts): the workflow, the controls,
// what is not built yet, and where the area connects. Text comes from the area data, never invented here.

export function WorkflowSteps({ title, steps, id }: { title: string; steps: Array<{ step: string; detail: string }>; id: string }) {
  return (
    <section aria-labelledby={id} className="border-t border-silver/10 bg-navy-2/40">
      <Container className="py-16 sm:py-20">
        <SectionHeading id={id} title={title} />
        {/* Columns follow the number of steps, so no row ends with a lone card. */}
        <ol className={`mt-10 grid gap-4 md:grid-cols-2 ${steps.length % 4 === 0 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
          {steps.map((s, i) => (
            <li key={s.step} className="rounded-xl border border-silver/12 bg-navy/60 p-5">
              <span className="inline-flex size-7 items-center justify-center rounded-full bg-electric/15 text-sm font-semibold text-electric tabular" aria-hidden>{i + 1}</span>
              <h3 className="mt-3 text-[17px] font-semibold text-cloud">{s.step}</h3>
              <p className="mt-2 text-sm leading-relaxed text-silver">{s.detail}</p>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}

export function ControlsAndLimits({ controls, notYet, id }: { controls: string[]; notYet: string[]; id: string }) {
  return (
    <section aria-labelledby={id} className="border-t border-silver/10">
      <Container className="grid gap-12 py-16 sm:py-20 lg:grid-cols-2">
        <div>
          <h2 id={id} className="site-title text-2xl font-bold text-cloud sm:text-3xl">People stay in control.</h2>
          <ul className="mt-6 space-y-3">
            {controls.map((c) => (
              <li key={c} className="flex gap-3 text-[15px] leading-relaxed text-silver">
                <ShieldCheck className="mt-0.5 size-5 shrink-0 text-electric" aria-hidden />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>
        {notYet.length > 0 ? (
          <div>
            <h2 className="site-title text-2xl font-bold text-cloud sm:text-3xl">Not available yet.</h2>
            <ul className="mt-6 space-y-3" aria-label="Not available yet">
              {notYet.map((n) => (
                <li key={n} className="flex gap-3 text-[15px] leading-relaxed text-silver/85">
                  <CircleDashed className="mt-0.5 size-5 shrink-0 text-silver/60" aria-hidden />
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Container>
    </section>
  );
}

export function AreaCards({ slugs, title, id }: { slugs: PlatformArea["slug"][]; title: string; id: string }) {
  const areas = slugs.map((s) => AREAS.find((a) => a.slug === s)).filter((a): a is PlatformArea => Boolean(a));
  return (
    <section aria-labelledby={id} className="border-t border-silver/10">
      <Container className="py-16 sm:py-20">
        <SectionHeading id={id} title={title} />
        <ul className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {areas.map((a) => (
            <li key={a.slug}>
              <Link href={`/platform/${a.slug}`} className="group flex h-full flex-col rounded-xl border border-silver/12 bg-navy-2/50 p-5 hover:border-electric/50">
                <span className="text-[17px] font-semibold text-cloud">{a.label}</span>
                <span className="mt-2 flex-1 text-sm leading-relaxed text-silver">{a.summary}</span>
                <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-electric">
                  Explore <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
