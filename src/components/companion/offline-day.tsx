"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { DriverTicketForm } from "@/components/driver/driver-ticket-form";
import { StopButtons } from "@/components/driver/stop-buttons";
import { InspectionForm } from "@/components/fleet/inspection-form";
import { rawStored, readDay } from "@/lib/offline/store";
import { OutboxList, useOutbox } from "./offline-support";

const fmtTime = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(Date.UTC(2000, 0, 1, h, m));
};

/**
 * The offline page's content (B133): today's loads as last read from Taviron on this phone, plainly marked with the
 * time they were read, and the forms that can be saved on the phone (ticket without photos, inspection, Arrived/Left).
 * Nothing here is current; the driver is told to check with dispatch before acting on it.
 */
export function OfflineDay() {
  // undefined while rendering on the server (the page itself holds nothing); the phone's saved day once in the browser.
  const raw = useSyncExternalStore(() => () => undefined, () => rawStored("day") ?? "", () => undefined);
  // eslint-disable-next-line react-hooks/purity -- the age check needs the current time when the saved day is read
  const day = useMemo(() => (raw === undefined ? undefined : raw ? readDay(Date.now()) : null), [raw]);
  const [ticketFor, setTicketFor] = useState<string | null>(null);
  const items = useOutbox(day?.userId ?? null);
  if (day === undefined) return null;
  if (!day) {
    return (
      <p className="max-w-sm text-[15px] text-muted">
        Taviron could not be reached and this phone has no saved day, so nothing is shown here. Your loads appear again once
        you are back online. If you need something now, call dispatch.
      </p>
    );
  }
  const saved = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: day.timezone }).format(new Date(day.savedAt));
  const editing = day.loads.find((l) => l.assignmentId === ticketFor);
  return (
    <div className="w-full max-w-xl space-y-4 text-left">
      <p role="status" className="rounded-xl bg-amber-50 px-4 py-3 text-[15px] font-semibold text-amber-950 ring-1 ring-amber-200">
        Your day as of {saved}. No connection: this may be out of date. Check with dispatch before acting on it.
      </p>
      <OutboxList items={items} />
      {editing ? (
        <section aria-label="Delivery ticket" className="rounded-panel bg-card p-4 ring-1 ring-line">
          <h2 className="mb-1 text-xl font-black">Delivery ticket</h2>
          <p className="mb-4 text-muted">{editing.orderNumber} · load {editing.loadNumber} · saved on this phone until you have signal</p>
          <DriverTicketForm
            assignmentId={editing.assignmentId} loadDate={editing.date}
            defaultTime={editing.date === day.today ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: day.timezone }).format(new Date()) : ""} lines={editing.lines} units={day.units}
            existing={editing.tickets.map((n) => ({ number: n }))}
            queue={{ userId: day.userId, label: `Ticket for ${editing.orderNumber} load ${editing.loadNumber}` }}
            onQueued={() => window.setTimeout(() => setTicketFor(null), 1500)}
          />
        </section>
      ) : (
        <>
          {day.inspectionTrucks.length > 0 && (
            <section aria-label="Inspection" className="rounded-panel bg-card p-4 ring-1 ring-line">
              <h2 className="mb-3 text-lg font-bold">Inspection</h2>
              <InspectionForm trucks={day.inspectionTrucks} queue={{ userId: day.userId, day: day.today }} />
            </section>
          )}
          <section aria-label="Saved loads">
            <h2 className="mb-2 text-lg font-bold">Today</h2>
            {day.loads.length === 0 ? <p className="text-muted">No loads were assigned to you when this was saved.</p> : (
              <ul className="space-y-3">
                {day.loads.map((l) => (
                  <li key={l.assignmentId} className="space-y-2 rounded-panel bg-card p-4 ring-1 ring-line" aria-label={`Load ${l.loadNumber}, ${l.orderNumber}`}>
                    <p className="font-bold">{l.orderNumber} · load {l.loadNumber} · {fmtTime(l.start)}–{fmtTime(l.end)}</p>
                    <p className="text-sm text-muted">{[l.customer, l.project].filter(Boolean).join(" · ")}</p>
                    {l.site && <p className="text-sm"><span className="font-semibold">Site:</span> {l.site}</p>}
                    {(l.truck || l.trailer) && <p className="text-sm"><span className="font-semibold">Truck:</span> {[l.truck, l.trailer].filter(Boolean).join(" + ")}</p>}
                    {l.instructions && <p className="whitespace-pre-line rounded-lg bg-surface px-3 py-2 text-sm">{l.instructions}</p>}
                    <StopButtons load={l.loadId} stops={l.stops} timeZone={day.timezone} queue={{ userId: day.userId, label: `${l.orderNumber} load ${l.loadNumber}` }} />
                    {l.canSubmitTicket && (
                      <button type="button" onClick={() => setTicketFor(l.assignmentId)} className="min-h-12 w-full rounded-xl bg-action px-4 text-base font-semibold text-white">
                        Enter delivery ticket
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
