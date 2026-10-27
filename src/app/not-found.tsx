import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { Container, CtaLink } from "@/components/site/ui";

export const metadata: Metadata = { title: "Page not found", robots: { index: false, follow: false } };

// Any address that matches no page (the app's own records have src/app/(app)/not-found.tsx). Shown in the website's
// look, with the places a visitor most likely meant.
const PLACES = [
  { href: "/platform", label: "Platform", text: "Everything Taviron does today." },
  { href: "/pricing", label: "Pricing", text: "Plans by fleet size." },
  { href: "/guides", label: "Guides", text: "Step by step through the everyday work." },
  { href: "/contact", label: "Contact", text: "Ask the Taviron team." },
];

export default function NotFound() {
  return (
    <div className="site flex min-h-dvh flex-col bg-navy text-cloud">
      <SiteHeader />
      <main id="main" className="flex-1">
        <Container className="py-20 sm:py-28">
          <p className="text-sm font-semibold text-electric">404</p>
          <h1 className="site-display mt-3 max-w-2xl text-4xl font-bold text-cloud sm:text-5xl">This road doesn&apos;t go anywhere.</h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-silver">The page you asked for doesn&apos;t exist or has moved. Here are the places people usually look for.</p>
          <ul className="mt-10 grid max-w-3xl gap-3 sm:grid-cols-2">
            {PLACES.map((p) => (
              <li key={p.href}>
                <Link href={p.href} className="group flex h-full flex-col rounded-xl border border-silver/12 bg-navy-2/60 p-5 hover:border-electric/50">
                  <span className="font-semibold text-cloud group-hover:text-electric">{p.label}</span>
                  <span className="mt-1 text-sm text-silver">{p.text}</span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-10">
            <CtaLink href="/">Back to the home page</CtaLink>
          </div>
        </Container>
      </main>
      <SiteFooter />
    </div>
  );
}
