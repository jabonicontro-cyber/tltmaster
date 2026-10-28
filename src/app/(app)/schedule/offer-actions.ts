"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isIsoDate } from "@/lib/dates";
import { uuid } from "@/lib/schemas/common";
import { assertPermission, requireAccess } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Shift offers (B102, migration 20261120004700). Each action calls one database function that checks the permission,
// the company and every qualification again; a shift is written only by the database after those checks.

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 06:00.");
const refresh = () => {
  revalidatePath("/schedule");
  revalidatePath("/driver");
  revalidatePath("/dispatch", "layout");
};

const offerInput = z.object({
  date: z.string().refine(isIsoDate, "Choose the date."),
  start: time,
  end: time,
  breakMinutes: z.coerce.number().int().min(0, "The break is 0 to 240 minutes.").max(240, "The break is 0 to 240 minutes.").default(0),
  audience: z.enum(["drivers", "shop", "everyone"]),
  note: z.string().trim().max(300).default(""),
  targets: z.array(uuid).max(50, "Offer a shift to at most 50 people.").default([]),
});

export async function createShiftOffer(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("schedules.manage");
    const p = offerInput.safeParse({
      date: formData.get("date"), start: formData.get("start"), end: formData.get("end"), breakMinutes: formData.get("break") || 0,
      audience: formData.get("audience"), note: formData.get("note") ?? "", targets: formData.getAll("target").map(String),
    });
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Check the shift.");
    if (p.data.start === p.data.end) return fail("A shift needs a start and an end time.");
    const { error } = await (await createClient()).rpc("shift_offer_create", {
      p_date: p.data.date, p_start: p.data.start, p_end: p.data.end, p_break: p.data.breakMinutes, p_audience: p.data.audience,
      p_note: p.data.note, p_targets: p.data.targets.length ? p.data.targets : null,
    });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Shift offered.");
  });
}

export async function decideShiftOffer(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("schedules.manage");
    const id = uuid.safeParse(formData.get("response"));
    if (!id.success) return fail("Answer not found.");
    const approve = formData.get("decision") === "approve";
    const { error } = await (await createClient()).rpc("shift_offer_decide", { p_response: id.data, p_approve: approve, p_note: "" });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, approve ? "Shift given. It is on the Schedule." : "Declined.");
  });
}

export async function cancelShiftOffer(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("schedules.manage");
    const id = uuid.safeParse(formData.get("offer"));
    if (!id.success) return fail("Shift offer not found.");
    const reason = String(formData.get("reason") ?? "").trim().slice(0, 300);
    if (!reason) return fail("Give a reason.");
    const { error } = await (await createClient()).rpc("shift_offer_cancel", { p_offer: id.data, p_reason: reason });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Shift offer withdrawn.");
  });
}

const RESPONDED: Record<string, string> = {
  requested: "Asked. A planner will decide.",
  approved: "The shift is yours. It is on your schedule.",
  accepted: "Accepted. A planner will confirm.",
};

/** A person answering for themselves: the database finds their own person record. */
export async function respondShiftOffer(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await requireAccess();
    const id = uuid.safeParse(formData.get("offer"));
    if (!id.success) return fail("Shift offer not found.");
    const { data, error } = await (await createClient()).rpc("shift_offer_respond", { p_offer: id.data });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, RESPONDED[String(data)] ?? "Done.");
  });
}

export async function withdrawShiftOffer(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await requireAccess();
    const id = uuid.safeParse(formData.get("offer"));
    if (!id.success) return fail("Shift offer not found.");
    const { error } = await (await createClient()).rpc("shift_offer_withdraw", { p_offer: id.data });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Withdrawn.");
  });
}

export async function saveShiftOfferMode(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("settings.manage");
    const mode = z.enum(["request", "first_accept", "offer"]).safeParse(formData.get("mode"));
    if (!mode.success) return fail("Choose how shift offers are filled.");
    const { error } = await (await createClient()).rpc("shift_offer_set_mode", { p_mode: mode.data });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/settings");
    revalidatePath("/schedule");
    return ok(undefined, "Saved. New shift offers use this; offers already out keep theirs.");
  });
}
