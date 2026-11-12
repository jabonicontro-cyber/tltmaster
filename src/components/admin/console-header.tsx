"use client";

import { Dialog as D } from "radix-ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { AppWindow, Menu, Search, X } from "lucide-react";
import { BrandMark } from "@/components/layout/brand";
import { cn } from "@/lib/cn";
import { APP_CONTAINER } from "@/lib/layout";
import { AdminNav } from "./admin-nav";
import { AdminUserMenu } from "./admin-user-menu";
import { CONSOLE_GROUPS, LAUNCHPAD, currentGroup, currentLink, type ConsoleLink } from "./ui/nav";

export interface ConsoleUser {
  name: string;
  email: string;
  photo: string;
  roleTitle: string;
  profileHref?: string;
}

/**
 * The console's sticky header, in the website's style: translucent over the page, a soft edge once content scrolls
 * under it, the Taviron lockup on the left, the navigation, and the account menu on the right. When the current page
 * belongs to a group, that group's pages show as tabs in a second row (the header reserves its height).
 */
export function ConsoleHeader({ level, user }: { level: "admin" | "support"; user: ConsoleUser }) {
  const path = usePathname();
  const tabsRow = level === "support" || currentGroup(path) !== null;
  const home = level === "admin" ? "/admin" : "/staff";
  return (
    <header className={cn("console-header sticky top-0 z-40 bg-surface/85 backdrop-blur-xl backdrop-saturate-150", tabsRow && "pb-12")}>
      <div className={cn(APP_CONTAINER, "flex h-16 items-center gap-3 lg:gap-5")}>
        <Link href={home} className="console-press flex shrink-0 items-center gap-3 rounded-xl">
          <BrandMark tone="dark" />
          <span className="hidden h-5 items-center border-l border-line pl-3 text-sm font-medium text-muted sm:inline-flex" aria-hidden>
            Console
          </span>
          <span className="sr-only">, {level === "admin" ? "Launchpad" : "Company access"}</span>
        </Link>
        <AdminNav level={level} />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Link href="/staff/search" aria-label="Search the console" className="console-press flex size-11 items-center justify-center rounded-xl text-muted hover:bg-ink/[0.05] hover:text-ink">
            <Search className="size-5" aria-hidden />
          </Link>
          <AdminUserMenu {...user} />
          {level === "admin" ? <ConsoleMobileMenu path={path} /> : null}
        </div>
      </div>
    </header>
  );
}

/** Phones and tablets: every console page in one sheet, grouped as on desktop, the current page marked. */
function ConsoleMobileMenu({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const here = currentLink(path);
  const item = (l: ConsoleLink) => (
    <Link
      key={l.href}
      href={l.href}
      onClick={() => setOpen(false)}
      aria-current={here === l ? "page" : undefined}
      className="console-press flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-medium text-ink hover:bg-ink/[0.045] aria-[current=page]:bg-brand-light aria-[current=page]:font-semibold aria-[current=page]:text-brand-fg"
    >
      {l.label}
    </Link>
  );
  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Trigger className="console-press flex size-11 items-center justify-center rounded-xl text-ink hover:bg-ink/[0.05] lg:hidden" aria-label="Open menu">
        <Menu className="size-6" aria-hidden />
      </D.Trigger>
      <D.Portal>
        <D.Overlay className="ui-fade fixed inset-0 z-40 bg-navy/40 backdrop-blur-[2px] lg:hidden" />
        <D.Content className="console ui-pop fixed inset-y-2 right-2 z-50 flex w-80 max-w-[calc(100vw-1rem)] origin-top-right flex-col rounded-[1.5rem] border border-line/70 bg-card text-ink shadow-float focus:outline-none lg:hidden">
          <D.Title className="sr-only">Console menu</D.Title>
          <D.Description className="sr-only">Every page of the Taviron console</D.Description>
          <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-4">
            <BrandMark tone="dark" />
            <D.Close className="console-press flex size-11 items-center justify-center rounded-xl text-muted hover:bg-ink/[0.05] hover:text-ink" aria-label="Close menu">
              <X className="size-6" aria-hidden />
            </D.Close>
          </div>
          <nav aria-label="Console menu" className="flex-1 overflow-y-auto px-2 pb-3">
            {item(LAUNCHPAD)}
            {CONSOLE_GROUPS.map((g) => (
              <div key={g.label} className="mt-2 border-t border-line/70 pt-2">
                <p className="px-3 pt-1 pb-1 text-xs font-medium text-muted">{g.label}</p>
                {g.links.map(item)}
              </div>
            ))}
          </nav>
          <div className="shrink-0 border-t border-line/70 p-2">
            <Link href="/command-center" onClick={() => setOpen(false)} className="console-press flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-muted hover:bg-ink/[0.045] hover:text-ink">
              <AppWindow className="size-4" aria-hidden /> Open the app
            </Link>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
