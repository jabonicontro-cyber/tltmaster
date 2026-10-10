"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

const input = z.object({
  reportId: z.uuid("Invalid report."),
  action: z.enum(["acknowledge", "resolve"]),
  note: z.string().trim().max(500).default(""),
});

export async function reviewFieldReport(raw: z.input<typeof input>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("field_reports.manage");
    const parsed = input.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
    if (parsed.data.action === "resolve" && !parsed.data.note) return fail("Enter how it was resolved.");
    const supabase = await createClient();
    const { error } = await supabase.rpc("review_field_report", { p_report_id: parsed.data.reportId, p_action: parsed.data.action, p_note: parsed.data.note });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/field-reports", "layout");
    revalidatePath("/command-center");
    return ok(undefined, parsed.data.action === "acknowledge" ? "Report acknowledged." : "Report resolved.");
  });
}
