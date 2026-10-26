import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** `urgent`: the red edge for urgent records (owner 2026-10-26), the same edge as urgent tiles in the attention queue. */
export function Card({ className, children, urgent = false }: { className?: string; children: ReactNode; urgent?: boolean }) {
  return <section className={cn("rounded-panel border bg-card shadow-card", urgent ? "border-critical/40" : "border-line/70", className)}>{children}</section>;
}

/** Without a title (the section above already names it), only the description and actions show. */
export function CardHeader({ title, description, actions, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 px-5 pt-5 pb-1 sm:px-6", className)}>
      <div className="min-w-0">
        {title && <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">{title}</h2>}
        {description && <p className={title ? "mt-0.5 text-sm text-muted" : "text-sm text-muted"}>{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("px-5 py-4 sm:px-6", className)}>{children}</div>;
}
