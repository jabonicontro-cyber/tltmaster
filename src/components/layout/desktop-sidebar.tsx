"use client";

import Link from "next/link";
import { PanelLeftClose, PanelLeftOpen, Pin, PinOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { TavironEmblem } from "./brand";
import { CompanyIdentity } from "./company-identity";
import { SidebarNav } from "./sidebar-nav";
import type { Permission } from "@/lib/permissions";
import { SIDEBAR_COOKIE } from "./sidebar-cookie";

// Hover intent: a pointer passing over the rail on its way elsewhere does not
// open it, and a brief exit does not close it — no flicker.
const OPEN_DELAY = 120;
const CLOSE_DELAY = 250;

/**
 * Navigation from the lg breakpoint (1024 px) up — laptops, desktops and tablets in landscape: a compact icon rail.
 * It expands over the page with the toggle at its top (the touch way: tap to open, tap again, tap outside, Escape or
 * choosing a page closes it), while a mouse rests on it, or while keyboard focus is inside it; pinned, it stays open
 * and the page makes room. Hover is only a mouse convenience — every label is reachable without it. Narrower screens
 * (phones, tablets in portrait) use the menu button (MobileNav).
 */
export function DesktopSidebar({ permissions, companyName, logoUrl, initiallyPinned }: { permissions: Permission[]; companyName: string | null; logoUrl: string; initiallyPinned: boolean }) {
  const [pinned, setPinned] = useState(initiallyPinned);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Opened with the toggle (touch, pen or mouse): stays open until closed on purpose, never by scrolling.
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  const expanded = pinned || hovered || focused || open;

  const schedule = useCallback((next: boolean, delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHovered(next), delay);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // The page content makes room only when the sidebar is pinned.
  useEffect(() => {
    asideRef.current?.closest(".app-root")?.setAttribute("data-sidebar", pinned ? "pinned" : "rail");
  }, [pinned]);

  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    setOpen(false);
    if (!next) setHovered(false);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "pinned" : "rail"}; path=/; max-age=31536000; samesite=lax`;
  };

  const toggle = () => {
    if (pinned) togglePin(); // "Collapse navigation" on a pinned sidebar unpins it
    else if (expanded) {
      setOpen(false);
      setHovered(false);
      setFocused(false);
    } else setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setHovered(false);
  };

  return (
    <>
    {open && !pinned && (
      // Tap outside closes the opened rail; it covers the page only while the rail is open over it.
      <div className="no-print fixed inset-0 z-[25] hidden bg-black/20 lg:block" aria-hidden onClick={close} data-testid="sidebar-backdrop" />
    )}
    <aside
      ref={asideRef}
      aria-label="Sidebar"
      data-expanded={expanded ? "true" : "false"}
      onPointerEnter={(e) => { if (e.pointerType === "mouse") schedule(true, OPEN_DELAY); }}
      onPointerLeave={(e) => { if (e.pointerType === "mouse") schedule(false, CLOSE_DELAY); }}
      // Keyboard focus only: a mouse click leaves focus on the link or button, and that must not hold the rail open.
      onFocus={(e) => { if (e.target.matches(":focus-visible")) setFocused(true); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pinned) {
          setHovered(false);
          setOpen(false);
          document.getElementById("main")?.focus();
        }
      }}
      className={cn(
        "no-print fixed inset-y-0 left-0 z-30 hidden flex-col overflow-x-hidden bg-charcoal lg:flex",
        "transition-[width,box-shadow] duration-200 ease-out motion-reduce:transition-none",
        expanded ? "w-64" : "w-[4.5rem]",
        expanded && !pinned && "shadow-2xl",
      )}
    >
      <Link href="/command-center" className="flex h-16 shrink-0 items-center border-b border-white/10 px-4" aria-label={`${companyName ?? "Company"} — home`}>
        {expanded ? <CompanyIdentity name={companyName} logoUrl={logoUrl} /> : <CompanyIdentity name={companyName} logoUrl={logoUrl} compact />}
      </Link>
      <div className="shrink-0 px-3 pt-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls="sidebar-nav"
          title={!expanded ? "Expand navigation" : undefined}
          className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap text-white/80 hover:bg-white/[0.06] hover:text-white focus-visible:outline-2 focus-visible:outline-white/60"
        >
          {expanded ? <PanelLeftClose className="size-[18px] shrink-0" aria-hidden /> : <PanelLeftOpen className="size-[18px] shrink-0" aria-hidden />}
          <span className={cn("transition-opacity duration-150 motion-reduce:transition-none", !expanded && "sr-only")}>{expanded ? "Collapse navigation" : "Expand navigation"}</span>
        </button>
      </div>
      <div id="sidebar-nav" className="relative flex-1 overflow-x-hidden overflow-y-auto py-3">
        <SidebarNav permissions={permissions} collapsed={!expanded} onNavigate={close} />
      </div>
      <div className="shrink-0 border-t border-white/10 px-3 py-2">
        <button
          type="button"
          onClick={togglePin}
          aria-pressed={pinned}
          title={!expanded ? "Keep sidebar open" : undefined}
          className="flex min-h-10 w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap text-white/70 hover:bg-white/[0.06] hover:text-white focus-visible:outline-2 focus-visible:outline-white/60"
        >
          {pinned ? <PinOff className="size-[18px] shrink-0" aria-hidden /> : <Pin className="size-[18px] shrink-0" aria-hidden />}
          <span className={cn("transition-opacity duration-150 motion-reduce:transition-none", !expanded && "opacity-0")}>{pinned ? "Unpin sidebar" : "Keep sidebar open"}</span>
        </button>
        <p className="flex items-center gap-2 px-3 py-2 text-xs whitespace-nowrap text-white/55">
          <TavironEmblem className="size-4 shrink-0 opacity-80" />
          <span className={cn("transition-opacity duration-150 motion-reduce:transition-none", !expanded && "opacity-0")}>Powered by Taviron</span>
        </p>
      </div>
    </aside>
    </>
  );
}
