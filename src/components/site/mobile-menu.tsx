"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";

/**
 * The website's phone menu. Still a <details> element, so it opens without JavaScript; with JavaScript it also closes
 * the way people expect: after a link is followed (the header stays mounted across pages), on Escape (focus returns to
 * the button), and on a tap outside it, which only closes the menu and does not also press whatever was under the tap.
 */
export function MobileMenu({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [pathname]);

  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const close = () => {
      menu.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !menu.open) return;
      close();
      menu.querySelector("summary")?.focus();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!menu.open || menu.contains(e.target as Node)) return;
      close();
      // Swallow the click that follows this tap, so closing the menu never also follows a link underneath it.
      const swallow = (c: MouseEvent) => {
        c.preventDefault();
        c.stopPropagation();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 400);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
    };
  }, []);

  return (
    <details ref={ref} className="site-menu group relative lg:hidden">
      {/* 44 × 44: the smallest comfortable touch target. */}
      <summary className="flex size-11 cursor-pointer list-none items-center justify-center rounded-md text-silver hover:text-cloud [&::-webkit-details-marker]:hidden" aria-label="Menu">
        <Menu className="size-6" aria-hidden />
      </summary>
      {children}
    </details>
  );
}
