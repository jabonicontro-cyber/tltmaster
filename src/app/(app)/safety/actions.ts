"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { zonedTimeToUtc } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { incidentReport, INCIDENT_KINDS, INCIDENT_SEVERITIES, type IncidentReportInput } from "@/lib/safety";
import { uuid } from "@/lib/schemas/common";
import { assertPermission, getAccess } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { businessToday } from "@/server/data/settings";
import { createClient } from "@/server/supabase/server";

// Safety incidents (B103, migration 20261120004300). Each action calls one database function that checks the
// permission, the company and the record again; the checks here only give a clear message early.

const refresh = (id?: string) => {
  revalidatePath("/safety");
  if (id) revalidatePath(`/safety/${id}`);
  revalidatePath("/driver/safety");
};

/** Report an incident: office staff with safety.manage, or a driver reporting as themselves (the database decides). */
export async function reportIncident(raw: IncidentReportInput): Promise<ActionResult<{ id: string; number: string }>> {
  return guard(async () => {
    const access = await getAccess();
    if (!access?.active || !access.companyId || !(can(access, "safety.manage") || can(access, "driver.portal"))) {
      return fail("You do not have permission to report safety incidents.");
    }
    const parsed = incidentReport.safeParse(raw);
    if (!parsed.success) {
      const fieldErrors = Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]));
      return fail(parsed.error.issues[0]?.message ?? "Check the form.", fieldErrors);
    }
    const d = parsed.data;
    const { timezone } = await businessToday();
    const occurred = zonedTimeToUtc(d.date, d.time, timezone);
    if (!occurred) return fail("Enter when it happened.", { date: "Enter when it happened." });
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("safety_report", {
      p: {
        kind: d.kind, severity: d.severity, occurred_at: occurred, location: d.location, description: d.description,
        injury: d.injury, vehicle_damage: d.vehicle_damage, truck_id: d.truck_id || null,
        // A driver's own record is set by the database; the choice is only for office staff.
        driver_id: can(access, "safety.manage") ? d.driver_id || null : null,
      },
    });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { id: string; number: string };
    refresh();
    return ok(r, `Incident ${r.number} reported.`);
  });
}

const investigation = z.object({
  id: uuid,
  kind: z.enum(Object.keys(INCIDENT_KINDS) as [string, ...string[]]),
  severity: z.enum(Object.keys(INCIDENT_SEVERITIES) as [string, ...string[]]),
  findings: z.string().trim().max(8000).default(""),
  root_cause: z.string().trim().max(2000).default(""),
});

export async function saveInvestigation(raw: z.input<typeof investigation>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("safety.manage");
    const parsed = investigation.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form.");
    const { id, ...p } = parsed.data;
    const { error } = await (await createClient()).rpc("safety_investigate", { p_id: id, p });
    if (error) return fail(dbErrorMessage(error));
    refresh(id);
    return ok(undefined, "Investigation saved.");
  });
}

const witness = z.object({
  id: uuid,
  name: z.string().trim().min(1, "Enter the witness's name.").max(120),
  phone: z.string().trim().max(40).default(""),
  statement: z.string().trim().max(4000).default(""),
});

export async function addWitness(raw: z.input<typeof witness>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("safety.manage");
    const parsed = witness.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form.");
    const w = parsed.data;
    const { error } = await (await createClient()).rpc("safety_add_witness", { p_id: w.id, p_name: w.name, p_phone: w.phone, p_statement: w.statement });
    if (error) return fail(dbErrorMessage(error));
    refresh(w.id);
    return ok(undefined, "Witness added.");
  });
}

const action = z.object({
  id: uuid,
  description: z.string().trim().min(1, "Describe the action.").max(1000),
  assigned_to: z.string().trim().refine((v) => !v || uuid.safeParse(v).success, "Choose from the list.").default(""),
  due_on: z.string().trim().refine((v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v), "Enter a full date.").default(""),
});

export async function addCorrectiveAction(raw: z.input<typeof action>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("safety.manage");
    const parsed = action.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form.");
    const a = parsed.data;
    const { error } = await (await createClient()).rpc("safety_add_action", { p_id: a.id, p_description: a.description, p_assigned_to: a.assigned_to || null, p_due_on: a.due_on || null });
    if (error) return fail(dbErrorMessage(error));
    refresh(a.id);
    return ok(undefined, "Corrective action added.");
  });
}

export async function completeCorrectiveAction(raw: { incidentId: string; actionId: string; note: string }): Promise<ActionResult> {
  return guard(async () => {
    if (!uuid.safeParse(raw.actionId).success || !uuid.safeParse(raw.incidentId).success) return fail("Action not found.");
    const { error } = await (await createClient()).rpc("safety_complete_action", { p_action: raw.actionId, p_note: String(raw.note ?? "").slice(0, 2000) });
    if (error) return fail(dbErrorMessage(error));
    refresh(raw.incidentId);
    return ok(undefined, "Action marked done.");
  });
}

export async function closeIncident(raw: { id: string; note: string }): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("safety.manage");
    if (!uuid.safeParse(raw.id).success) return fail("Incident not found.");
    const { error } = await (await createClient()).rpc("safety_close", { p_id: raw.id, p_note: String(raw.note ?? "").slice(0, 2000) });
    if (error) return fail(dbErrorMessage(error));
    refresh(raw.id);
    return ok(undefined, "Incident closed.");
  });
}
