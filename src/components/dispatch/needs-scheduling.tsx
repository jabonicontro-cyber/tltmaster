"use client";

import Link from "next/link";
import { DateInput } from "@/components/ui/date-input";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { scheduleOrderFromQueue } from "@/app/(app)/dispatch/actions";
import { formatDate } from "@/lib/dates";
import { withReturn } from "@/lib/safe-redirect";
import type { UnscheduledOrder } from "@/server/data/dispatch";

/**
 * Confirmed orders that have no delivery date and so appear on no day of the
 * board. Scheduling one here sets its dates and marks it Scheduled; nothing
 * is assigned automatically.
 */
export function NeedsScheduling({ items, canSchedule, today, back }: { items: UnscheduledOrder[]; canSchedule: boolean; today: string; back: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (items.length === 0) return null;

  async function schedule(o: UnscheduledOrder, form: HTMLFormElement) {
    const fd = new FormData(form);
    setBusy(o.id);
    setErrors((e) => ({ ...e, [o.id]: "" }));
    const r = await scheduleOrderFromQueue({ orderId: o.id, expectedEditSeq: o.edit_seq, start: String(fd.get("start") ?? ""), end: String(fd.get("end") ?? "") });
    setBusy(null);
    if (!r.ok) {
      setErrors((e) => ({ ...e, [o.id]: r.fieldErrors ? Object.values(r.fieldErrors)[0] ?? r.error : r.error }));
      return;
    }
    toast.success(`${o.order_number}: ${r.message ?? "Scheduled."}`);
    // Same page, another day: the push loads fresh data (the action revalidated the board). A refresh() right after
    // it would cancel the push and stay on the current day.
    router.push(`/dispatch?date=${r.data.date}`);
  }

  return (
    <section id="needs-scheduling" aria-label="Needs scheduling" className="mb-4 rounded-2xl border border-amber-300 bg-card">
      <h2 className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-line px-4 py-2.5 text-[15px] font-semibold text-ink">
        <CalendarClock className="size-5 text-amber-600" aria-hidden /> Needs scheduling ({items.length})
        <span className="text-sm font-normal text-muted">Confirmed orders without a delivery date — not on any day of the board yet.</span>
      </h2>
      {/* Bounded so the board stays on the first screen; every order is still here (scroll inside the panel). */}
      <ul className="max-h-[19rem] divide-y divide-line overflow-y-auto overscroll-contain" tabIndex={items.length > 3 ? 0 : undefined} aria-label="Orders that need a delivery date">
        {items.map((o) => {
          const late = o.requested_date !== null && o.requested_date < today;
          const soon = o.requested_date !== null && !late && o.requested_date <= today;
          return (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2">
                  <Link href={withReturn(`/orders/${o.id}`, back)} className="font-bold tabular hover:underline">{o.order_number}</Link>
                  <span className="text-sm text-muted">{o.customers?.name}</span>
                  {o.requested_date ? (
                    <Badge tone={late ? "red" : soon ? "amber" : "gray"}>{late ? "Requested date passed: " : "Requested "}{formatDate(o.requested_date)}</Badge>
                  ) : (
                    <Badge>No requested date</Badge>
                  )}
                </p>
                <p className="text-sm">{[o.project_name, o.site_label].filter(Boolean).join(" · ") || "No job or site name"}</p>
              </div>
              {canSchedule ? (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void schedule(o, e.currentTarget);
                  }}
                >
                  <label className="text-xs font-semibold">
                    Delivery date
                    <DateInput name="start" required defaultValue={o.requested_date && o.requested_date >= today ? o.requested_date : ""} className="mt-0.5 h-9" aria-label={`Delivery date for ${o.order_number}`} />
                  </label>
                  <label className="text-xs font-semibold">
                    Through <span className="font-normal text-muted">(optional)</span>
                    <DateInput name="end" className="mt-0.5 h-9" aria-label={`Last delivery date for ${o.order_number}`} />
                  </label>
                  <Button type="submit" size="sm" loading={busy === o.id}>Schedule</Button>
                  {errors[o.id] ? <p role="alert" className="w-full text-sm text-red-700">{errors[o.id]}</p> : null}
                </form>
              ) : (
                <p className="text-sm text-muted">Scheduling needs the orders.schedule permission.</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
