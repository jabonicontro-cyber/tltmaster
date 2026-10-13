"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isIsoDate } from "@/lib/dates";
import { uuid } from "@/lib/schemas/common";
import {
  driverSchema,
  ownershipSchema,
  vehicleDocumentSchema,
  qualificationSchema,
  serviceStatusSchema,
  toEquipmentRow,
  toQualificationRow,
  trailerFormValues,
  trailerSchema,
  truckSchema,
} from "@/lib/schemas/fleet";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

type DbError = { code?: string; message?: string };

/** Unique unit numbers / employee numbers get a field-level message. */
function uniqueFailure(error: DbError, field: string, message: string) {
  if (error.code === "23505") return fail(message, { [field]: message });
  if (error.code === "23503") return fail("A linked record was not found in your company.");
  return fail(dbErrorMessage(error));
}

function revalidateFleet(path?: string) {
  revalidatePath("/fleet", "layout");
  if (path) revalidatePath(path);
}

// Trucks ------------------------------------------------------------------------

export async function saveTruck(id: string | null, formData: FormData): Promise<ActionResult<{ id: string }>> {
  let savedId: string | null = null;
  const result = await guard(async () => {
    await assertPermission("fleet.edit");
    if (id && !uuid.safeParse(id).success) return fail("Invalid truck.");
    const parsed = truckSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const row = toEquipmentRow(parsed.data);
    const supabase = await createClient();
    const res = id ? await supabase.from("trucks").update(row).eq("id", id).select("id") : await supabase.from("trucks").insert(row).select("id");
    if (res.error) return uniqueFailure(res.error, "unit_number", "Another truck already uses this unit number.");
    if (!res.data?.length) return fail("Truck not found or you do not have permission to edit it.");
    savedId = res.data[0].id as string;
    revalidateFleet(`/fleet/trucks/${savedId}`);
    return ok({ id: savedId });
  });
  if (savedId && result.ok) redirect(`/fleet/trucks/${savedId}?saved=1`);
  return result;
}

// Trailers ----------------------------------------------------------------------

export async function saveTrailer(id: string | null, formData: FormData): Promise<ActionResult<{ id: string }>> {
  let savedId: string | null = null;
  const result = await guard(async () => {
    await assertPermission("fleet.edit");
    if (id && !uuid.safeParse(id).success) return fail("Invalid trailer.");
    const parsed = trailerSchema.safeParse(trailerFormValues(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const row = toEquipmentRow(parsed.data);
    const supabase = await createClient();
    const res = id ? await supabase.from("trailers").update(row).eq("id", id).select("id") : await supabase.from("trailers").insert(row).select("id");
    if (res.error) return uniqueFailure(res.error, "unit_number", "Another trailer already uses this unit number.");
    if (!res.data?.length) return fail("Trailer not found or you do not have permission to edit it.");
    savedId = res.data[0].id as string;
    revalidateFleet(`/fleet/trailers/${savedId}`);
    return ok({ id: savedId });
  });
  if (savedId && result.ok) redirect(`/fleet/trailers/${savedId}?saved=1`);
  return result;
}

/** Deactivate (retire) or reactivate a truck or trailer. Records are never deleted. */
export async function setEquipmentActive(kind: "truck" | "trailer", id: string, active: boolean): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("fleet.edit");
    if (!uuid.safeParse(id).success || (kind !== "truck" && kind !== "trailer")) return fail("Invalid equipment.");
    const supabase = await createClient();
    const { data, error } = await supabase.from(kind === "truck" ? "trucks" : "trailers").update({ active }).eq("id", id).select("id");
    if (error) return fail(dbErrorMessage(error));
    if (!data?.length) return fail("Equipment not found.");
    revalidateFleet(`/fleet/${kind}s/${id}`);
    const label = kind === "truck" ? "Truck" : "Trailer";
    return ok(undefined, active ? `${label} reactivated.` : `${label} deactivated.`);
  });
}

/** Take a truck or trailer out of service (reason required) or return it to service. */
export async function setServiceStatus(input: z.input<typeof serviceStatusSchema>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("fleet.service");
    const parsed = serviceStatusSchema.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const s = parsed.data;
    const supabase = await createClient();
    const { error } = await supabase.rpc("set_equipment_service_status", {
      p_kind: s.kind,
      p_id: s.id,
      p_status: s.status,
      p_reason: s.reason,
      p_expected_return: s.status === "out_of_service" ? s.expected_return_date : null,
    });
    if (error) return fail(dbErrorMessage(error));
    revalidateFleet(`/fleet/${s.kind}s/${s.id}`);
    return ok(undefined, s.status === "out_of_service" ? "Marked out of service." : "Returned to service.");
  });
}

// Drivers -----------------------------------------------------------------------

