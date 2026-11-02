"use server";

import { assertPermission } from "@/server/auth";
import type { DaySnapshot } from "@/lib/offline/store";
import { loadAssignmentForm, loadDriverHome } from "@/server/data/driver";
import { stopTimesForLoads } from "@/server/data/wait-times";
import { createClient } from "@/server/supabase/server";

/**
 * Offline driver app (B133): today's loads for the phone to keep, read through the driver's own session and the same
 * functions as My Day (their own loads only). Called by My Day after it has loaded, never on the critical path.
 */
export async function loadOfflineDay(): Promise<DaySnapshot | null> {
  const access = await assertPermission("driver.portal");
  const home = await loadDriverHome();
  if (!home.ok) return null;
  const h = home.data;
  const todays = h.assignments.filter((a) => a.load.date === h.today);
  const [forms, stops, insp] = await Promise.all([
    Promise.all(todays.map((a) => (a.can_submit_ticket ? loadAssignmentForm(a.assignment_id) : Promise.resolve(null)))),
    stopTimesForLoads(todays.map((a) => a.load.id)),
    (async () => { const r = await (await createClient()).rpc("inspection_my_trucks"); return r.error ? [] : ((r.data ?? []) as Array<{ id: string; unit: string; pre_trip: boolean; post_trip: boolean }>); })(),
  ]);
  const units = forms.find((f) => f?.ok)?.ok ? (forms.find((f) => f?.ok) as { ok: true; data: { units: DaySnapshot["units"] } }).data.units : [];
  return {
    userId: access.userId,
    savedAt: new Date().toISOString(),
    today: h.today,
    timezone: h.timezone,
    driverName: h.driver.name,
    units,
    loads: todays.map((a, i) => {
      const f = forms[i];
      const site = a.site.label || [a.site.line1, a.site.city].filter(Boolean).join(", ");
      return {
        assignmentId: a.assignment_id, loadId: a.load.id, loadNumber: a.load.number, date: a.load.date,
        start: a.load.start_time, end: a.load.end_time, orderNumber: a.order.number, customer: a.order.customer_name,
        project: a.order.project_name, site, instructions: [a.order.job_instructions, a.load.notes, a.assignment_note].filter(Boolean).join("\n"),
        truck: a.truck, trailer: a.trailer, canSubmitTicket: Boolean(a.can_submit_ticket && f?.ok),
        tickets: a.tickets.map((t) => t.number),
        lines: f?.ok ? f.data.lines.map((l) => ({ id: l.id, description: l.description, unit_code: l.unit_code })) : [],
        stops: (["pickup", "site"] as const).map((stop) => {
          const s = stops.find((x) => x.loadId === a.load.id && x.stop === stop);
          return { stop, arrivedAt: s?.arrivedAt ?? null, departedAt: s?.departedAt ?? null };
        }),
      };
    }),
    inspectionTrucks: insp
      .map((t) => ({ id: t.id, label: `Truck ${t.unit}`, pending: [...(t.pre_trip ? [] : ["pre_trip" as const]), ...(t.post_trip ? [] : ["post_trip" as const])] }))
      .filter((t) => t.pending.length > 0),
  };
}
