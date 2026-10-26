import { ArrowRight, Clock } from "lucide-react";
import { Badge, UrgentPill } from "@/components/ui/badge";
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
 * One queue item as a tile (owner 2026-10-26: tiles, not a list): the kind and age on top, what is wrong and for whom,
 * the reasons and who acts next, then the one action that fixes it. Hiding and assigning are quiet icon buttons in the
 * tile's footer. Rendered as a list item so the queue stays a list for assistive technology.
 */
export function ExceptionCard({ item, can, people, timezone, now, back }: { item: ExceptionItem & { hidden_until?: string | null }; can: { ticketsEdit: boolean; dispatch: boolean; assign: boolean }; people: Person[]; timezone: string; now: Date; back: string }) {
  const action = exceptionAction(item, can);
  const hiddenUntil = item.hidden_until ?? null;
  const title = exceptionTitle(item);
  const age = ageLabel(item.since, now);
  const reasons = exceptionReasons(item);
  const urgent = item.priority === 1;
  return (
    <li
      className={cn(
        "group flex min-w-0 flex-col rounded-panel border bg-card p-5 shadow-card transition-shadow duration-150 hover:shadow-float",
        urgent ? "urgent-edge" : "border-line/70",
      )}
      aria-label={title}
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-ink/[0.05] px-2.5 pt-0.5 pb-[3px] text-xs leading-4 font-medium text-ink/75">
          <span className={cn("size-1.5 shrink-0 rounded-full", dotTone[item.priority] ?? dotTone[3])} aria-hidden />
          <span className="truncate">{KIND_LABELS[item.kind]}</span>
        </span>
        {urgent && <UrgentPill label={PRIORITY_LABELS[1] ?? "Urgent"} />}
        {age && (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs whitespace-nowrap text-muted tabular" title={item.since ? formatDateTime(item.since, timezone) : undefined}>
            <Clock className="size-3" aria-hidden /> {age === "upcoming" ? "due later" : `open ${age}`}
          </span>
        )}
      </div>
      <p className="mt-3.5 line-clamp-2 leading-snug font-semibold text-ink">{title}</p>
      {item.customer_name && <p className="mt-1 truncate text-sm text-muted">{item.customer_name}</p>}
      {/* Every reason is kept (at most three lines; the full text is the tooltip). */}
      {reasons.length > 0 && (
        <p className="mt-2.5 line-clamp-3 text-sm text-muted" title={reasons.join(" ")}>
          {reasons.join(" · ")}
        </p>
      )}
      <p className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
        {item.assignee_name ? <Badge tone="blue">{item.assignee_name}</Badge> : <span>{exceptionOwner(item)}</span>}
        {item.assignment_note && <span className="line-clamp-1">— {item.assignment_note}</span>}
      </p>
      {hiddenUntil && <p className="mt-1.5 text-xs font-semibold text-muted">Hidden from your view until {formatDateTime(hiddenUntil, timezone)} — still open.</p>}
      {/* Footers line up across a row of tiles: the spacer takes the leftover height. */}
      <div className="min-h-4 flex-1" aria-hidden />
      <div className="flex items-center gap-2 border-t border-line/70 pt-3.5">
        <ButtonLink href={withReturn(action.href, back)} size="sm" variant="secondary" icon={<ArrowRight className="size-4" />} className="min-w-0">
          <span className="truncate">{action.label}</span>
        </ButtonLink>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {item.priority > 1 && <HideControl itemKey={item.exception_key} hiddenUntil={hiddenUntil} compact />}
          {can.assign && <AssignControl itemKey={item.exception_key} kind={item.kind} title={title} assignedTo={item.assigned_to} people={people} compact />}
        </span>
      </div>
    </li>
  );
}
