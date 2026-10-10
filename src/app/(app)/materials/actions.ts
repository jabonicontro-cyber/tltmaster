"use server";

import { revalidatePath } from "next/cache";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { chargeItemSchema, materialSchema, priceEntrySchema, priceListSchema, unitSchema } from "@/lib/schemas/catalog";
import { uuid } from "@/lib/schemas/common";
import { addDays } from "@/lib/dates";
import { parseMoneyToCents, parsePercentToBp } from "@/lib/money";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

function done(message: string) {
  revalidatePath("/materials", "layout");
  return ok(undefined, message);
}

export async function saveMaterial(id: string | null, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("materials.edit");
    if (id && !uuid.safeParse(id).success) return fail("Invalid material.");
    const parsed = materialSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { error } = id
      ? await supabase.from("materials").update(parsed.data).eq("id", id)
      : await supabase.from("materials").insert(parsed.data);
    if (error) return fail(dbErrorMessage(error));
    return done(id ? "Material updated." : "Material added.");
  });
}

export async function setMaterialActive(id: string, active: boolean): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("materials.edit");
    const supabase = await createClient();
    const { error } = await supabase.from("materials").update({ active }).eq("id", id);
    if (error) return fail(dbErrorMessage(error));
    return done(active ? "Material reactivated." : "Material deactivated. Existing quotes keep it.");
  });
}

export async function saveChargeItem(id: string | null, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("materials.edit");
    if (id && !uuid.safeParse(id).success) return fail("Invalid charge.");
    const parsed = chargeItemSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { error } = id
      ? await supabase.from("charge_items").update(parsed.data).eq("id", id)
      : await supabase.from("charge_items").insert(parsed.data);
    if (error) return fail(dbErrorMessage(error));
    return done(id ? "Charge updated." : "Charge added.");
  });
}

export async function setChargeItemActive(id: string, active: boolean): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("materials.edit");
    const supabase = await createClient();
    const { error } = await supabase.from("charge_items").update({ active }).eq("id", id);
    if (error) return fail(dbErrorMessage(error));
    return done(active ? "Charge reactivated." : "Charge deactivated.");
  });
}

export async function saveUnit(existingCode: string | null, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("materials.edit");
    const parsed = unitSchema.safeParse({ ...Object.fromEntries(formData), code: existingCode ?? formData.get("code") });
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { code, ...rest } = parsed.data;
    const { error } = existingCode
      ? await supabase.from("units_of_measure").update(rest).eq("code", existingCode)
      : await supabase.from("units_of_measure").insert(parsed.data);
    if (error) return fail(dbErrorMessage(error));
    return done(existingCode ? "Unit updated." : `Unit "${code}" added.`);
  });
}

export async function setUnitActive(code: string, active: boolean): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("materials.edit");
    const supabase = await createClient();
    const { error } = await supabase.from("units_of_measure").update({ active }).eq("code", code);
    if (error) return fail(dbErrorMessage(error));
    return done(active ? "Unit reactivated." : "Unit deactivated.");
  });
}

export async function savePriceList(id: string | null, formData: FormData): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    await assertPermission("pricing.edit");
    const parsed = priceListSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const res = id
      ? await supabase.from("price_lists").update(parsed.data).eq("id", id).select("id").single()
      : await supabase.from("price_lists").insert(parsed.data).select("id").single();
    if (res.error) return fail(dbErrorMessage(res.error));
    revalidatePath("/materials", "layout");
    return ok({ id: res.data.id }, id ? "Price list updated." : "Price list created.");
  });
}

export async function setPriceListActive(id: string, active: boolean): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("pricing.edit");
    const supabase = await createClient();
    const { data: list } = await supabase.from("price_lists").select("is_standard").eq("id", id).maybeSingle();
    if (list?.is_standard && !active) return fail("The standard price list cannot be deactivated.");
    const { error } = await supabase.from("price_lists").update({ active }).eq("id", id);
    if (error) return fail(dbErrorMessage(error));
    return done(active ? "Price list reactivated." : "Price list deactivated. Customers using it fall back to standard rates.");
  });
}

export async function savePriceEntry(priceListId: string, entryId: string | null, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("pricing.edit");
    if (!uuid.safeParse(priceListId).success) return fail("Invalid price list.");
    const parsed = priceEntrySchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { error } = entryId
      ? await supabase.from("price_list_entries").update(parsed.data).eq("id", entryId).eq("price_list_id", priceListId)
      : await supabase.from("price_list_entries").insert({ ...parsed.data, price_list_id: priceListId });
    if (error) {
      if (error.code === "23505") return fail("This item already has a rate starting on that date in this list. Edit that rate or pick another start date.");
      return fail(dbErrorMessage(error));
    }
    return done(entryId ? "Rate corrected. Existing quotes keep the rate they were saved with." : "Rate added.");
  });
}

/**
 * Change a rate going forward: ends the current entry the day before the new
 * one starts, keeping price history. Saved quotes are never affected — each
 * quote line stores its own rate.
 */
export async function changeRate(priceListId: string, entryId: string, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("pricing.edit");
    const supabase = await createClient();
    const { data: entry, error } = await supabase.from("price_list_entries").select("*").eq("id", entryId).eq("price_list_id", priceListId).maybeSingle();
    if (error || !entry) return fail("Rate not found.");
    const from = String(formData.get("effective_from") ?? "");
    const value = String(formData.get("value") ?? "");
    const notes = String(formData.get("notes") ?? "").slice(0, 300);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return fail("Enter the date the new rate starts.", { effective_from: "Enter a valid date." });
    if (from <= entry.effective_from) return fail("The new rate must start after the current rate's start date.", { effective_from: "Must be after " + entry.effective_from });
    const isPercent = entry.percent_bp !== null;
    const parsedValue = isPercent ? parsePercentToBp(value) : parseMoneyToCents(value);
    if (parsedValue === null || parsedValue < (isPercent ? 1 : 0)) return fail("Enter a valid amount.", { value: "Enter a valid amount." });

    const { error: insErr } = await supabase.from("price_list_entries").insert({
      price_list_id: priceListId,
      material_id: entry.material_id,
      charge_item_id: entry.charge_item_id,
      unit_code: entry.unit_code,
      rate_cents: isPercent ? null : parsedValue,
      percent_bp: isPercent ? parsedValue : null,
      effective_from: from,
      effective_to: entry.effective_to && entry.effective_to >= from ? entry.effective_to : null,
      notes,
    });
    if (insErr) {
      if (insErr.code === "23505") return fail("A rate already starts on that date.");
      return fail(dbErrorMessage(insErr));
    }
    const { error: updErr } = await supabase.from("price_list_entries").update({ effective_to: addDays(from, -1) }).eq("id", entryId);
    if (updErr) return fail(`New rate saved, but the old rate could not be ended: ${dbErrorMessage(updErr)}`);
    return done("Rate changed. Existing quotes keep the rate they were saved with.");
  });
}

export async function deletePriceEntry(priceListId: string, entryId: string): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("pricing.edit");
    const supabase = await createClient();
    const { error } = await supabase.from("price_list_entries").delete().eq("id", entryId).eq("price_list_id", priceListId);
    if (error) return fail(dbErrorMessage(error));
    return done("Rate removed. Existing quotes keep the rate they were saved with.");
  });
}
