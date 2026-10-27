import type { Metadata } from "next";
import { Fragment, type ReactNode } from "react";
import { Container, FinalCta, PageIntro } from "@/components/site/ui";
import { publicGuides } from "@/lib/site/guides";

export const metadata: Metadata = {
  title: "Guides",
  description: "Step-by-step guides to Taviron's everyday work: quotes, orders, planning the day, dispatch, driver reports, delivery tickets, billing readiness, shop work orders and time off.",
  alternates: { canonical: "/guides" },
};

/** Help articles mark control names with **bold**; on the website they are shown as strong text. */
function Rich({ text }: { text: string }): ReactNode {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i} className="font-semibold text-cloud">{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}

export default function GuidesPage() {
  const guides = publicGuides();
  return (
    <>
      <PageIntro title="How the everyday work gets done.">
        <p>The same step-by-step guides your team gets inside Taviron, for the jobs done every day. Every company also gets a walkthrough when it goes live.</p>
      </PageIntro>
      <Container className="grid gap-12 py-14 sm:py-16 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav aria-label="Guides" className="lg:sticky lg:top-24 lg:self-start">
          <ul className="flex flex-wrap gap-2 lg:flex-col lg:gap-1">
            {guides.map((g) => (
              <li key={g.id}>
                <a href={`#${g.id}`} className="inline-flex min-h-11 items-center rounded-full border border-silver/15 px-4 text-sm text-silver hover:text-cloud lg:min-h-9 lg:w-full lg:rounded-lg lg:border-0 lg:px-3 lg:hover:bg-navy-2">
                  {g.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="max-w-3xl space-y-16">
          {guides.map((g) => (
            <section key={g.id} id={g.id} aria-labelledby={`${g.id}-title`} className="scroll-mt-24">
              <h2 id={`${g.id}-title`} className="site-title text-2xl font-bold text-cloud sm:text-3xl">{g.title}</h2>
              <p className="mt-3 text-[17px] leading-relaxed text-silver">{g.summary}</p>
              <div className="mt-6 space-y-6">
                {g.tasks.map((t) => (
                  <div key={t.title} className="site-reveal rounded-xl border border-silver/12 bg-navy-2/60 p-5 sm:p-6">
                    <h3 className="font-semibold text-cloud">{t.title}</h3>
                    <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-silver marker:text-silver/60">
                      {t.steps.map((s) => <li key={s}><Rich text={s} /></li>)}
                    </ol>
                  </div>
                ))}
              </div>
              {g.limitations?.length ? (
                <p className="mt-4 text-sm leading-relaxed text-silver/80"><span className="font-semibold">Good to know: </span><Rich text={g.limitations.join(" ")} /></p>
              ) : null}
            </section>
          ))}
        </div>
      </Container>
      <FinalCta />
    </>
  );
}
