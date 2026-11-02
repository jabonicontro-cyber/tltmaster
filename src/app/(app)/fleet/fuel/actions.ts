"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isOperationalDate } from "@/lib/dates";
import { assertAnyPermission, assertPermission } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Fuel and IFTA (B130). Drivers and the office use the same actions; the database decides who may record for which
// truck (a driver: a truck they drove that day or their own truck; the office: fleet.edit).

const uuid = z.uuid();
const state = z.string().regex(/^[A-Z]{2}$/, "Choose the state or province.");

const purchaseInput = z.object({
  truckId: uuid,
  day: z.string().refine(isOperationalDate, "Enter the day."),
  jurisdiction: state,
  gallons: z.string().trim().regex(/^\d{1,4}(\.\d{1,3})?$/, "Enter the gallons, for example 82.4."),
  total: z.string().trim().regex(/^\d{1,6}(\.\d{1,2})?$/, "Enter the total in dollars."),
  odometer: z.string().trim().regex(/^\d{0,7}$/, "Enter the odometer in whole miles.").default(""),
  vendor: z.string().trim().max(120).default(""),
  receipt: z.string().trim().max(80).default(""),
});

const tripInput = z.object({
  truckId: uuid,
  day: z.string().refine(isOperationalDate, "Enter the day."),
  start: z.string().trim().regex(/^\d{1,7}$/, "Enter the start odometer."),
  end: z.string().trim().regex(/^\d{1,7}$/, "Enter the end odometer."),
  legs: z.array(z.object({ jurisdiction: state, miles: z.string().trim().regex(/^\d{1,4}$/, "Enter whole miles.") })).min(1).max(12),
});

const revalidate = () => {
  revalidatePath("/fleet/fuel");
  revalidatePath("/driver");
};

export async function recordFuel(input: z.input<typeof purchaseInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertAnyPermission("driver.portal", "fleet.edit");
    const p = purchaseInput.safeParse(input);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Check the form.");
    const v = p.data;
    const { error } = await (await createClient()).rpc("fuel_record_purchase", { p: {
      truck_id: v.truckId, purchased_on: v.day, jurisdiction: v.jurisdiction, gallons: v.gallons,
      total_cents: Math.round(Number(v.total) * 100), odometer: v.odometer || null, vendor: v.vendor, receipt_ref: v.receipt,
    } });
    if (error) return fail(dbErrorMessage(error));
    revalidate();
    return ok(undefined, "Fuel recorded.");
  });
}

export async function recordTripSheet(input: z.input<typeof tripInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertAnyPermission("driver.portal", "fleet.edit");
    const p = tripInput.safeParse(input);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Check the form.");
    const v = p.data;
    const { error } = await (await createClient()).rpc("fuel_record_trip_sheet", { p: {
      truck_id: v.truckId, sheet_date: v.day, start_odometer: Number(v.start), end_odometer: Number(v.end),
      legs: v.legs.map((l) => ({ jurisdiction: l.jurisdiction, miles: Number(l.miles) })),
    } });
    if (error) return fail(dbErrorMessage(error));
    revalidate();
    return ok(undefined, "Trip sheet saved.");
  });
}

export async function voidFuelEntry(kind: "purchase" | "trip_sheet", id: string, reason: string): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("fleet.edit");
    if (!uuid.safeParse(id).success) return fail("Entry not found.");
    const { error } = await (await createClient()).rpc("fuel_void", { p_kind: kind, p_id: id, p_reason: reason.slice(0, 300) });
    if (error) return fail(dbErrorMessage(error));
    revalidate();
    return ok(undefined, "Voided.");
  });
}
