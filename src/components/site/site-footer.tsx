import Link from "next/link";
import { TavironLogo } from "./logo";
import { cn } from "@/lib/cn";
import { SITE_CONTAINER } from "@/lib/layout";
import { FOOTER_GROUPS } from "@/lib/site/nav";

export function SiteFooter() {
  return (
    <footer className="border-t border-silver/10 bg-[#091422]">
      <div className={cn(SITE_CONTAINER, "grid gap-10 py-12 sm:grid-cols-2 lg:grid-cols-[1.3fr_repeat(5,1fr)]")}>
        <div className="space-y-3">
          <TavironLogo />
          <p className="max-w-xs text-sm text-silver/80">Your entire trucking operation. Connected. Orders, dispatch, drivers, delivery tickets, maintenance and billing readiness in one place.</p>
          <p className="text-xs text-silver/60">In early access. Taviron is a working product name.</p>
        </div>
        {FOOTER_GROUPS.map((c) => (
          <div key={c.title}>
            <h2 className="text-sm font-semibold text-cloud">{c.title}</h2>
            <ul className="mt-3 space-y-2">
              {c.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-sm text-silver transition-colors hover:text-cloud">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className={cn(SITE_CONTAINER, "border-t border-silver/10 py-6 text-xs text-silver/60")}>© {new Date().getFullYear()} Taviron. All rights reserved.</div>
    </footer>
  );
}
