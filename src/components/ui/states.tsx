import type { ReactNode } from "react";
import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

export function EmptyState({ title, description, action, icon, className, as: Title = "p" }: {
  title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode; className?: string;
  /** "h1" when the state is the whole page (not found, nothing to show yet), so the page still has a main heading. */
  as?: "p" | "h1" | "h2";
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      <div className="mb-4 rounded-2xl bg-surface p-3.5 text-muted">{icon ?? <Inbox className="size-6" aria-hidden />}</div>
      <Title className="text-base font-semibold text-ink">{title}</Title>
      {description && <p className="mt-1 max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = "Something went wrong", description, action }: { title?: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center rounded-panel border border-red-200 bg-red-50 px-6 py-10 text-center">
      <AlertTriangle className="mb-2 size-7 text-red-700" aria-hidden />
      <p className="text-base font-semibold text-red-900">{title}</p>
      {description && <p className="mt-1 max-w-lg text-sm text-red-800">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-muted">
      <Loader2 className={cn("size-5 animate-spin", className)} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-muted" role="status">
      <Loader2 className="size-5 animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: "info" | "warning"; title?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-2xl border px-4 py-3.5 text-sm",
        tone === "info" ? "border-blue-100 bg-blue-50 text-blue-900" : "border-amber-200 bg-amber-50 text-amber-950",
      )}
    >
      {title && <p className="font-semibold">{title}</p>}
      <div className={title ? "mt-0.5" : undefined}>{children}</div>
    </div>
  );
}
