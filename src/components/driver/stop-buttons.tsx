"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { markStop } from "@/app/(app)/reports/wait-times/actions";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { STOP_LABEL, minutesLabel, waitMinutes, type Stop } from "@/lib/dispatch/wait-times";

// Wait times (B111) on My Day: Arrived / Left at the pickup and the job site. Times are recorded when tapped.

export interface StopState { stop: Stop; arrivedAt: string | null; departedAt: string | null }

function StopRow({ load, s, timeZone }: { load: string; s: StopState; timeZone: string }) {
  const router = useRouter();
  const { pending, onSubmit, formError } = useFormAction(markStop, { onSuccess: (r) => { toast.success(r.message ?? "Recorded."); router.refresh(); } });
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

export function StopButtons({ load, stops, timeZone }: { load: string; stops: StopState[]; timeZone: string }) {
  const by = (stop: Stop) => stops.find((s) => s.stop === stop) ?? { stop, arrivedAt: null, departedAt: null };
  return (
    <div className="space-y-2 rounded-xl bg-surface px-3 py-2.5" aria-label="Arrival and departure">
      <StopRow load={load} s={by("pickup")} timeZone={timeZone} />
      <StopRow load={load} s={by("site")} timeZone={timeZone} />
    </div>
  );
}