export async function saveDriver(id: string | null, formData: FormData): Promise<ActionResult<{ id: string }>> {
  let savedId: string | null = null;
  const result = await guard(async () => {
    await assertPermission("fleet.edit");
    if (id && !uuid.safeParse(id).success) return fail("Invalid driver.");
    const parsed = driverSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const row = parsed.data;
    const res = id ? await supabase.from("drivers").update(row).eq("id", id).select("id") : await supabase.from("drivers").insert(row).select("id");
    if (res.error) {
      if (res.error.code === "23505" && /user/.test(res.error.message ?? "")) return fail("This user is already linked to another driver.", { user_id: "Already linked to another driver." });
      if (res.error.code === "23503") return fail("The selected user is not a member of your company.", { user_id: "Not a member of your company." });
      return uniqueFailure(res.error, "employee_number", "Another driver already uses this employee number.");
    }
    if (!res.data?.length) return fail("Driver not found or you do not have permission to edit it.");
    savedId = res.data[0].id as string;
    revalidateFleet(`/fleet/drivers/${savedId}`);
    return ok({ id: savedId });
  });
  if (savedId && result.ok) redirect(`/fleet/drivers/${savedId}?saved=1`);
  return result;
}

export async function setDriverActive(id: string, active: boolean): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("fleet.edit");
    if (!uuid.safeParse(id).success) return fail("Invalid driver.");
    const supabase = await createClient();
    const { data, error } = await supabase.from("drivers").update({ active }).eq("id", id).select("id");
    if (error) return fail(dbErrorMessage(error));
    if (!data?.length) return fail("Driver not found.");
    revalidateFleet(`/fleet/drivers/${id}`);
    return ok(undefined, active ? "Driver reactivated." : "Driver marked inactive.");
  });
}

export async function saveQualification(driverId: string, qualificationId: string | null, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("fleet.edit");
    if (!uuid.safeParse(driverId).success || (qualificationId && !uuid.safeParse(qualificationId).success)) return fail("Invalid record.");
    const parsed = qualificationSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const row = toQualificationRow(parsed.data);
    const supabase = await createClient();
    const res = qualificationId
      ? await supabase.from("driver_qualifications").update(row).eq("id", qualificationId).eq("driver_id", driverId).select("id")
      : await supabase.from("driver_qualifications").insert({ ...row, driver_id: driverId }).select("id");
    if (res.error) return fail(res.error.code === "23503" ? "Driver not found." : dbErrorMessage(res.error));
    if (!res.data?.length) return fail("Qualification not found or you do not have permission to edit it.");
    revalidateFleet(`/fleet/drivers/${driverId}`);
    return ok(undefined, qualificationId ? "Qualification updated." : "Qualification added.");
  });
}

/** Remove a mistaken entry (audited). Expired qualifications should normally be kept as history. */
export async function deleteQualification(driverId: string, qualificationId: string): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("fleet.edit");
    if (!uuid.safeParse(driverId).success || !uuid.safeParse(qualificationId).success) return fail("Invalid record.");
    const supabase = await createClient();
    const { data, error } = await supabase.from("driver_qualifications").delete().eq("id", qualificationId).eq("driver_id", driverId).select("id");
    if (error) return fail(dbErrorMessage(error));
    if (!data?.length) return fail("Qualification not found.");
    revalidateFleet(`/fleet/drivers/${driverId}`);
    return ok(undefined, "Qualification removed.");
  });
}

// Dispatch readiness ----------------------------------------------------------

const eligibilityInput = z.object({
  truckId: z.preprocess((v) => (v === "" ? null : v), z.uuid().nullable()),
  trailerId: z.preprocess((v) => (v === "" ? null : v), z.uuid().nullable()),
  driverId: z.preprocess((v) => (v === "" ? null : v), z.uuid().nullable()),
  on: z.string().refine(isIsoDate, "Enter a valid date."),
});

export interface EligibilityCheck {
  on: string;
  eligible: boolean;
  blockers: string[];
  warnings: string[];
}

/** The database decides (public.check_assignment_eligibility). */
export async function checkEligibility(input: z.input<typeof eligibilityInput>): Promise<ActionResult<EligibilityCheck>> {
  return guard(async () => {
    await assertPermission("fleet.view");
    const parsed = eligibilityInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const { truckId, trailerId, driverId, on } = parsed.data;
    if (!truckId && !trailerId && !driverId) return fail("Choose a truck, a trailer or a driver.");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("check_assignment_eligibility", { p_truck_id: truckId, p_trailer_id: trailerId, p_driver_id: driverId, p_on: on });
    if (error) return fail(dbErrorMessage(error));
    return ok(data as EligibilityCheck);
  });
}

// Assignments, documents, ownership (20261102000100) ------------------------------

