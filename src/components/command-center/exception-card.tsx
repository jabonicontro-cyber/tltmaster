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

const dotTone: Record<number, string> = { 1: "bg-critical", 2: "bg-amber-500", 3: "bg-muted/40" };

/**
 * One queue item as a compact row: what is wrong and where (one line), the main reason and who acts next (one muted
 * line), and the one action that fixes it. Further reasons, reassigning and hiding are secondary.
 */
export function ExceptionCard({ item, can, people, timezone, now, back }: { item: ExceptionItem & { hidden_until?: string | null }; can: { ticketsEdit: boolean; dispatch: boolean; assign: boolean }; people: Person[]; timezone: string; now: Date; back: string }) {
  const action = exceptionAction(item, can);
  const hiddenUntil = item.hidden_until ?? null;
  const title = exceptionTitle(item);
  const age = ageLabel(item.since, now);
  const reasons = exceptionReasons(item);
  return (
    <li className="group grid gap-x-4 gap-y-2 px-4 py-3 hover:bg-surface/50 sm:grid-cols-[1fr_auto] sm:items-center sm:px-5" aria-label={title}>
      <div className="flex min-w-0 gap-3">
        <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", dotTone[item.priority] ?? dotTone[3])} aria-hidden />
        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-medium text-ink">{title}</span>
            {item.priority === 1 && <span className="text-xs font-semibold text-critical">{PRIORITY_LABELS[1] ?? "Urgent"}</span>}
            {item.customer_name && <span className="text-sm text-muted">{item.customer_name}</span>}
          </p>
          {/* Every reason is kept (joined, at most two lines); none is hidden behind a count. */}
          <p className="mt-0.5 line-clamp-2 text-sm text-muted" title={reasons.join(" ")}>
            <span className="font-medium text-ink/70">{KIND_LABELS[item.kind]}</span>
            {reasons.length ? ` · ${reasons.join(" · ")}` : ""}
            {" · "}
            {item.assignee_name ? <Badge tone="blue">{item.assignee_name}</Badge> : <span>{exceptionOwner(item)}</span>}
            {item.assignment_note ? ` — ${item.assignment_note}` : ""}
            {age && (
              <span className="ml-1 inline-flex items-center gap-1 whitespace-nowrap" title={item.since ? formatDateTime(item.since, timezone) : undefined}>
                · <Clock className="size-3" aria-hidden /> {age === "upcoming" ? "due later" : `open ${age}`}
              </span>
            )}
          </p>
          {hiddenUntil && <p className="mt-0.5 text-xs font-semibold text-muted">Hidden from your view until {formatDateTime(hiddenUntil, timezone)} — still open.</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-5 sm:justify-end sm:pl-0">
        {item.priority > 1 && <HideControl itemKey={item.exception_key} hiddenUntil={hiddenUntil} />}
        {can.assign && <AssignControl itemKey={item.exception_key} kind={item.kind} title={title} assignedTo={item.assigned_to} people={people} />}
        <ButtonLink href={withReturn(action.href, back)} size="sm" variant="secondary" icon={<ArrowRight className="size-4" />}>{action.label}</ButtonLink>
      </div>
    </li>
  );
}
