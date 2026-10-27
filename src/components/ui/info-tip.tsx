"use client";

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Popover as P } from "radix-ui";

/**
 * The explanation behind a figure or section, one tap away instead of a paragraph on the page (owner's references
 * 2026-10-27: numbers first, words second). A popover, not a hover tooltip, so it works on touch and with the keyboard.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <P.Root>
      <P.Trigger
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-fg"
        aria-label={`About: ${label}`}
      >
        <Info className="size-4" aria-hidden />
      </P.Trigger>
      <P.Portal>
        <P.Content side="bottom" align="start" sideOffset={6} collisionPadding={12} className="ui-pop z-50 max-w-xs rounded-2xl border border-line/70 bg-card p-3.5 text-sm leading-relaxed text-ink shadow-float">
          {children}
          <P.Arrow className="fill-card" />
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
