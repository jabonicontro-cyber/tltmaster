"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { ALL_INSPECTION_ITEMS, INSPECTION_ITEMS } from "@/lib/inspections/items";
import { assertAnyPermission } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Digital inspections (B132). Drivers and the office use the same action; the database decides who may inspect which
// truck (a driver: a truck they drive today or their own; the office: fleet.edit) and opens the work order for defects.

// Every truck checks the DVIR items; dump trucks also the dump body. The database checks the exact list for the truck.
const KEYS = ALL_INSPECTION_ITEMS.map((i) => i.key) as [string, ...string[]];
const input = z.object({
  truckId: z.uuid(),
  kind: z.enum(["pre_trip", "post_trip"]),
  odometer: z.string().trim().regex(/^\d{0,7}$/, "Enter the odometer in whole miles.").default(""),
  remarks: z.string().trim().max(1000).default(""),
  // Saved on the phone without signal and sent later (B133): the day it was done; the database accepts today or yesterday.
  inspectedOn: z.iso.date().optional(),
  items: z.array(z.object({ key: z.enum(KEYS), ok: z.boolean(), note: z.string().trim().max(300).default("") })).min(INSPECTION_ITEMS.length, "Check every item.").max(ALL_INSPECTION_ITEMS.length),
}).superRefine((v, ctx) => {
  const keys = new Set(v.items.map((i) => i.key));
  if (keys.size !== v.items.length || INSPECTION_ITEMS.some((i) => !keys.has(i.key))) ctx.addIssue({ code: "custom", message: "Check every item." });
  if (v.items.some((i) => !i.ok && i.note.length < 3)) ctx.addIssue({ code: "custom", message: "Describe each defect." });
});

export async function submitInspection(raw: z.input<typeof input>): Promise<ActionResult<{ id: string; defects: number; safety: boolean; workOrder: string | null }>> {
  return guard(async () => {
    await assertAnyPermission("driver.portal", "fleet.edit");
    const p = input.safeParse(raw);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Check the form.");
    const v = p.data;
    const { data, error } = await (await createClient()).rpc("inspection_submit", { p: {
      truck_id: v.truckId, kind: v.kind, odometer: v.odometer || null, remarks: v.remarks, items: v.items, inspected_on: v.inspectedOn ?? null,
    } });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { id: string; defects: number; safety: boolean; work_order: string | null };
    revalidatePath("/driver");
    revalidatePath("/fleet/inspections");
    revalidatePath("/maintenance");
    const message = r.defects === 0 ? "Inspection saved. No defects."
      : r.safety ? `Inspection saved. Safety defect: the truck is out of service until the shop clears work order ${r.work_order}.`
      : `Inspection saved. Work order ${r.work_order} opened for the shop.`;
    return ok({ id: r.id, defects: r.defects, safety: r.safety, workOrder: r.work_order }, message);
  });
}
