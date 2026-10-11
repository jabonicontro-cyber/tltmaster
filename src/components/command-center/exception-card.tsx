import { ArrowRight, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import {
  KIND_LABELS, PRIORITY_LABELS, ageLabel, exceptionAction, exceptionOwner, exceptionReasons, exceptionTitle, type ExceptionItem,
} from "@/lib/command-center/rules";
import { withReturn } from "@/lib/safe-redirect";
import { HideControl } from "./hide-control";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/dates";
import { AssignControl, type Person } from "./assign-control";

const priorityTone: Record<number, string> = {
  1: "bg-critical text-white",
  2: "bg-amber-100 text-amber-950 ring-1 ring-amber-300",
  3: "bg-surface text-charcoal ring-1 ring-line",
};

export function ExceptionCard({ item, can, people, timezone, now, back }: { item: ExceptionItem & { hidden_until?: string | null }; can: { ticketsEdit: boolean; dispatch: boolean; assign: boolean }; people: Person[]; timezone: string; now: Date; back: string }) {
  const action = exceptionAction(item, can);
  const hiddenUntil = item.hidden_until ?? null;
  const title = exceptionTitle(item);
  const age = ageLabel(item.since, now);
  return (
    <li className={cn("grid gap-3 px-4 py-4 sm:grid-cols-[1fr_auto] sm:px-5", item.priority === 1 && "border-l-4 border-l-critical")} aria-label={title}>
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase", priorityTone[item.priority] ?? priorityTone[3])}>{PRIORITY_LABELS[item.priority] ?? "Normal"}</span>
          <span className="text-xs font-semibold tracking-wide text-muted uppercase">{KIND_LABELS[item.kind]}</span>
          {age && (
            <span className="inline-flex items-center gap-1 text-xs text-muted" title={item.since ? formatDateTime(item.since, timezone) : undefined}>
              <Clock className="size-3" aria-hidden /> {age === "upcoming" ? "due later" : `open ${age}`}
            </span>
          )}
        </div>
        <p className="font-semibold text-ink">{title}</p>
        {item.customer_name && <p className="text-sm text-muted">{item.customer_name}</p>}
        <ul className="list-disc space-y-0.5 pl-5 text-sm">
          {exceptionReasons(item).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
        {hiddenUntil && <p className="text-xs font-semibold text-muted">Hidden from your view until {formatDateTime(hiddenUntil, timezone)} — still open.</p>}
        <p className="text-sm text-muted">
          Next action: {item.assignee_name ? <Badge tone="blue">{item.assignee_name}</Badge> : exceptionOwner(item)}
          {item.assignment_note ? ` — ${item.assignment_note}` : ""}
        </p>
      </div>
      <div className="flex flex-col items-start gap-2 sm:items-end">
        <ButtonLink href={withReturn(action.href, back)} size="sm" icon={<ArrowRight className="size-4" />}>{action.label}</ButtonLink>
        {can.assign && <AssignControl itemKey={item.exception_key} kind={item.kind} title={title} assignedTo={item.assigned_to} people={people} />}
        {item.priority > 1 && <HideControl itemKey={item.exception_key} hiddenUntil={hiddenUntil} />}
      </div>
    </li>
  );
}
