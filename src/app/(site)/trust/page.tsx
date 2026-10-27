import type { Metadata } from "next";
import Link from "next/link";
import { CircleDashed, ShieldCheck } from "lucide-react";
import { Container, FinalCta, PageIntro, order } from "@/components/site/ui";

export const metadata: Metadata = {
  title: "Trust & Security",
  description: "How Taviron separates each company's data, checks permissions, records key changes, handles AI and onboards a company — and what is not in place yet.",
  alternates: { canonical: "/trust" },
};

// Every statement below describes a control that exists in the product or a practice we follow today (CLAUDE.md,
// docs/ARCHITECTURE.md, docs/AI.md, the hosted database runbook). No certification, uptime figure or provider assurance is
// claimed; the "Not in place yet" list says plainly what is missing.
const SECTIONS: Array<{ title: string; items: string[] }> = [
  {
    title: "Your company's data stays yours",
    items: [
      "Every business record carries its company, and row-level security in the database limits every query to the signed-in person's own company — not just the screen.",
      "A company id or role sent from a browser is never trusted: the server takes them from the session.",
      "Demo companies hold fictional records only and never send anything to anyone.",
    ],
  },
  {
    title: "People see and do only what their role allows",
    items: [
      "Each company decides which permissions its roles have; every page and action checks them on the server and again in the database.",
      "Two-step verification with an authenticator app is built and being rolled out, starting with Taviron's own platform staff.",
    ],
  },
  {
    title: "A record of what was done",
    items: [
      "Key changes — assignments, ticket reviews and corrections, billing handoffs, permission changes — keep who made them and when.",
      "Corrections are new revisions; the earlier version is kept, not overwritten.",
      "Consequential steps need an authorized person: suggestions, plans and AI never act on their own.",
    ],
  },
  {
    title: "AI, handled carefully",
    items: [
      "AI assistance is not switched on yet. Before it can be, a capability needs its own switch, a usage limit and a passing evaluation.",
      "When on, it reads only what the person may see, sends codes instead of names, email addresses or record ids, and stores usage counts — never the questions or answers.",
      "It can read and draft; it cannot assign, send, bill or change records.",
    ],
  },
  {
    title: "Changes are made carefully",
    items: [
      "Database changes are tested on a copy first, applied in order with a backup taken beforehand, and checked afterwards.",
      "New features reach a preview environment and pass automated checks before they are released.",
    ],
  },
  {
    title: "Going live is a joint decision",
    items: [
      "Onboarding covers company setup, users and permissions, data import with your review, the integrations you need, and testing your essential workflows before the go-live date is agreed with you.",
      "Your subscription starts at your actual go-live, per your signed agreement — not when onboarding starts or data is imported.",
    ],
  },
];

const NOT_YET = [
  "Security certifications or third-party audits: none are claimed.",
  "A published uptime commitment or support response times: these are agreed in the written service agreement.",
  "Self-service data export: ask us and we will provide your records.",
  "The list of hosting providers, data locations and retention periods: it will be published in the privacy notice before general availability.",
];

export default function TrustPage() {
  return (
    <>
      <PageIntro title="Security you can check, not take on trust.">
        <p>What Taviron does today to protect each company&apos;s records — and, just as plainly, what is not in place yet.</p>
      </PageIntro>
      <Container className="grid gap-6 py-16 sm:py-20 md:grid-cols-2">
        {SECTIONS.map((s, n) => (
          <section key={s.title} aria-label={s.title} style={order(n % 2)} className="site-reveal rounded-xl border border-silver/12 bg-navy-2/50 p-6">
            <h2 className="text-xl font-semibold text-cloud">{s.title}</h2>
            <ul className="mt-4 space-y-3">
              {s.items.map((i) => (
                <li key={i} className="flex gap-3 text-[15px] leading-relaxed text-silver">
                  <ShieldCheck className="mt-0.5 size-5 shrink-0 text-electric" aria-hidden />
                  <span>{i}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </Container>
      <section aria-labelledby="not-yet-title" className="border-t border-silver/10 bg-navy-2/40">
        <Container className="py-16">
          <h2 id="not-yet-title" className="site-title text-2xl font-bold text-cloud sm:text-3xl">Not in place yet.</h2>
          <ul className="mt-6 space-y-3">
            {NOT_YET.map((n) => (
              <li key={n} className="flex gap-3 text-[15px] leading-relaxed text-silver/85">
                <CircleDashed className="mt-0.5 size-5 shrink-0 text-silver/60" aria-hidden />
                <span>{n}</span>
              </li>
            ))}
          </ul>
          <p className="mt-8 text-[15px] text-silver">
            Questions about security or a concern to report? <Link href="/contact" className="font-semibold text-electric hover:underline">Contact us</Link>. Read the <Link href="/privacy" className="font-semibold text-electric hover:underline">privacy notice</Link>.
          </p>
        </Container>
      </section>
      <FinalCta />
    </>
  );
}
