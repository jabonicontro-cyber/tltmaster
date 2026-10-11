import type { ReactNode } from "react";
import { Container, PageIntro } from "./ui";

/** Shared frame for the privacy notice and terms: clearly marked as drafts until reviewed. */
export function LegalPage({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <>
      <PageIntro eyebrow={eyebrow} title={title} />
      <section>
        <Container className="max-w-3xl py-12">
          <p role="note" className="rounded-lg border border-brand/40 bg-brand/10 px-4 py-3 text-sm text-white">
            Draft for early access. This page has not yet been reviewed by a lawyer and may change before general availability. A signed agreement with your company
            takes precedence over it.
          </p>
          <div className="mt-8 space-y-6 text-white/75 [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-white [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1.5">{children}</div>
        </Container>
      </section>
    </>
  );
}
