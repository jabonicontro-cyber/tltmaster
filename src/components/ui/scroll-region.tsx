"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A box that scrolls (sideways when its content is wider than the screen, or down inside a fixed height). While it does, it can be focused so keyboard
 * users can scroll it with the arrow keys (WCAG 2.1.1; axe "scrollable-region-focusable"); when everything fits it is
 * not a tab stop (LR1, 2026-11-05).
 */
export function ScrollRegion({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setScrolls(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={cn("relative overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-strong", className)}
      tabIndex={scrolls ? 0 : undefined}
      role={scrolls && label ? "region" : undefined}
      aria-label={scrolls ? label : undefined}
    >
      {children}
    </div>
  );
}
