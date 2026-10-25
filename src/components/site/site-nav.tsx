"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { SITE_NAV } from "@/lib/site/nav";

/**
 * Desktop navigation of the public website: disclosure menus (a button that opens a list of links), which keyboard and
 * screen-reader users can operate — Enter/Space opens, Escape closes and returns focus, a click outside closes. Every
 * entry is a real link to a page that exists (tests/unit/site-areas.test.ts).
 */
export function SiteNav() {
  const pathname = usePathname();
  // A menu belongs to the page it was opened on: navigating closes it without an extra render.
  const [openOn, setOpenOn] = useState<{ label: string; path: string } | null>(null);
  const open = openOn?.path === pathname ? openOn.label : null;
  const setOpen = (label: string | null) => setOpenOn(label ? { label, path: pathname } : null);
  const root = useRef<HTMLDivElement>(null);
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpenOn(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        buttons.current[open]?.focus();
        setOpenOn(null);
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = (href: string) => pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));

  return (
    <div ref={root} className="flex items-center gap-0.5">
      {SITE_NAV.map((g) =>
        g.links ? (
          <div key={g.label} className="relative">
            <button
              ref={(el) => {
                buttons.current[g.label] = el;
              }}
              type="button"
              aria-expanded={open === g.label}
              aria-controls={`site-nav-${g.label}`}
              onClick={() => setOpen(open === g.label ? null : g.label)}
              className={cn(
                "site-link inline-flex items-center gap-1 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium hover:text-cloud",
                g.links.some((l) => active(l.href)) ? "text-cloud" : "text-silver",
              )}
            >
              {g.label}
              <ChevronDown className={cn("size-3.5 transition-transform", open === g.label && "rotate-180")} aria-hidden />
            </button>
            <div
              id={`site-nav-${g.label}`}
              hidden={open !== g.label}
              className="site-dropdown absolute left-0 mt-2 w-80 rounded-xl border border-silver/15 bg-navy-2 p-2 shadow-2xl shadow-black/40"
            >
              <ul>
                {g.links.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      aria-current={active(l.href) ? "page" : undefined}
                      className="block rounded-lg px-3 py-2.5 hover:bg-white/5 aria-[current=page]:bg-white/[0.06]"
                    >
                      <span className="block text-sm font-semibold text-cloud">{l.label}</span>
                      {l.text ? <span className="mt-0.5 block text-xs leading-snug text-silver/80">{l.text}</span> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <Link
            key={g.label}
            href={g.href!}
            aria-current={active(g.href!) ? "page" : undefined}
            className="site-link whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-silver hover:text-cloud aria-[current=page]:text-cloud"
          >
            {g.label}
          </Link>
        ),
      )}
    </div>
  );
}
