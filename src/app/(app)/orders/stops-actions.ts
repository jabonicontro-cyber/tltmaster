"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { MAX_STOPS, STOP_KINDS, stopProblems, type StopInput } from "@/lib/orders/stops";
import { canOfferSave, orderLoadWindow, placeKindFor, savedWindowNote, stopWindowWarnings } from "@/lib/orders/stop-checks";
import { can } from "@/lib/permissions";
import { assertAnyPermission } from "@/server/auth";
import { getIndustry } from "@/server/industry";
import { listStopPlaces } from "@/server/data/stop-places";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Stops on an order (MK2 slice 1). orders.edit (any order) or orders.create (a direct order the person entered
// themselves; owner 2026-11-09, MD1) is checked here and again in save_order_stops, which also checks whose order it
// is (private.require_own_order_change), refuses completed and canceled orders and records the change in the order's
// history.

const text = (max: number) => z.string().trim().max(max).default("");
const stop = z.object({
  id: z.uuid().optional(),
  kind: z.enum(STOP_KINDS),
  name: z.string().trim().min(1, "Enter the place name.").max(160),
  address_line1: text(200),
  city: text(80),
  state: text(40),
  postal_code: text(20),
  appointment_date: text(10),
  window_start: text(8),
  window_end: text(8),
  reference: text(80),
  notes: text(500),
});

/**
 * Save an order's stops. `savePlaces`: positions of typed stops the person asked to keep for next time; each becomes a
 * saved location (Route planner) when the person may change locations (dispatch.edit or settings.manage, checked here
 * and by row-level security), it has a name and a street or town, and it is not saved already. Saved without map
 * coordinates: those are only ever typed or confirmed by a person in Route planner (never guessed here).
 * A stop outside the load's window is saved too; the message says which (WK3: warn, allow saving).
 */
export async function saveOrderStops(orderId: string, stops: StopInput[], opts: { savePlaces?: number[] } = {}): Promise<ActionResult<{ count: number; warnings: string[]; placesSaved: number }>> {
  return guard(async () => {
    const access = await assertAnyPermission("orders.edit", "orders.create");
    if (!z.uuid().safeParse(orderId).success) return fail("Order not found.");
    if (!Array.isArray(stops) || stops.length > MAX_STOPS) return fail(`An order can have at most ${MAX_STOPS} stops.`);
    const parsed = z.array(stop).safeParse(stops);
    if (!parsed.success) return fail("Check the stops: each needs a kind and a place name, and values must not be too long.");
    const problems = stopProblems(parsed.data);
    if (problems.length) return fail(problems[0]);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("save_order_stops", { p_order: orderId, p_stops: parsed.data });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath(`/orders/${orderId}`);
    const count = Number(data ?? 0);
    if (count === 0) return ok({ count, warnings: [], placesSaved: 0 }, "Stops removed.");

    // The load's window, read again from the order (row-level security): warnings only, the stops are saved.
    const industry = await getIndustry();
    const { data: order } = await supabase.from("orders").select("customer_id, scheduled_start, scheduled_end, window_start, window_end").eq("id", orderId).maybeSingle();
    const o = order as { customer_id: string | null; scheduled_start: string | null; scheduled_end: string | null; window_start: string | null; window_end: string | null } | null;
    const warnings = o ? stopWindowWarnings(parsed.data, orderLoadWindow(o, industry)) : [];

    let placesSaved = 0;
    let placeNote = "";
    const wanted = [...new Set((opts.savePlaces ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < parsed.data.length))];
    if (wanted.length) {
      if (!(can(access, "dispatch.edit") || can(access, "settings.manage"))) {
        placeNote = " Places were not saved for next time: that needs permission to change saved locations.";
      } else {
        const known = await listStopPlaces(o?.customer_id ?? null);
        for (const i of wanted) {
          const st = parsed.data[i];
          if (!canOfferSave(known, st)) continue;
          const r = await supabase.from("company_locations").insert({
            kind: placeKindFor(st.kind, industry), name: st.name.slice(0, 120), address_line1: st.address_line1.slice(0, 160),
            city: st.city, state: st.state, postal_code: st.postal_code,
          }).select("id").single();
          if (r.error) {
            placeNote = ` A place could not be saved for next time: ${dbErrorMessage(r.error)}`;
            break;
          }
          placesSaved += 1;
          known.push({ key: `location:${(r.data as { id: string }).id}`, group: "location", name: st.name, address_line1: st.address_line1, city: st.city, state: st.state, postal_code: st.postal_code, label: "" });
        }
        if (placesSaved) revalidatePath("/route-planner");
      }
    }
    const parts = ["Stops saved. Drivers see them on their load card."];
    if (warnings.length) parts.push(savedWindowNote(warnings));
    if (placesSaved) parts.push(placesSaved === 1 ? "1 place saved for next time." : `${placesSaved} places saved for next time.`);
    return ok({ count, warnings: warnings.map((w) => w.message), placesSaved }, parts.join(" ") + placeNote);
  });
}
