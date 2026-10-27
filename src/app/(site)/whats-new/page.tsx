import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Check } from "lucide-react";
import { Container, FinalCta, PageIntro } from "@/components/site/ui";
import { publicHighlights } from "@/lib/site/releases";

export const metadata: Metadata = {
  title: "What's new",
  description: "New in Taviron: release highlights for hauling and aggregate companies, with what each one does and what it does not do yet.",
  alternates: { canonical: "/whats-new" },
};

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Release highlights (src/lib/site/releases.ts): only entries the owner approved for publication, newest first. */
export default function WhatsNewPage() {
  const highlights = publicHighlights();
  return (
    <>
      <PageIntro title="What's new in Taviron.">
        <p>Taviron ships improvements every week. These are the ones worth knowing about, each with what it does not do yet.</p>
      </PageIntro>
      <Container className="max-w-4xl py-14 sm:py-16">
        {highlights.length === 0 ? (
          <p className="text-[17px] text-silver">The first highlights are on their way. Meanwhile, <Link href="/platform" className="font-semibold text-electric hover:underline">see everything Taviron does today</Link>.</p>
        ) : (
          <ol className="relative space-y-16 border-l border-silver/15 pl-6 sm:pl-10">
            {highlights.map((r) => (
              <li key={r.id} id={r.id} className="site-reveal relative scroll-mt-24">
                <span className="absolute top-1.5 -left-[29px] size-2.5 rounded-full bg-electric ring-4 ring-navy sm:-left-[45px]" aria-hidden />
                <time dateTime={r.releasedOn} className="text-sm font-semibold text-silver">{dateFmt.format(new Date(`${r.releasedOn}T00:00:00Z`))}</time>
                <h2 className="site-title mt-2 text-2xl font-bold text-cloud sm:text-3xl">{r.title}</h2>
                <p className="mt-3 text-[17px] leading-relaxed text-silver">{r.summary}</p>
                <ul className="mt-5 space-y-2.5">
                  {r.benefits.map((b) => (
                    <li key={b} className="flex gap-3 text-[15px] leading-relaxed text-silver">
                      <Check className="mt-1 size-4 shrink-0 text-electric" aria-hidden />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-sm text-silver/80"><span className="font-semibold">Not yet: </span>{r.limitations.join(" · ")}</p>
                {r.image ? (
                  <figure className="mt-6 overflow-hidden rounded-xl border border-silver/15 bg-navy-2 shadow-card">
                    <Image src={r.image.src} alt={r.image.alt} width={2880} height={1800} sizes="(min-width: 896px) 830px, 100vw" className="h-auto w-full" />
                  </figure>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Container>
      <FinalCta />
    </>
  );
}
