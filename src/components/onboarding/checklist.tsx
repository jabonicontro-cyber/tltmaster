import Link from "next/link";
import { FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatDateTime } from "@/lib/dates";
import { formatBytes } from "@/lib/communications";
import type { ReadinessItem } from "@/lib/onboarding/readiness";
import {
  SIDE_LABEL, SIDE_LABEL_STAFF, STATUS_TONE, customerActions, customerOrder, isFinished, isOverdue, needsCustomer, staffActions, statusLabel,
  type OnboardingEvent, type OnboardingState, type OnboardingTask,
} from "@/lib/onboarding/tasks";
import { RemindButton, TaskAssignForm, TaskCommentForm, TaskDocumentUpload, TaskStatusActions, type ChecklistSide } from "./task-forms";

const READINESS_LABEL: Record<ReadinessItem["status"], string> = { done: "Records complete", incomplete: "Records incomplete", missing: "No records yet" };
const READINESS_TONE: Record<ReadinessItem["status"], "green" | "amber" | "gray"> = { done: "green", incomplete: "amber", missing: "gray" };

function eventLine(e: OnboardingEvent, staff: boolean): string {
  const who = e.actor_side === "system" ? "Taviron" : e.actor_side === "taviron" ? (staff && e.actor_name ? e.actor_name : "Taviron") : (e.actor_name ?? "Your team");
  switch (e.kind) {
    case "status": return `${who}: ${e.from_status ? statusLabel(e.from_status) : "—"} → ${e.to_status ? statusLabel(e.to_status) : "—"}${e.body ? ` — ${e.body}` : ""}`;
    case "comment": return `${who}${e.internal ? " (internal)" : ""}: ${e.body}`;
    default: return `${who}: ${e.body}`;
  }
}

