"use client";

import { DropdownMenu as M } from "radix-ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { APP_CONTAINER } from "@/lib/layout";
import { CONSOLE_GROUPS, LAUNCHPAD, SUPPORT_LINKS, currentGroup, currentLink, type ConsoleGroup } from "./ui/nav";
import { ConsoleTabs } from "./ui/tabs";

const topLink = "console-press inline-flex h-9 items-center gap-1 rounded-full px-3 text-sm whitespace-nowrap";

/**
 * The console's navigation landmark ("Platform"). Admins: the Launchpad and five menus (Sales, Customers, Demos,
 * Support, Admin) on wide screens, and under the header the current group's pages as tabs, so the current page is
 * always on screen, phones included (the full menu is ConsoleMobileMenu there). Support staff: the company access
 * desk only. The tab bar is positioned under the header row (the header reserves its height) but stays inside this
 * landmark, so "current page" is one place for screen readers and tests.
 */
export function AdminNav({ level = "admin" }: { level?: "admin" | "support" }) {
  const path = usePathname();
  if (level !== "admin") {
    const here = currentLink(path, SUPPORT_LINKS);
    return (
      <nav aria-label="Platform" className="flex min-w-0 items-center">
        {SUPPORT_LINKS.map((l) => (
          <Link key={l.href} href={l.href} aria-current={here === l ? "page" : undefined} className={cn(topLink, "font-semibold", here === l ? "bg-ink/[0.06] text-ink" : "text-muted hover:text-ink")}>
            <span className="pill-text">{l.label}</span>
          </Link>
        ))}
      </nav>
    );
  }
  const group = currentGroup(path);
  const here = currentLink(path);
  return (
    <nav aria-label="Platform" className="flex min-w-0 items-center">
      <div className="hidden items-center gap-0.5 lg:flex">
        <Link
          href={LAUNCHPAD.href}
          aria-current={here === LAUNCHPAD ? "page" : undefined}
          className={cn(topLink, here === LAUNCHPAD ? "bg-ink/[0.06] font-semibold text-ink" : "font-medium text-muted hover:text-ink")}
        >
          <span className="pill-text">{LAUNCHPAD.label}</span>
        </Link>
        {CONSOLE_GROUPS.map((g) => (
          <GroupMenu key={g.label} group={g} current={g === group} path={path} />
        ))}
      </div>
      {group ? (
        <div className="absolute inset-x-0 top-16 h-12">
          <div className={cn(APP_CONTAINER, "flex h-full items-center gap-3")}>
            <span className="hidden text-sm font-medium text-muted sm:inline lg:hidden">{group.label}</span>
            <ConsoleTabs items={group.links.map((l) => ({ href: l.href, label: l.label, current: l === here }))} />
          </div>
        </div>
      ) : null}
    </nav>
  );
}

/** One group: a button that opens its pages, each with a line saying what it is for (like the website's menus). */
function GroupMenu({ group, current, path }: { group: ConsoleGroup; current: boolean; path: string }) {
  return (
    <M.Root modal={false}>
      <M.Trigger
        className={cn(
          topLink,
          "group outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-fg data-[state=open]:bg-ink/[0.06] data-[state=open]:text-ink",
          current ? "bg-ink/[0.06] font-semibold text-ink" : "font-medium text-muted hover:text-ink",
        )}
      >
        <span className="pill-text">{group.label}</span>
        <ChevronDown className="size-3.5 opacity-70 transition-transform duration-200 group-data-[state=open]:rotate-180" aria-hidden />
      </M.Trigger>
      <M.Portal>
        <M.Content
          align="start"
          sideOffset={8}
          className="console ui-pop z-50 w-80 origin-(--radix-dropdown-menu-content-transform-origin) rounded-2xl border border-line/70 bg-card p-1.5 text-ink shadow-float"
        >
          <M.Label className="px-3 pt-2 pb-1 text-xs font-medium text-muted">{group.label}</M.Label>
          {group.links.map((l) => {
            const here = currentLink(path) === l;
            return (
              <M.Item key={l.href} asChild>
                <Link
                  href={l.href}
                  aria-current={here ? "page" : undefined}
                  className="flex items-start gap-3 rounded-xl px-3 py-2.5 outline-none data-[highlighted]:bg-ink/[0.045] aria-[current=page]:bg-brand-light"
                >
                  <span className="min-w-0 flex-1">
                    <span className={cn("block text-sm font-semibold", here ? "text-brand-fg" : "text-ink")}>{l.label}</span>
                    <span className="mt-0.5 block text-xs leading-snug text-muted">{l.text}</span>
                  </span>
                  {here ? <Check className="mt-0.5 size-4 shrink-0 text-brand-fg" aria-hidden /> : null}
                </Link>
              </M.Item>
            );
          })}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}
