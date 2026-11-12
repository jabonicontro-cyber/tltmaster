import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A quiet console card in the website's style: rounded-xl, a hairline border, almost no shadow. Use it for every
 * section of a console page instead of the heavier app Card. `id`/`aria-label` pass through (e.g. a named region).
 */
export function Panel({ className, children, ...props }: ComponentProps<"section">) {
  return (
    <section className={cn("min-w-0 rounded-xl border border-line bg-card shadow-[0_1px_2px_rgb(12_26_43/0.04)]", className)} {...props}>
      {children}
    </section>
  );
}

/**
 * The panel's heading row: title, an optional one-line description and actions on the right (links or a secondary
 * button; the page's main action belongs in the page header). Leave `title` out when the page heading already names it.
 */
export function PanelHeader({ title, description, actions, className, as: H = "h2" }: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  as?: "h2" | "h3";
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-5 pb-3 sm:px-6", className)}>
      <div className="min-w-0 max-w-2xl">
        {title ? <H className="text-[17px] font-semibold tracking-[-0.015em] text-ink">{title}</H> : null}
        {description ? <p className={cn("text-sm leading-relaxed text-muted", title && "mt-1")}>{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Padded content inside a panel. Lists and tables that run edge to edge go straight in the Panel instead. */
export function PanelBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("px-5 pt-1 pb-5 sm:px-6", className)}>{children}</div>;
}

/** A plain-text action link for panel headers and rows ("Full history", "Open the company"). */
export function PanelLink({ className, ...props }: ComponentProps<typeof Link>) {
  return <Link className={cn("text-sm font-semibold text-brand-fg underline-offset-4 hover:underline", className)} {...props} />;
}