/** Make a driver the one whose primary truck this is (null removes them). Atomic reassign; needs fleet.assign. */
export async function assignTruckDriver(truckId: string, driverId: string | null): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("fleet.assign");
    if (!uuid.safeParse(truckId).success || (driverId !== null && !uuid.safeParse(driverId).success)) return fail("Invalid selection.");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("assign_truck_driver", { p_truck_id: truckId, p_driver_id: driverId });
    if (error) return fail(dbErrorMessage(error));
    revalidateFleet(`/fleet/trucks/${truckId}`);
    revalidatePath("/employees", "layout");
    const r = data as { changed: boolean };
    if (!r.changed) return ok(undefined, "No change.");
    return ok(undefined, driverId ? "Driver assigned." : "Driver removed from this truck.");
  });
}

const vehicleRef = z.object({ kind: z.enum(["truck", "trailer"]), id: uuid });

/** Add or edit a document's details (fleet.edit). A repeated submit with the same key adds nothing. */
export async function saveVehicleDocument(vehicle: z.input<typeof vehicleRef>, documentId: string | null, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("fleet.edit");
    const v = vehicleRef.safeParse(vehicle);
    if (!v.success || (documentId && !uuid.safeParse(documentId).success)) return fail("Invalid vehicle or document.");
    const parsed = vehicleDocumentSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const { submission_key, ...fields } = parsed.data;
    const supabase = await createClient();
    const column = v.data.kind === "truck" ? "truck_id" : "trailer_id";
    const res = documentId
      ? await supabase.from("vehicle_documents").update(fields).eq("id", documentId).eq(column, v.data.id).is("archived_at", null).select("id")
      : await supabase.from("vehicle_documents").insert({ ...fields, [column]: v.data.id, submission_key }).select("id");
    if (res.error) {
      if (res.error.code === "23505") return ok(undefined, "Document already added.");
      if (res.error.code === "23503") return fail("The vehicle was not found in your company.");
      return fail(dbErrorMessage(res.error));
    }
    if (!res.data?.length) return fail("The document was not found, is archived, or you may not edit it.");
    revalidateFleet(`/fleet/${v.data.kind}s/${v.data.id}`);
    return ok(undefined, documentId ? "Document saved." : "Document added.");
  });
}

/** Archive a document that was replaced or no longer applies (kept in history; not deleted). */
export async function archiveVehicleDocument(vehicle: z.input<typeof vehicleRef>, documentId: string): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("fleet.edit");
    const v = vehicleRef.safeParse(vehicle);
    if (!v.success || !uuid.safeParse(documentId).success) return fail("Invalid document.");
    const supabase = await createClient();
    const column = v.data.kind === "truck" ? "truck_id" : "trailer_id";
    const { data, error } = await supabase.from("vehicle_documents").update({ archived_at: new Date().toISOString() })
      .eq("id", documentId).eq(column, v.data.id).is("archived_at", null).select("id");
    if (error) return fail(dbErrorMessage(error));
    if (!data?.length) return fail("The document was not found or is already archived.");
    revalidateFleet(`/fleet/${v.data.kind}s/${v.data.id}`);
    return ok(undefined, "Document archived.");
  });
}

/** Record how the company holds the vehicle (fleet.edit). Empty clears it to "not recorded". */
export async function setOwnership(vehicle: z.input<typeof vehicleRef>, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("fleet.edit");
    const v = vehicleRef.safeParse(vehicle);
    if (!v.success) return fail("Invalid vehicle.");
    const parsed = ownershipSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.from(v.data.kind === "truck" ? "trucks" : "trailers").update({ ownership: parsed.data.ownership }).eq("id", v.data.id).select("id");
    if (error) return fail(error.code === "42703" || error.code === "PGRST204" ? "Ownership cannot be recorded until the latest database update is installed." : dbErrorMessage(error));
    if (!data?.length) return fail("Vehicle not found or you may not edit it.");
    revalidateFleet(`/fleet/${v.data.kind}s/${v.data.id}`);
    return ok(undefined, "Ownership saved.");
  });
}

/** Confirm a document record matches the paper (fleet.edit). Only verified expired documents can block dispatch. */
export async function verifyVehicleDocument(vehicle: z.input<typeof vehicleRef>, documentId: string): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("fleet.edit");
    const v = vehicleRef.safeParse(vehicle);
    if (!v.success || !uuid.safeParse(documentId).success) return fail("Invalid document.");
    const supabase = await createClient();
    const { error } = await supabase.rpc("verify_vehicle_document", { p_id: documentId });
    if (error) return fail(dbErrorMessage(error));
    revalidateFleet(`/fleet/${v.data.kind}s/${v.data.id}`);
    revalidatePath("/dispatch", "layout");
    return ok(undefined, "Document marked verified.");
  });
}
