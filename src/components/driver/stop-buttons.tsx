"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { markStop, undoStop } from "@/app/(app)/reports/wait-times/actions";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { cn } from "@/lib/cn";
import { STOP_LABEL, minutesLabel, waitMinutes, type Stop } from "@/lib/dispatch/wait-times";
import { announceOutbox, enqueue, isNetworkError, takeBackQueued } from "@/lib/offline/store";
import { useOutbox } from "@/components/companion/offline-support";
import { stopButtonLabel } from "@/lib/driver/my-day";

// Wait times (B111) on My Day: Arrived / Left at the pickup and the job site. Times are recorded when tapped.
// A wrong tap can be taken back for 10 seconds (Undo on the confirmation): a tap still waiting on the phone is simply
// removed there; a sent one is undone by Taviron (load_stop_undo: the driver's own tap, within 10 minutes).

/** How long the Undo button stays on the confirmation. */
export const STOP_UNDO_MS = 10_000;

export interface StopState { stop: Stop; arrivedAt: string | null; departedAt: string | null; /** Shown for an order's stops (MK2), e.g. "1. Acme Steel". */ label?: string }

const labelOf = (s: { stop: Stop; label?: string }) => s.label ?? (s.stop === "pickup" || s.stop === "site" ? STOP_LABEL[s.stop] : "Stop");

function StopRow({ load, s: given, timeZone, queue }: { load: string; s: StopState; timeZone: string; queue?: { userId: string; label: string } }) {
  const router = useRouter();
  // Taps saved on this phone without signal (B133): shown with their time and sent later with that time.
  // Taps still waiting on the phone count as made, on any screen, until Taviron has them.
  const waiting = useOutbox(queue?.userId ?? null).filter((i) => i.kind === "stop" && i.payload.load === load && i.payload.stop === given.stop);
  const waitingAt = (ev: string) => waiting.find((i) => i.payload.event === ev)?.payload.at as string | undefined;
  const [kept, setKept] = useState<{ arrivedAt?: string; departedAt?: string }>({});
  // The tap just made (and its waiting item when it was kept on the phone), for Undo.
  const last = useRef<{ event: "arrive" | "depart"; queuedId?: string } | null>(null);
  const s = {
    ...given,
    arrivedAt: given.arrivedAt ?? kept.arrivedAt ?? waitingAt("arrive") ?? null,
    departedAt: given.departedAt ?? kept.departedAt ?? waitingAt("depart") ?? null,
  };
  const keep = (fd: FormData) => {
    if (!queue) return false;
    const event = String(fd.get("event")) as "arrive" | "depart";
    const at = new Date().toISOString();
    const label = `${event === "arrive" ? "Arrived" : "Left"} ${labelOf(given).toLowerCase()} · ${queue.label}`;
    const id = crypto.randomUUID();
    if (!enqueue({ id, userId: queue.userId, kind: "stop", label, payload: { load, stop: given.stop, event, at } })) return false;
    last.current = { event, queuedId: id };
    announceOutbox();
    setKept((k) => ({ ...k, [event === "arrive" ? "arrivedAt" : "departedAt"]: at }));
    return true;
  };
  const send = async (fd: FormData) => {
    const saved = { ok: true as const, data: undefined, message: "Saved on this phone. It sends when you have signal." };
    last.current = { event: String(fd.get("event")) as "arrive" | "depart" };
    if (typeof navigator !== "undefined" && navigator.onLine === false && keep(fd)) return saved;
    try {
      return await markStop(fd);
    } catch (e) {
      if (isNetworkError(e) && keep(fd)) return saved;
      throw e;
    }
  };
  const forget = (event: "arrive" | "depart") => setKept((k) => ({ ...k, [event === "arrive" ? "arrivedAt" : "departedAt"]: undefined }));
  const undo = async (u: { event: "arrive" | "depart"; queuedId?: string }) => {
    // Not sent yet: it only has to leave the phone's list.
    if (u.queuedId && takeBackQueued(u.queuedId)) {
      announceOutbox();
      forget(u.event);
      toast.success("Taken back. Nothing was sent.");
      return;
    }
    try {
      const r = await undoStop({ load, stop: given.stop, event: u.event });
      if (!r.ok) { toast.error(r.error); return; }
      forget(u.event);
      toast.success(r.message ?? "Taken back.");
      router.refresh();
    } catch {
      toast.error("No connection, so the tap was not taken back. Ask the office to correct the time.");
    }
  };
  // A tap kept on the phone is not refreshed from Taviron (there is no signal to ask).
  const { pending, onSubmit, formError } = useFormAction(send, { onSuccess: (r) => {
    const u = last.current;
    const action = u ? { label: "Undo", onClick: () => void undo(u) } : undefined;
    if (r.message?.startsWith("Saved on this phone")) { toast.warning(r.message, { duration: STOP_UNDO_MS, action }); return; }
    toast.success(r.message ?? "Recorded.", { duration: STOP_UNDO_MS, action });
    router.refresh();
  } });
  const time = (iso: string) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
  const event = !s.arrivedAt ? "arrive" : !s.departedAt ? "depart" : null;
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label={`${labelOf(s)} times`}>
      <input type="hidden" name="load" value={load} />
      <input type="hidden" name="stop" value={s.stop} />
      {event && <input type="hidden" name="event" value={event} />}
      <span className={cn("text-sm font-semibold", s.label ? "w-full sm:w-40 sm:truncate" : "w-20")}>{labelOf(s)}</span>
      <span className="min-w-0 flex-1 text-sm text-muted tabular">
        {s.arrivedAt ? `Arrived ${time(s.arrivedAt)}` : "Not arrived yet"}
        {s.departedAt ? ` · left ${time(s.departedAt)} · waited ${minutesLabel(waitMinutes(s))}` : ""}
      </span>
      {/* Glove-size target (UX6): at least 48 px tall and wide enough to hit from a cab. */}
      {event && <Button type="submit" variant={event === "arrive" ? "secondary" : "primary"} loading={pending} className="min-h-12 min-w-28 text-base">{stopButtonLabel(s.stop, event)}</Button>}
      <FormError message={formError} />
    </form>
  );
}

export function StopButtons({ load, stops, timeZone, queue }: { load: string; stops: StopState[]; timeZone: string; queue?: { userId: string; label: string } }) {
  const by = (stop: Stop) => stops.find((s) => s.stop === stop) ?? { stop, arrivedAt: null, departedAt: null };
  // An order with stops (MK2): one row per stop, in order. Otherwise the pickup and the job site, as before.
  const rows = stops.some((s) => s.stop.startsWith("stop:")) ? stops.filter((s) => s.stop.startsWith("stop:")) : [by("pickup"), by("site")];
  return (
    <div className="space-y-2 rounded-xl bg-surface px-3 py-2.5" aria-label="Arrival and departure">
      {rows.map((r) => <StopRow key={r.stop} load={load} s={r} timeZone={timeZone} queue={queue} />)}
    </div>
  );
}
