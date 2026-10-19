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
    { href: `${base}/quotes`, label: "Quotes", on: features.quotes },
    { href: `${base}/support`, label: "Support", on: features.support },
    { href: `${base}/help`, label: "Help", on: features.help },
  ].filter((i) => i.on);
  return (
    <nav aria-label="Portal" className="mx-auto w-full max-w-5xl overflow-x-auto px-4">
      <ul className="flex gap-1">
        {items.map((i) => {
          const active = i.href === base ? path === base : path === i.href || path.startsWith(`${i.href}/`);
          return (
            <li key={i.href}>
              <Link
                href={i.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-11 items-center border-b-2 px-3 text-sm font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-strong",
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
