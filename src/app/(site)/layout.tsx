import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { siteIndexing } from "@/lib/site/indexing";

export const metadata: Metadata = {
  title: { default: "Taviron — hauling operations software", template: "%s · Taviron" },
  description: "Orders, dispatch, drivers, delivery tickets and billing readiness for hauling companies, in one place.",
  robots: siteIndexing() ? { index: true, follow: true } : { index: false, follow: false, nocache: true },
};

// The public website: static pages, no account, no company data.
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="site flex min-h-dvh flex-col bg-navy text-cloud">
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
