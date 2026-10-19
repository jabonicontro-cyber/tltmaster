import Link from "next/link";
import { Menu } from "lucide-react";
import { TavironLogo } from "./logo";
import { cn } from "@/lib/cn";
import { SITE_CONTAINER } from "@/lib/layout";

const NAV = [
  { href: "/platform", label: "Platform" },
  { href: "/solutions", label: "Solutions" },
  { href: "/pricing", label: "Pricing" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

/** Public website header. The mobile menu is a <details> element: it works without JavaScript. */
export function SiteHeader() {
  return (
    <header className="site-header sticky top-0 z-40 bg-navy/75 backdrop-blur-xl backdrop-saturate-150">
      <div className={cn(SITE_CONTAINER, "flex h-16 items-center justify-between gap-4")}>
        <Link href="/" aria-label="Taviron home" className="flex rounded-md">
          <TavironLogo />
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-0.5 md:flex">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="site-link rounded-md px-3 py-2 text-sm font-medium text-silver hover:text-cloud">
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="hidden items-center gap-1 md:flex">
          <Link href="/login" className="site-link rounded-md px-3 py-2 text-sm font-medium text-silver hover:text-cloud">
            Sign in
          </Link>
          <Link href="/demo" className="site-press rounded-md bg-action px-4 py-2 text-sm font-semibold text-white hover:bg-action-hover">
            Request a demo
          </Link>
        </div>
        <details className="site-menu group relative md:hidden">
          <summary className="flex cursor-pointer list-none items-center rounded-md p-2 text-silver hover:text-cloud [&::-webkit-details-marker]:hidden" aria-label="Menu">
            <Menu className="size-6" aria-hidden />
          </summary>
          <nav aria-label="Main" className="absolute right-0 mt-2 w-64 rounded-lg border border-silver/15 bg-navy-2 p-2 shadow-2xl shadow-black/40">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="site-link block rounded-md px-3 py-3 text-[15px] font-medium text-cloud hover:bg-white/5">
                {n.label}
              </Link>
            ))}
            <div className="my-2 border-t border-silver/10" />
            <Link href="/login" className="site-link block rounded-md px-3 py-3 text-[15px] font-medium text-cloud hover:bg-white/5">
              Sign in
            </Link>
            <Link href="/demo" className="site-press mt-1 block rounded-md bg-action px-3 py-3 text-center text-[15px] font-semibold text-white hover:bg-action-hover">
              Request a demo
            </Link>
          </nav>
        </details>
      </div>
    </header>
  );
}
