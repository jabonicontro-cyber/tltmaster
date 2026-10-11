"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { draftKey } from "@/lib/dispatch/load-build";
import { assertPermission } from "@/server/auth";
import { buildParams, draftFor, getLoadBuildContext } from "@/server/data/load-build";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Enter a valid time.");
const input = buildParams.extend({
  orderId: z.uuid("Invalid order."),
  startTime: time.optional(),
  endTime: time.optional(),
  /** What the dispatcher reviewed: the loads are created only if the server computes the same draft. */
  reviewed: z.string().min(1).max(5000),
});

/**
 * The dispatcher's approval of a load-build draft. Re-reads the order, its
 * loads and the fleet with the caller's session (their company only), computes
 * the draft again on the server, and creates the planned loads through the
 * same database function as the dispatch board (which checks the order's
 * status, dates, units and quantities). Creates loads only — no truck or
 * driver is assigned. If any load fails, the loads created by this approval
 * are canceled again, so a partial plan is never left behind.
 */
export async function approveLoadBuild(raw: z.input<typeof input>): Promise<ActionResult<{ created: number }>> {
  return guard(async () => {
    await assertPermission("dispatch.edit");
    const parsed = input.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const p = parsed.data;
    const ctx = await getLoadBuildContext(p.orderId);
    if (!ctx) return fail("Order not found.");
    if (ctx.unavailable) return fail(ctx.unavailable);
    const draft = draftFor(ctx, p);
    if (!draft || !draft.ok) return fail(draft?.blockers[0] ?? "Choose the quantity per load and the loads per day.");
    if (draftKey(draft.loads) !== p.reviewed) {
      return fail("The order, its loads or the fleet changed since you reviewed this draft. Review the new draft and approve again.");
    }
    const startTime = ctx.order.window_start ?? p.startTime;
    const endTime = ctx.order.window_end ?? p.endTime;
    if (!startTime || !endTime) return fail("Enter the start and end time for the loads (the order has no daily time window).");
    if (endTime <= startTime) return fail("The end time must be after the start time.");

    const supabase = await createClient();
    const created: string[] = [];
    for (const [i, l] of draft.loads.entries()) {
      const { data, error } = await supabase.rpc("save_order_load", {
        p_payload: {
          order_id: ctx.order.id,
          load_date: l.date,
          start_time: startTime,
          end_time: endTime,
          planned_quantity: l.quantity,
          unit_code: ctx.unit,
          notes: `Load build: ${i + 1} of ${draft.loads.length}.`,
        },
      });
      if (error) {
        for (const id of created) {
          await supabase.rpc("cancel_order_load", { p_load_id: id, p_reason: "Load build stopped before every load was created." });
        }
        return fail(`No loads were added: ${dbErrorMessage(error)}`);
      }
      created.push((data as { load_id: string }).load_id);
    }
    revalidatePath(`/orders/${ctx.order.id}`);
    revalidatePath("/dispatch");
    revalidatePath("/command-center");
    return ok({ created: created.length }, `${created.length} planned load${created.length === 1 ? "" : "s"} added. Assign trucks and drivers on the dispatch board.`);
  });
}
