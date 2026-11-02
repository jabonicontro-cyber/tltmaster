"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { markStop } from "@/app/(app)/reports/wait-times/actions";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { STOP_LABEL, minutesLabel, waitMinutes, type Stop } from "@/lib/dispatch/wait-times";
import { announceOutbox, enqueue, isNetworkError } from "@/lib/offline/store";
import { useOutbox } from "@/components/companion/offline-support";

// Wait times (B111) on My Day: Arrived / Left at the pickup and the job site. Times are recorded when tapped.

export interface StopState { stop: Stop; arrivedAt: string | null; departedAt: string | null }

function StopRow({ load, s: given, timeZone, queue }: { load: string; s: StopState; timeZone: string; queue?: { userId: string; label: string } }) {
  const router = useRouter();
  // Taps saved on this phone without signal (B133): shown with their time and sent later with that time.
  // Taps still waiting on the phone count as made, on any screen, until Taviron has them.
  const waiting = useOutbox(queue?.userId ?? null).filter((i) => i.kind === "stop" && i.payload.load === load && i.payload.stop === given.stop);
  const waitingAt = (ev: string) => waiting.find((i) => i.payload.event === ev)?.payload.at as string | undefined;
  const [kept, setKept] = useState<{ arrivedAt?: string; departedAt?: string }>({});
  const s = {
    ...given,
    arrivedAt: given.arrivedAt ?? kept.arrivedAt ?? waitingAt("arrive") ?? null,
    departedAt: given.departedAt ?? kept.departedAt ?? waitingAt("depart") ?? null,
  };
  const keep = (fd: FormData) => {
    if (!queue) return false;
    const event = String(fd.get("event")) as "arrive" | "depart";
    const at = new Date().toISOString();
    const label = `${event === "arrive" ? "Arrived" : "Left"} ${STOP_LABEL[given.stop].toLowerCase()} — ${queue.label}`;
    if (!enqueue({ id: crypto.randomUUID(), userId: queue.userId, kind: "stop", label, payload: { load, stop: given.stop, event, at } })) return false;
    announceOutbox();
    setKept((k) => ({ ...k, [event === "arrive" ? "arrivedAt" : "departedAt"]: at }));
    return true;
  };
  const send = async (fd: FormData) => {
    const saved = { ok: true as const, data: undefined, message: "Saved on this phone — it sends when you have signal." };
    if (typeof navigator !== "undefined" && navigator.onLine === false && keep(fd)) return saved;
    try {
      return await markStop(fd);
    } catch (e) {
      if (isNetworkError(e) && keep(fd)) return saved;
      throw e;
    }
  };
  // A tap kept on the phone is not refreshed from Taviron (there is no signal to ask).
  const { pending, onSubmit, formError } = useFormAction(send, { onSuccess: (r) => { toast.success(r.message ?? "Recorded."); if (!r.message?.startsWith("Saved on this phone")) router.refresh(); } });
  const time = (iso: string) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
  const event = !s.arrivedAt ? "arrive" : !s.departedAt ? "depart" : null;
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label={`${STOP_LABEL[s.stop]} times`}>
      <input type="hidden" name="load" value={load} />
      <input type="hidden" name="stop" value={s.stop} />
      {event && <input type="hidden" name="event" value={event} />}
      <span className="w-20 text-sm font-semibold">{STOP_LABEL[s.stop]}</span>
      <span className="min-w-0 flex-1 text-sm text-muted tabular">
        {s.arrivedAt ? `Arrived ${time(s.arrivedAt)}` : "Not arrived"}
        {s.departedAt ? ` · left ${time(s.departedAt)} · waited ${minutesLabel(waitMinutes(s))}` : ""}
      </span>
      {event && <Button type="submit" size="sm" variant={event === "arrive" ? "secondary" : "primary"} loading={pending}>{event === "arrive" ? "Arrived" : "Left"}</Button>}
      <FormError message={formError} />
    </form>
  );
}

export function StopButtons({ load, stops, timeZone, queue }: { load: string; stops: StopState[]; timeZone: string; queue?: { userId: string; label: string } }) {
  const by = (stop: Stop) => stops.find((s) => s.stop === stop) ?? { stop, arrivedAt: null, departedAt: null };
  return (
    <div className="space-y-2 rounded-xl bg-surface px-3 py-2.5" aria-label="Arrival and departure">
      <StopRow load={load} s={by("pickup")} timeZone={timeZone} queue={queue} />
      <StopRow load={load} s={by("site")} timeZone={timeZone} queue={queue} />
    </div>
  );
}
