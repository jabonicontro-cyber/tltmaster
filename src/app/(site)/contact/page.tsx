import { siteOpenGraph } from "@/lib/site/og";
import { cookies } from "next/headers";
import { LEAD_SENT_COOKIE, leadErrorText } from "@/lib/site/lead";
import type { Metadata } from "next";
import { LeadForm } from "@/components/site/lead-form";
import { Container, PageIntro } from "@/components/site/ui";

export const metadata: Metadata = {
  title: "Contact",
  description: "Questions about Taviron, pricing or early access? Send the team a message and get a reply by email.",
  alternates: { canonical: "/contact" }, openGraph: siteOpenGraph("/contact"),
};

export default async function ContactPage({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <>
      <PageIntro title="Talk to the Taviron team.">
        <p>Questions about the product, pricing or early access? Send a message and the team will reply by email.</p>
      </PageIntro>
      <section>
        <Container className="max-w-3xl py-16">
          <LeadForm kind="contact" sent={sp.sent === "1" && (await cookies()).get(LEAD_SENT_COOKIE)?.value === "1"} initialError={leadErrorText(sp.error)} />
        </Container>
      </section>
    </>
  );
}
