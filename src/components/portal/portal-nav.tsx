"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import type { PortalFeatures } from "@/lib/portal";

/** Customer portal sections; only the ones the company turned on. */
export function PortalNav({ slug, features }: { slug: string; features: PortalFeatures }) {
  const path = usePathname();
  const base = `/portal/${slug}`;
  const items = [
    { href: base, label: "Overview", on: true },
    { href: `${base}/orders`, label: "Orders", on: features.orders },
    { href: `${base}/book`, label: "Book loads", on: Boolean(features.booking) },
    { href: `${base}/quotes`, label: "Quotes", on: features.quotes },
    { href: `${base}/sites`, label: "Job sites", on: features.orders },
    { href: `${base}/invoices`, label: "Invoices", on: Boolean(features.invoices) },
    { href: `${base}/support`, label: "Support", on: features.support },
    { href: `${base}/help`, label: "Help", on: features.help },
  ].filter((i) => i.on);
  // Every section stays in view on a phone (UX day-1): the tabs wrap onto a second row instead of scrolling off the
  // edge, where nothing told a customer that Job sites, Invoices, Support and Help were there.
  return (
    <nav aria-label="Portal" className="mx-auto w-full max-w-5xl px-4">
      <ul className="flex flex-wrap gap-x-1">
        {items.map((i) => {
          const active = i.href === base ? path === base : path === i.href || path.startsWith(`${i.href}/`);
          return (
            <li key={i.href}>
              <Link
                href={i.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-11 items-center border-b-2 px-2.5 sm:px-3 text-sm font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-strong",
                  active ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink",
                )}
              >
                {i.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
