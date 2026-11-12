import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface ConsoleTab {
  href: string;
  label: ReactNode;
  current?: boolean;
  /** A count shown after the label (e.g. records in that tab). */
  count?: number;
}

/**
 * The console's one tab style (docs/DESIGN_SYSTEM.md "Tabs"): a segmented control of links, the current one a raised
 * card. Tabs are links (each is a URL, so back/forward and sharing work); the current one carries aria-current.
 * Pass `label` to wrap them in their own <nav> landmark; leave it out when they sit inside another nav.
 */
export function ConsoleTabs({ items, label, className }: { items: ConsoleTab[]; label?: string; className?: string }) {
  const list = (
    <ul className={cn("inline-flex max-w-full snap-x gap-0.5 overflow-x-auto rounded-full bg-ink/[0.05] p-1 [scrollbar-width:none]", className)}>
      {items.map((t) => (
        <li key={t.href} className="shrink-0 snap-start">
          <Link
            href={t.href}
            aria-current={t.current ? "page" : undefined}
            className={cn(
              "console-press inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold whitespace-nowrap",
              t.current ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink",
            )}
          >
            <span className="pill-text">{t.label}</span>
            {t.count !== undefined ? <span className="pill-text text-xs font-medium text-muted tabular">{t.count.toLocaleString()}</span> : null}
          </Link>
        </li>
      ))}
    </ul>
  );
  return label ? <nav aria-label={label} className="max-w-full">{list}</nav> : list;
}
