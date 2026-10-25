import type { ReactNode } from "react";
import { Container, PageIntro } from "./ui";

/** Shared frame for the privacy notice and terms: clearly marked as drafts until reviewed. */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <PageIntro title={title} />
      <section>
        <Container className="max-w-3xl py-12">
          <p role="note" className="rounded-lg border border-electric/40 bg-electric/10 px-4 py-3 text-sm text-cloud">
            Draft for early access, subject to change. This page has not yet been reviewed by a lawyer and may change at any time, including before general
            availability. A signed agreement with your company takes precedence over it.
          </p>
          <div className="mt-8 space-y-6 text-silver [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-cloud [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1.5">{children}</div>
        </Container>
      </section>
    </>
  );
}
