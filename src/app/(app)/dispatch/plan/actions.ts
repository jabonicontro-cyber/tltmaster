"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isIsoDate } from "@/lib/dates";
import { checkAssignment } from "@/lib/optimization/plan";
import { assertPermission } from "@/server/auth";
import { getOptimizationInput } from "@/server/data/optimization";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

const approveInput = z.object({
  date: z.string().refine(isIsoDate),
  planLabel: z.string().trim().min(1).max(60),
  items: z.array(z.object({ loadId: z.uuid(), truckId: z.uuid(), trailerId: z.uuid().nullable(), driverId: z.uuid() })).min(1).max(100),
});

export interface ApprovalOutcome {
  loadId: string;
  assigned: boolean;
  message: string;
  warnings: string[];
}

/**
 * Approve selected assignments of an optimization plan. Each one is re-checked against the current data first
 * (someone may have assigned, rescheduled or taken a truck out of service since the plan was made), then assigned
 * through public.assign_load — the same permission, eligibility, capacity, trailer and conflict checks as any assignment.
 * One at a time, in order, so an earlier approval is part of the next re-check. Confirmed assignments are never
 * replaced (no replace id is ever passed), and nothing outside the selection is assigned.
 */
export async function approvePlanAssignments(input: z.input<typeof approveInput>): Promise<ActionResult<{ outcomes: ApprovalOutcome[] }>> {
  return guard(async () => {
    await assertPermission("dispatch.edit");
    const parsed = approveInput.safeParse(input);
    if (!parsed.success) return fail("Invalid plan selection.");
    const { date, planLabel, items } = parsed.data;
    const supabase = await createClient();
    const outcomes: ApprovalOutcome[] = [];
    for (const item of items) {
      const check = checkAssignment(await getOptimizationInput(date), item.loadId, item.truckId, item.trailerId, item.driverId);
      if (!check.ok) {
        outcomes.push({ loadId: item.loadId, assigned: false, message: `Not assigned — no longer valid: ${check.reasons.join(" ")}`, warnings: [] });
        continue;
      }
      const { data, error } = await supabase.rpc("assign_load", {
        p_load_id: item.loadId, p_truck_id: item.truckId, p_trailer_id: item.trailerId, p_driver_id: item.driverId,
        p_note: `Approved optimization plan (${planLabel})`, p_replace_assignment_id: null,
      });
      outcomes.push(error
        ? { loadId: item.loadId, assigned: false, message: `Not assigned: ${dbErrorMessage(error)}`, warnings: [] }
        : { loadId: item.loadId, assigned: true, message: "Assigned.", warnings: ((data as { warnings?: string[] } | null)?.warnings ?? []) });
    }
    revalidatePath("/dispatch");
    revalidatePath("/dispatch/plan");
    revalidatePath("/command-center");
    const done = outcomes.filter((o) => o.assigned).length;
    return ok({ outcomes }, done === outcomes.length ? `${done} assignment(s) approved.` : `${done} of ${outcomes.length} approved; see the reasons for the rest.`);
  });
}
