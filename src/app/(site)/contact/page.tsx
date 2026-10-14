import type { Metadata } from "next";
import { LeadForm } from "@/components/site/lead-form";
import { Container, PageIntro } from "@/components/site/ui";

export const metadata: Metadata = {
  title: "Contact",
  description: "Send the Taviron team a message.",
};

export default async function ContactPage({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <>
      <PageIntro title="Talk to the Taviron team.">
        <p>Questions about the product, pricing or early access — send a message and the team will reply by email.</p>
      </PageIntro>
      <section>
        <Container className="max-w-3xl py-16">
          <LeadForm kind="contact" sent={sp.sent === "1"} initialError={sp.error?.slice(0, 200)} />
        </Container>
      </section>
    </>
  );
}
