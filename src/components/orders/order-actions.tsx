"use client";

import Link from "next/link";
import { DateInput } from "@/components/ui/date-input";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarDays, CheckCircle2, PauseCircle, Pencil, Play, Truck, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonClasses } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/form";
import {
  allowedOrderTransitions,
  canEditOrderDetails,
  canEditOrderLines,
  orderTransitionLabel,
  orderTransitionNeedsReason,
  orderTransitionNeedsSchedule,
  orderTransitionPermission,
  scheduleRequired,
} from "@/lib/orders/status";
import type { OrderStatus } from "@/server/data/types";
import { setOrderStatus, updateOrderSchedule } from "@/app/(app)/orders/actions";

interface Props {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  sourceQuoteId: string | null;
  editSeq: number;
  lineCount: number;
  schedule: { start: string | null; end: string | null; windowStart: string | null; windowEnd: string | null; notes: string };
  orderDate: string;
  permissions: { edit: boolean; schedule: boolean };
  /** Facts shown before completing the order (completing never waits for tickets; billing readiness does). */
  completionCheck?: { loadsWithoutTicket: number; ticketsAwaitingReview: number; loadsStillToRun: number };
}

const FORWARD: OrderStatus[] = ["confirmed", "scheduled", "dispatched", "in_progress", "completed"];

function iconFor(to: OrderStatus) {
  switch (to) {
    case "confirmed":
    case "completed":
      return <CheckCircle2 className="size-4" />;
    case "scheduled":
      return <CalendarDays className="size-4" />;
    case "dispatched":
      return <Truck className="size-4" />;
    case "in_progress":
      return <Play className="size-4" />;
    case "on_hold":
      return <PauseCircle className="size-4" />;
    case "canceled":
      return <XCircle className="size-4" />;
    default:
      return undefined;
  }
}

/** "HH:MM:SS" → "HH:MM" for <input type="time">. */
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : "");

