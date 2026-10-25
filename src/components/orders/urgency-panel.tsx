"use client";

import { useRouter } from "next/navigation";
import { DateInput } from "@/components/ui/date-input";
import { useState } from "react";
import { Siren } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/form";
import { flagOrderUrgent, updateOrderUrgency } from "@/app/(app)/orders/actions";
import { formatDateTime } from "@/lib/dates";
import { NOTE_REQUIRED, URGENCY_LABELS, URGENCY_NEXT_OWNER, urgencyActions, type UrgencyState } from "@/lib/orders/urgency";
import type { Permission } from "@/lib/permissions";
import type { UrgencyEventRow, UrgencyRow } from "@/server/data/urgency";

interface Props {
  orderId: string;
  orderClosed: boolean;
  open: UrgencyRow | null;
  events: UrgencyEventRow[];
  permissions: Permission[];
  names: Record<string, string>;
  timezone: string;
  today: string;
  /** Server time of this render (ISO), for "past needed-by". */
  now: string;
}

const stateTone = (s: UrgencyState) => (s === "awaiting_acknowledgement" || s === "blocked" ? "red" : s === "assigned" ? "green" : "amber");

/** The order's urgent flag: what, why, by when, its state, who acts next, and the allowed next steps. */
export function UrgencyPanel({ orderId, orderClosed, open, events, permissions, names, timezone, today, now }: Props) {
  const router = useRouter();
  const can = (p: Permission) => permissions.includes(p);
  const [flagOpen, setFlagOpen] = useState(false);
  const [move, setMove] = useState<{ state: UrgencyState; label: string } | null>(null);
  const [reason, setReason] = useState(open?.reason ?? "");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [note, setNote] = useState("");
  const who = (id: string | null) => (id ? names[id] ?? "Former user" : "System");
  const actions = open ? urgencyActions(open.state, can) : [];
  const overdue = open?.needed_by ? new Date(open.needed_by).getTime() < new Date(now).getTime() : false;

  if (!open && (orderClosed || !can("orders.edit")) && events.length === 0) return null;

  return (
    <Card className={open ? "border-brand" : undefined}>
      <CardHeader
        title={open ? "Urgent order" : "Urgency"}
        description={open ? "Visible to dispatch on the board and in the Command Center until resolved." : "Flag this order when the customer needs it sooner than planned. Dispatch is asked to acknowledge; nothing is assigned automatically."}
        actions={
          can("orders.edit") && !orderClosed ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Siren className="size-4" />}
              onClick={() => { setReason(open?.reason ?? ""); setDate(""); setTime(""); setFlagOpen(true); }}
            >
              {open ? "Edit reason or deadline" : "Flag as urgent"}
            </Button>
          ) : undefined
        }
      />
      {open && (
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={stateTone(open.state)}>{URGENCY_LABELS[open.state]}</Badge>
            {open.needed_by && <Badge tone={overdue ? "red" : "gray"}>{overdue ? "Past needed-by " : "Needed by "}{formatDateTime(open.needed_by, timezone)}</Badge>}
          </div>
          <p className="font-semibold text-ink">{open.reason}</p>
          {open.state_note && <p className="text-sm">Note: {open.state_note}</p>}
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
            <div><dt className="inline text-muted">Flagged: </dt><dd className="inline">{who(open.flagged_by)}, {formatDateTime(open.flagged_at, timezone)}</dd></div>
            <div><dt className="inline text-muted">Acknowledged: </dt><dd className="inline">{open.acknowledged_at ? `${who(open.acknowledged_by)}, ${formatDateTime(open.acknowledged_at, timezone)}` : "Not yet"}</dd></div>
            <div className="sm:col-span-2"><dt className="inline text-muted">Next step: </dt><dd className="inline font-semibold">{URGENCY_NEXT_OWNER[open.state]}</dd></div>
          </dl>
          {actions.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label="Urgent order actions">
              {actions.map((a) => (
                <Button key={a.state} size="sm" variant={a.state === "acknowledged" ? "primary" : a.state === "canceled" ? "ghost" : "secondary"} onClick={() => { setNote(""); setMove(a); }}>
                  {a.label}
                </Button>
              ))}
            </div>
          )}
          <p className="text-xs text-muted">Flagging and its steps never assign trucks, change assignments or promise the customer a time.</p>
        </CardBody>
      )}
      {events.length > 0 && (
        <details className="border-t border-line px-5 py-3 text-sm sm:px-6">
          <summary className="cursor-pointer font-semibold text-muted">Urgency history ({events.length})</summary>
          <ol className="mt-2 space-y-2" aria-label="Urgency history">
            {events.map((e) => (
              <li key={e.id}>
                <span className="font-semibold">
                  {e.action === "flagged" ? "Flagged urgent" : e.action === "updated" ? "Reason or deadline changed" : e.action === "closed_with_order" ? "Closed with the order" : URGENCY_LABELS[e.to_state]}
                </span>
                {e.note ? ` — ${e.note}` : ""}
                <div className="text-xs text-muted">{formatDateTime(e.occurred_at, timezone)} · {who(e.actor_id)}</div>
              </li>
            ))}
          </ol>
        </details>
      )}

      <ConfirmDialog
        open={flagOpen}
        onOpenChange={setFlagOpen}
        title={open ? "Edit urgent flag" : "Flag order as urgent"}
        description="Dispatch sees the reason and deadline. This does not change the schedule, assign a truck or tell the customer anything."
        confirmLabel={open ? "Save" : "Flag as urgent"}
        onConfirm={async () => {
          const r = await flagOrderUrgent({ orderId, reason, neededDate: date, neededTime: time });
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Saved");
          router.refresh();
        }}
      >
        <div className="space-y-3">
          <Field label="Why is it urgent?" htmlFor="urgent-reason" required hint="For example: customer called, pour moved up to 7 AM.">
            <Textarea id="urgent-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Needed by (date)" htmlFor="urgent-date" hint={open?.needed_by ? `Now ${formatDateTime(open.needed_by, timezone)}; empty removes it.` : "Optional."}>
              <DateInput id="urgent-date" min={today} value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Time" htmlFor="urgent-time" hint="Business time.">
              <Input id="urgent-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
          </div>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(move)}
        onOpenChange={(o) => !o && setMove(null)}
        title={move ? `${move.label}` : ""}
        description={move?.state === "assigned" ? "Only possible when a truck is already assigned on the dispatch board." : move?.state === "resolved" ? "Closes the urgent flag. The order itself does not change." : move?.state === "canceled" ? "Withdraws the urgent flag; it stays in the history." : "Records the new state for everyone who follows this order."}
        confirmLabel={move?.label ?? "Save"}
        onConfirm={async () => {
          if (!move || !open) return;
          const r = await updateOrderUrgency({ urgencyId: open.id, orderId, state: move.state, note });
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Saved");
          router.refresh();
        }}
      >
        <Field label={move && NOTE_REQUIRED.includes(move.state) ? "Note" : "Note (optional)"} htmlFor="urgent-note" required={Boolean(move && NOTE_REQUIRED.includes(move.state))} hint="Kept in the history.">
          <Input id="urgent-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </Card>
  );
}
