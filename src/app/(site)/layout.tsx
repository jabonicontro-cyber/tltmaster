import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { siteIndexing } from "@/lib/site/indexing";
import { PUBLIC_WEBSITE_URL } from "@/lib/site/urls";

export const metadata: Metadata = {
  title: { default: "Taviron — hauling operations software", template: "%s · Taviron" },
  description: "Orders, dispatch, drivers, delivery tickets and billing readiness for hauling companies, in one place.",
  robots: siteIndexing() ? { index: true, follow: true } : { index: false, follow: false, nocache: true },
  // Links shared in texts, email and social posts: absolute URLs on the public domain, one preview image
  // (scripts/site/render-og-image.mjs). Pages without their own title fall back to the page title.
  metadataBase: new URL(PUBLIC_WEBSITE_URL),
  openGraph: {
    type: "website",
    siteName: "Taviron",
    locale: "en_US",
    images: [{ url: "/og/taviron.png", width: 1200, height: 630, alt: "Taviron: your entire trucking operation, connected. The Command Center of the demo company." }],
  },
  twitter: { card: "summary_large_image", images: ["/og/taviron.png"] },
};

// Who publishes the site, for search engines (schema.org). Facts only: no ratings, reviews or prices.
const ORGANIZATION = {
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Organization", "@id": `${PUBLIC_WEBSITE_URL}/#org`, name: "Taviron", url: PUBLIC_WEBSITE_URL, logo: `${PUBLIC_WEBSITE_URL}/icon.svg` },
    { "@type": "WebSite", "@id": `${PUBLIC_WEBSITE_URL}/#site`, name: "Taviron", url: PUBLIC_WEBSITE_URL, publisher: { "@id": `${PUBLIC_WEBSITE_URL}/#org` } },
    {
      "@type": "SoftwareApplication",
      name: "Taviron",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web browser",
      description: "Operations software for hauling and aggregate companies: orders, dispatch, drivers, delivery tickets, maintenance and billing readiness.",
      publisher: { "@id": `${PUBLIC_WEBSITE_URL}/#org` },
    },
  ],
};

// The public website: static pages, no account, no company data.
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="site flex min-h-dvh flex-col bg-navy text-cloud">
      {/* Structured data is static JSON from this file, never user input. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ORGANIZATION) }} />
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