export function OrderActions({ orderId, orderNumber, status: shownStatus, sourceQuoteId, editSeq: shownSeq, lineCount, schedule, orderDate, permissions, completionCheck }: Props) {
  const router = useRouter();
  // The server returns the new status and edit counter immediately; the page
  // props catch up after router.refresh(). Use whichever is newer so a quick
  // second click is not refused as a conflicting edit.
  const [latest, setLatest] = useState<{ status: OrderStatus; editSeq: number } | null>(null);
  const { status, editSeq } = latest && latest.editSeq > shownSeq ? latest : { status: shownStatus, editSeq: shownSeq };
  const [target, setTarget] = useState<OrderStatus | null>(null);
  const [note, setNote] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleThen, setScheduleThen] = useState<OrderStatus | null>(null);

  const allowed = allowedOrderTransitions(status).filter((t) => permissions[orderTransitionPermission(status, t) === "orders.edit" ? "edit" : "schedule"]);
  const hasSchedule = Boolean(schedule.start);
  const canEdit = permissions.edit && canEditOrderDetails(status);
  const editLabel = canEditOrderLines(status, sourceQuoteId) ? "Edit draft" : "Edit details";

  function choose(t: OrderStatus) {
    setNote("");
    // Scheduling needs a date first: open the schedule form, then change the status.
    if (orderTransitionNeedsSchedule(t) && !hasSchedule) {
      setScheduleThen(t);
      setScheduleOpen(true);
      return;
    }
    setTarget(t);
  }

  return (
    <div className="flex flex-wrap gap-2">
      {canEdit && (
        <Link href={`/orders/${orderId}/edit`} className={buttonClasses("secondary")}>
          <Pencil className="size-4" aria-hidden /> {editLabel}
        </Link>
      )}
      {permissions.schedule && canEditOrderDetails(status) && (
        <Button variant="secondary" icon={<CalendarDays className="size-4" />} onClick={() => { setScheduleThen(null); setScheduleOpen(true); }}>
          {hasSchedule ? "Change schedule" : "Set schedule"}
        </Button>
      )}
      {allowed.map((t) => (
        <Button
          key={t}
          variant={t === "canceled" ? "danger" : FORWARD.includes(t) && !(status === "scheduled" && t === "confirmed") && !(status === "dispatched" && t === "scheduled") ? "primary" : "secondary"}
          icon={iconFor(t)}
          disabled={t === "confirmed" && status === "draft" && lineCount === 0}
          title={t === "confirmed" && status === "draft" && lineCount === 0 ? "Add at least one line first" : undefined}
          onClick={() => choose(t)}
        >
          {orderTransitionLabel(status, t)}
        </Button>
      ))}

      <ConfirmDialog
        open={Boolean(target)}
        onOpenChange={(o) => !o && setTarget(null)}
        title={target ? `${orderTransitionLabel(status, target)} — ${orderNumber}` : ""}
        description={target ? describe(status, target, sourceQuoteId) : undefined}
        confirmLabel={target ? orderTransitionLabel(status, target) : "Confirm"}
        tone={target === "canceled" ? "danger" : "primary"}
        onConfirm={async () => {
          if (!target) return;
          const r = await setOrderStatus({ orderId, from: status, status: target, note, expectedEditSeq: editSeq });
          if (!r.ok) return r.error;
          setLatest(r.data);
          toast.success(r.message ?? "Status updated");
          router.refresh();
        }}
      >
        {target === "completed" && completionCheck && completionCheck.loadsWithoutTicket + completionCheck.ticketsAwaitingReview + completionCheck.loadsStillToRun > 0 && (
          <div role="note" className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            <p className="font-semibold">Before you complete it:</p>
            <ul className="list-disc pl-5">
              {completionCheck.loadsStillToRun > 0 && <li>{completionCheck.loadsStillToRun} planned load(s) have not run yet.</li>}
              {completionCheck.loadsWithoutTicket > 0 && <li>{completionCheck.loadsWithoutTicket} delivered load(s) have no delivery ticket.</li>}
              {completionCheck.ticketsAwaitingReview > 0 && <li>{completionCheck.ticketsAwaitingReview} ticket(s) are received but not verified.</li>}
            </ul>
            <p className="mt-1">You can still complete it (paper tickets often arrive later); billing stays blocked until every load has a verified ticket.</p>
          </div>
        )}
        {target && (
          <Field
            label={orderTransitionNeedsReason(target) ? "Reason" : "Note (optional)"}
            htmlFor="order-status-note"
            required={orderTransitionNeedsReason(target)}
            hint="Shown in the order history."
          >
            <Input
              id="order-status-note"
              value={note}
              maxLength={1000}
              onChange={(e) => setNote(e.target.value)}
              placeholder={target === "on_hold" ? "e.g. Site not ready — customer will call" : target === "canceled" ? "e.g. Customer canceled the project" : ""}
            />
          </Field>
        )}
      </ConfirmDialog>

      {scheduleOpen && (
        <ScheduleDialog
          orderId={orderId}
          orderNumber={orderNumber}
          status={status}
          editSeq={editSeq}
          orderDate={orderDate}
          initial={schedule}
          then={scheduleThen}
          onClose={() => setScheduleOpen(false)}
          onSaved={(newSeq) => {
            setScheduleOpen(false);
            setLatest({ status, editSeq: newSeq });
            if (scheduleThen) {
              // Continue with the status change the user asked for.
              void setOrderStatus({ orderId, from: status, status: scheduleThen, note: "", expectedEditSeq: newSeq }).then((r) => {
                if (r.ok) {
                  setLatest(r.data);
                  toast.success(r.message ?? "Status updated");
                } else toast.error(r.error);
                router.refresh();
              });
            } else {
              router.refresh();
            }
          }}
        />
      )}
    </div>
  );
}

