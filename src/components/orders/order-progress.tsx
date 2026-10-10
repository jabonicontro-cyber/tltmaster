import Link from "next/link";
import { ArrowRight, CheckCircle2, CircleDashed, Clock, TriangleAlert, Minus } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import type { ProgressStep, StepState } from "@/lib/orders/progress";

const ICONS: Record<StepState, { icon: typeof CheckCircle2; className: string; label: string }> = {
  done: { icon: CheckCircle2, className: "text-green-700", label: "Done" },
  attention: { icon: TriangleAlert, className: "text-amber-700", label: "Needs action" },
  waiting: { icon: Clock, className: "text-muted", label: "Waiting" },
  not_started: { icon: CircleDashed, className: "text-muted", label: "Not started" },
  unavailable: { icon: Minus, className: "text-muted", label: "Not shown" },
};

/** Dispatch → delivery tickets → billing readiness for one order, from the shared records. */
export function OrderProgress({ steps }: { steps: ProgressStep[] }) {
  return (
    <Card>
      <CardHeader
        title="Progress"
        description="From the order's loads, assignments, tickets and billing review — nothing here is entered twice. Driver pay is not tracked yet."
      />
      <ol className="grid grid-cols-1 divide-y divide-line md:grid-cols-3 md:divide-x md:divide-y-0" aria-label="Order progress">
        {steps.map((s) => {
          const I = ICONS[s.state];
          return (
            <li key={s.key} className="flex flex-col gap-1.5 px-4 py-3 sm:px-5" aria-label={`${s.label}: ${I.label}`}>
              <p className="flex items-center gap-1.5 text-sm font-bold text-ink">
                <I.icon className={cn("size-4", I.className)} aria-hidden /> {s.label}
                <span className="sr-only"> — {I.label}</span>
              </p>
              <p className="text-sm">{s.summary}</p>
              {s.owner && <p className="text-xs text-muted">Next: {s.owner}</p>}
              {s.next && (
                <Link href={s.next.href} className="mt-auto inline-flex items-center gap-1 text-sm font-semibold text-brand hover:underline">
                  {s.next.label} <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