/** Summary counts for both views (the same numbers the database computes). */
export function OnboardingSummaryBar({ state, side }: { state: OnboardingState; side: ChecklistSide }) {
  const s = state.summary;
  const items: Array<{ label: string; value: number; tone?: string }> = [
    { label: "Required done", value: s.required_done },
    { label: side === "staff" ? "Waiting on the customer" : "Your actions", value: s.customer_actions },
    { label: side === "staff" ? "Waiting on your review" : "With Taviron for review", value: s.review },
    { label: "Blocked", value: s.blocked, tone: s.blocked ? "text-critical" : undefined },
    { label: "Overdue", value: s.overdue, tone: s.overdue ? "text-critical" : undefined },
  ];
  return (
    <div className="rounded-panel border border-line/70 bg-card shadow-card p-4">
      <p className="text-sm text-ink" aria-live="polite">
        <span className="font-semibold">{s.required_done} of {s.required}</span> required tasks finished
        {s.ready ? " — every required task is approved or not applicable. Taviron agrees the go-live date with you separately; finishing onboarding never changes it and never starts billing." : "."}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {items.map((i) => (
          <div key={i.label}>
            <dt className="text-xs text-muted">{i.label}</dt>
            <dd className={`text-lg font-bold tabular-nums ${i.tone ?? "text-ink"}`}>{i.label === "Required done" ? `${i.value}/${s.required}` : i.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function TaskCard({ task, side, companyId, people, readiness, today, staff }: {
  task: OnboardingTask; side: ChecklistSide; companyId?: string; people: Array<{ id: string; name: string }>;
  readiness?: ReadinessItem; today: string; staff: boolean;
}) {
  const actions = side === "staff" ? staffActions(task) : customerActions(task);
  const overdue = isOverdue(task, today);
  const open = side === "staff" ? task.status === "submitted" || task.status === "blocked" : needsCustomer(task) && task.status !== "not_started";
  const canWork = side === "staff" || task.side !== "taviron";
  return (
    <li id={`task-${task.key}`} className="scroll-mt-24 rounded-panel border border-line/70 bg-card shadow-card">
      <details open={open} className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 p-4 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-ink">{task.title}</span>
            <span className="mt-0.5 block text-xs text-muted">
              {(staff ? SIDE_LABEL_STAFF : SIDE_LABEL)[task.side]}
              {task.review_required ? " · Taviron reviews" : ""}
              {task.required ? "" : " · Optional"}
              {task.assignee_name ? ` · ${task.assignee_name}` : ""}
              {task.due_on ? ` · Due ${formatDate(task.due_on)}` : ""}
            </span>
          </span>
          {overdue ? <Badge tone="critical-soft">Overdue</Badge> : null}
          <Badge tone={STATUS_TONE[task.status] === "red" ? "critical-soft" : STATUS_TONE[task.status]}>{statusLabel(task.status, task.review_required)}</Badge>
        </summary>
        <div className="space-y-4 border-t border-line p-4">
          <p className="text-sm text-ink">{task.instructions}</p>
          {task.status_note ? (
            <p className={`rounded-xl border p-3 text-sm ${task.status === "blocked" || task.status === "changes_requested" ? "border-critical/30 bg-surface text-ink" : "border-line bg-surface text-ink"}`}>
              <span className="font-semibold">{statusLabel(task.status, task.review_required)}:</span> {task.status_note}
            </p>
          ) : null}
          {task.unmet.length && !isFinished(task.status) ? (
            <p className="text-sm text-muted">Waiting on: {task.unmet.join(", ")}.</p>
          ) : null}
          {readiness ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={READINESS_TONE[readiness.status]}>{READINESS_LABEL[readiness.status]}</Badge>
              <span className="text-ink">{readiness.detail}</span>
              {readiness.status !== "done" ? <Link href={`${readiness.href}${readiness.href.includes("?") ? "&" : "?"}back=/setup`} className="font-semibold text-brand-fg hover:underline">Fix it</Link> : null}
            </div>
          ) : null}

          {task.documents.length ? (
            <div>
              <h4 className="text-sm font-semibold text-ink">Files</h4>
              <ul className="mt-1 space-y-1">
                {task.documents.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <FileText className="size-4 text-muted" aria-hidden />
                    <a href={`/onboarding/documents/${d.id}`} className="font-semibold text-brand-fg hover:underline">{d.file_name}</a>
                    <span className="text-xs text-muted">{formatBytes(d.size_bytes)} · {d.side === "taviron" ? "from Taviron" : "from the company"} · {formatDateTime(d.uploaded_at)}</span>
                    {staff && d.mime_type === "text/csv" && task.import_entity && companyId ? (
                      <Link href={`/admin/onboarding/${companyId}?document=${d.id}&entity=${task.import_entity}#import`} className="text-xs font-semibold text-brand-fg hover:underline">Import this file…</Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {canWork ? <TaskStatusActions side={side} taskId={task.id} companyId={companyId} actions={actions} /> : (
            <p className="text-sm text-muted">Taviron completes this task. You can follow it and add a message below.</p>
          )}
          {canWork && !isFinished(task.status) ? <TaskDocumentUpload side={side} taskId={task.id} /> : null}
          {canWork && !isFinished(task.status) ? (
            <TaskAssignForm side={side} taskId={task.id} companyId={companyId} people={people} assignee={task.assignee} dueOn={task.due_on} />
          ) : null}
          {staff && companyId && task.side !== "taviron" && !isFinished(task.status) && task.status !== "submitted" ? (
            <div className="flex flex-wrap items-center gap-2">
              <RemindButton taskId={task.id} companyId={companyId} />
              {task.last_reminded_at ? <span className="text-xs text-muted">Last reminded {formatDateTime(task.last_reminded_at)}</span> : null}
            </div>
          ) : null}

          <div>
            <h4 className="text-sm font-semibold text-ink">History and messages</h4>
            <ol className="mt-1 space-y-1">
              {task.events.slice(-12).map((e) => (
                <li key={e.id} className={`text-sm ${e.internal ? "text-muted italic" : "text-ink"}`}>
                  <span className="text-xs text-muted">{formatDateTime(e.created_at)} · </span>{eventLine(e, staff)}
                </li>
              ))}
            </ol>
          </div>
          <TaskCommentForm side={side} taskId={task.id} companyId={companyId} />
        </div>
      </details>
    </li>
  );
}

/**
 * The onboarding checklist. The company side and Taviron see the same tasks and states; Taviron also sees internal
 * notes, review actions, reminders and the import link. The database decides every change.
 */
export function OnboardingChecklist({ state, side, companyId, people = [], readiness = [], today }: {
  state: OnboardingState; side: ChecklistSide; companyId?: string; people?: Array<{ id: string; name: string }>; readiness?: ReadinessItem[]; today: string;
}) {
  const staff = side === "staff";
  const tasks = staff ? state.tasks : customerOrder(state.tasks);
  const byId = new Map(readiness.map((r) => [r.id, r]));
  return (
    <div className="space-y-4">
      <OnboardingSummaryBar state={state} side={side} />
      <ol className="space-y-3">
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} side={side} companyId={companyId} people={people} readiness={t.readiness_id ? byId.get(t.readiness_id) : undefined} today={today} staff={staff} />
        ))}
      </ol>
    </div>
  );
}
