import Link from "next/link";
import { TavironLogo } from "./logo";
import { MobileMenu } from "./mobile-menu";
import { SiteNav } from "./site-nav";
import { SITE_NAV } from "@/lib/site/nav";
import { cn } from "@/lib/cn";
import { SITE_CONTAINER } from "@/lib/layout";

/** Public website header. The phone menu is a <details> element (works without JavaScript); see MobileMenu. */
export function SiteHeader() {
  return (
    <header className="site-header sticky top-0 z-40 bg-navy/75 backdrop-blur-xl backdrop-saturate-150">
      <div className={cn(SITE_CONTAINER, "flex h-16 items-center justify-between gap-4")}>
        <Link href="/" aria-label="Taviron home" className="flex rounded-xl">
          <TavironLogo />
        </Link>
        <nav aria-label="Main" className="hidden lg:flex">
          <SiteNav />
        </nav>
        <div className="hidden items-center gap-1 lg:flex">
          <Link href="/login" className="site-link whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium text-silver hover:text-cloud">
            Sign in
          </Link>
          <Link href="/demo" className="site-press whitespace-nowrap rounded-full bg-action px-4 py-2 text-sm font-semibold text-white hover:bg-action-hover">
            Request a Demo
          </Link>
        </div>
        <MobileMenu>
          <nav aria-label="Main" className="absolute right-0 mt-2 max-h-[calc(100dvh-5rem)] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-silver/15 bg-navy-2 p-2 shadow-2xl shadow-black/40">
            {SITE_NAV.map((g) =>
              g.links ? (
                <div key={g.label} className="py-1">
                  <p className="px-3 pt-2 pb-1 text-xs font-semibold text-silver/70">{g.label}</p>
                  {g.links.map((l) => (
                    <Link key={l.href} href={l.href} className="site-link block rounded-xl px-3 py-2.5 text-[15px] font-medium text-cloud hover:bg-white/5">
                      {l.label}
                    </Link>
                  ))}
                </div>
              ) : (
                <Link key={g.label} href={g.href!} className="site-link block rounded-xl px-3 py-3 text-[15px] font-medium text-cloud hover:bg-white/5">
                  {g.label}
                </Link>
              ),
            )}
            <div className="my-2 border-t border-silver/10" />
            <Link href="/login" className="site-link block rounded-xl px-3 py-3 text-[15px] font-medium text-cloud hover:bg-white/5">
              Sign in
            </Link>
            <Link href="/demo" className="site-press mt-1 block rounded-full bg-action px-3 py-3 text-center text-[15px] font-semibold text-white hover:bg-action-hover">
              Request a Demo
            </Link>
          </nav>
        </MobileMenu>
      </div>
    </header>
  );
}
