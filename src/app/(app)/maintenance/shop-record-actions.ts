"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isOperationalDate, OPERATIONAL_DATE_MESSAGE } from "@/lib/dates";
import { uuid } from "@/lib/schemas/common";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Shop records (2026-11-09): the annual inspection certificate from its work order (20261120012400) and returning a
// part to stock (20261120012600). maintenance.manage here and again in each database function.

const date = z.string().trim().refine(isOperationalDate, OPERATIONAL_DATE_MESSAGE);
const inspection = z.object({
  inspected_on: date,
  expires_on: date,
  inspector: z.string().trim().min(2, "Enter who did the inspection.").max(120, "Use at most 120 characters."),
  reference: z.string().trim().max(80, "Use at most 80 characters.").default(""),
}).refine((v) => v.expires_on > v.inspected_on, { path: ["expires_on"], message: "The inspection must expire after the inspection day." });

/** Record the annual inspection on the truck's or trailer's inspection certificate (its expiry). */
export async function recordInspection(workOrderId: string, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("maintenance.manage");
    if (!uuid.safeParse(workOrderId).success) return fail("Invalid work order.");
    const parsed = inspection.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const { error } = await (await createClient()).rpc("maintenance_record_inspection", { p_wo: workOrderId, p: parsed.data });
    if (error) {
      if (["42883", "PGRST202"].includes(error.code ?? "")) return fail("Recording the inspection here needs a database update that has not been installed yet. Update the certificate on the truck's page.");
      return fail(dbErrorMessage(error));
    }
    revalidatePath(`/maintenance/work-orders/${workOrderId}`);
    revalidatePath("/fleet", "layout");
    return ok(undefined, "Inspection certificate updated.");
  });
}

const returnInput = z.object({
  useId: z.number().int().positive(),
  workOrderId: uuid,
  quantity: z.string().trim().transform((v, ctx) => {
    const n = Number(v.replace(/[,\s]/g, ""));
    if (!Number.isFinite(n) || n <= 0 || n > 1000000) {
      ctx.addIssue({ code: "custom", message: "Enter how many go back to stock." });
      return z.NEVER;
    }
    return Math.round(n * 100) / 100;
  }),
  reason: z.string().trim().min(2, "Say why the part goes back to stock.").max(300),
});

/** Put a part used on this job back in stock: the use stays in the ledger and a return reverses it. */
export async function returnPart(input: z.input<typeof returnInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("maintenance.manage");
    const p = returnInput.safeParse(input);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Invalid request.");
    const { data, error } = await (await createClient()).rpc("part_return", { p_use: p.data.useId, p_quantity: p.data.quantity, p_reason: p.data.reason });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath(`/maintenance/work-orders/${p.data.workOrderId}`);
    revalidatePath("/maintenance/parts");
    return ok(undefined, (data as { cost_credited: boolean }).cost_credited ? "Back in stock. Its cost came off this job." : "Back in stock.");
  });
}