function describe(from: OrderStatus, to: OrderStatus, sourceQuoteId: string | null): string | undefined {
  switch (to) {
    case "confirmed":
      if (from === "draft")
        return sourceQuoteId
          ? "Confirms the order."
          : "Confirms the order with the customer. Lines, prices and terms are locked after confirmation; details and the schedule can still change.";
      if (from === "scheduled") return "Moves the order back to Confirmed. The scheduled date is kept as a note of the previous plan.";
      return "Releases the hold. The order goes back to Confirmed.";
    case "scheduled":
      return from === "dispatched" ? "Recalls the order to Scheduled (for example, the truck was reassigned)." : "Marks the order as scheduled for its delivery date.";
    case "dispatched":
      return "Records that the work has been assigned and sent out.";
    case "in_progress":
      return "Records that delivery or work has started.";
    case "partially_completed":
      return "Some of the work is done and more remains.";
    case "completed":
      return "Completed orders are final and can no longer be edited. History is kept.";
    case "on_hold":
      return "Pauses the order. It can be released back to Confirmed or Scheduled later.";
    case "canceled":
      return "Canceled orders are final and cannot be reopened. History is kept.";
    default:
      return undefined;
  }
}

function ScheduleDialog({
  orderId,
  orderNumber,
  status,
  editSeq,
  orderDate,
  initial,
  then,
  onClose,
  onSaved,
}: {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  editSeq: number;
  orderDate: string;
  initial: Props["schedule"];
  then: OrderStatus | null;
  onClose: () => void;
  onSaved: (editSeq: number) => void;
}) {
  const [start, setStart] = useState(initial.start ?? "");
  const [end, setEnd] = useState(initial.end ?? "");
  const [windowStart, setWindowStart] = useState(hhmm(initial.windowStart));
  const [windowEnd, setWindowEnd] = useState(hhmm(initial.windowEnd));
  const [notes, setNotes] = useState(initial.notes);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mustHaveDate = scheduleRequired(status) || Boolean(then);

  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Schedule ${orderNumber}`}
      description={then ? `Set the delivery date, then the order will be marked ${orderTransitionLabel(status, then).replace(/^Mark /, "").toLowerCase()}.` : "Delivery date or date range, optional daily time window, and notes for the crew."}
      confirmLabel={then ? `Save and ${orderTransitionLabel(status, then).toLowerCase()}` : "Save schedule"}
      onConfirm={async () => {
        setErrors({});
        if (mustHaveDate && !start) {
          setErrors({ scheduledStart: "Choose a date." });
          return "A scheduled date is required.";
        }
        const r = await updateOrderSchedule({ orderId, expectedEditSeq: editSeq, scheduledStart: start, scheduledEnd: end, windowStart, windowEnd, schedulingNotes: notes });
        if (!r.ok) {
          setErrors(r.fieldErrors ?? {});
          return r.error;
        }
        if (!then) toast.success(r.message ?? "Schedule saved");
        onSaved(r.data.editSeq);
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Delivery date" htmlFor="sched-start" required={mustHaveDate} error={errors.scheduledStart}>
          <DateInput id="sched-start" min={orderDate} value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Through (multi-day)" htmlFor="sched-end" error={errors.scheduledEnd} hint="Optional">
          <DateInput id="sched-end" min={start || orderDate} value={end} disabled={!start} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <Field label="Window from" htmlFor="sched-wstart" error={errors.windowStart} hint="Optional">
          <Input id="sched-wstart" type="time" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} />
        </Field>
        <Field label="Window to" htmlFor="sched-wend" error={errors.windowEnd}>
          <Input id="sched-wend" type="time" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} />
        </Field>
        <Field label="Scheduling notes" htmlFor="sched-notes" error={errors.schedulingNotes} className="col-span-2">
          <Textarea id="sched-notes" rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. First load before 8 am; call foreman on arrival" />
        </Field>
      </div>
    </ConfirmDialog>
  );
}
