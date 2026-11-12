import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/**
 * The navy band: the website's dark sections (hero, footer) inside the console, for a page's one summary (the
 * Launchpad's state of the business). Navy in both themes; text inside uses `text-cloud` (strong) and `text-silver`
 * (secondary), links `text-brand-fg` (a light blue here). Put a StatGrid with `onNavy` in it for figures.
 */
export function ConsoleBand({ className, children, ...props }: ComponentProps<"section">) {
  return (
    <section className={cn("console-band relative overflow-hidden rounded-2xl ring-1 ring-white/[0.06]", className)} {...props}>
      {children}
    </section>
  );
}
