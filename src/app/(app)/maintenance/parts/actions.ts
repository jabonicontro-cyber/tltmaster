"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { parseMoneyToCents } from "@/lib/money";
import { uuid } from "@/lib/schemas/common";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Shop parts inventory (B105). Each action calls one database function that checks maintenance.manage, the company,
// open work orders and stock again; nothing here changes stock directly.

const qty = (v: FormDataEntryValue | null) => {
  const s = String(v ?? "").trim();
  return /^\d{1,7}(\.\d{1,2})?$/.test(s) ? Number(s) : null;
};
const refresh = (workOrder?: string) => {
  revalidatePath("/maintenance/parts");
  revalidatePath("/maintenance");
  if (workOrder) revalidatePath(`/maintenance/work-orders/${workOrder}`);
};

const part = z.object({
  part_number: z.string().trim().max(60).default(""),
  name: z.string().trim().min(1, "Enter the part name.").max(160),
  unit: z.string().trim().max(20).default("each"),
  location: z.string().trim().max(80).default(""),
  reorder_point: z.string().trim().regex(/^\d{0,7}(\.\d{1,2})?$/, "Enter a reorder point of 0 or more.").default("0"),
});

export async function savePart(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("maintenance.manage");
    const id = String(formData.get("id") ?? "");
    if (id && !uuid.safeParse(id).success) return fail("Part not found.");
    const parsed = part.safeParse(Object.fromEntries(["part_number", "name", "unit", "location", "reorder_point"].map((k) => [k, String(formData.get(k) ?? "")])));
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form.");
    const { error } = await (await createClient()).rpc("part_save", { p_id: id || null, p: { ...parsed.data, reorder_point: parsed.data.reorder_point || "0" } });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, id ? "Part saved." : "Part added.");
  });
}

export async function receivePart(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("maintenance.manage");
    const id = String(formData.get("id") ?? "");
    const q = qty(formData.get("quantity"));
    const costText = String(formData.get("unit_cost") ?? "").trim();
    const cost = costText ? parseMoneyToCents(costText) : null;
    if (!uuid.safeParse(id).success) return fail("Part not found.");
    if (!q) return fail("Enter how many were received.");
    if (costText && (cost === null || cost < 0)) return fail("Enter the unit cost in dollars, or leave it empty.");
    const { error } = await (await createClient()).rpc("part_receive", { p_part: id, p_quantity: q, p_unit_cost_cents: cost, p_note: String(formData.get("note") ?? "").slice(0, 300) });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Stock received.");
  });
}

export async function countPart(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("maintenance.manage");
    const id = String(formData.get("id") ?? "");
    const counted = String(formData.get("counted") ?? "").trim();
    const reason = String(formData.get("reason") ?? "").trim();
    if (!uuid.safeParse(id).success) return fail("Part not found.");
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(counted)) return fail("Enter the counted quantity (0 or more).");
    if (!reason) return fail("Enter the reason for the change.");
    const { error } = await (await createClient()).rpc("part_count", { p_part: id, p_counted: Number(counted), p_reason: reason.slice(0, 300) });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Count recorded.");
  });
}

export async function usePart(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("maintenance.manage");
    const id = String(formData.get("part") ?? "");
    const wo = String(formData.get("work_order") ?? "");
    const q = qty(formData.get("quantity"));
    if (!uuid.safeParse(id).success) return fail("Choose a part.");
    if (!uuid.safeParse(wo).success) return fail("Work order not found.");
    if (!q) return fail("Enter how many were used.");
    const { data, error } = await (await createClient()).rpc("part_use", { p_part: id, p_work_order: wo, p_quantity: q });
    if (error) return fail(dbErrorMessage(error));
    refresh(wo);
    return ok(undefined, (data as { cost_added: boolean }).cost_added ? "Part used and added to the work order's costs." : "Part used. No cost is known for it, so no cost line was added.");
  });
}
