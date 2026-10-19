"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Dispatch base settings (settings.manage) and per-person base access (users.manage). Both are checked here and again
// by the database (RLS, the plan-limit trigger, set_person_bases). Results come back as ?saved= / ?error= so the forms
// work without JavaScript.

const BACK = "/settings?tab=bases";
const go = (key: string, value: string): never => redirect(`${BACK}&${key}=${encodeURIComponent(value.slice(0, 300))}`);
const text = (f: FormData, k: string, max: number) => String(f.get(k) ?? "").trim().slice(0, max);
const uuid = z.uuid();

async function as(permission: "settings.manage" | "users.manage") {
  try {
    await assertPermission(permission);
  } catch {
    go("error", permission === "settings.manage" ? "You do not have permission to change dispatch bases." : "You do not have permission to change who works where.");
  }
  return createClient();
}

function baseFields(f: FormData) {
  const name = text(f, "name", 80);
  const code = text(f, "code", 10).toUpperCase();
  if (!name) go("error", "Give the base a name.");
  if (!/^[A-Z0-9][A-Z0-9-]{0,9}$/.test(code)) go("error", "The code is 1–10 letters, digits or dashes, e.g. NORTH or YARD-2.");
  return {
    name,
    code,
    address_line1: text(f, "address_line1", 160),
    city: text(f, "city", 80),
    state: text(f, "state", 40),
    postal_code: text(f, "postal_code", 20),
    timezone: text(f, "timezone", 60) || "America/Chicago",
    contact_name: text(f, "contact_name", 120),
    contact_phone: text(f, "contact_phone", 40),
  };
}

export async function createBase(formData: FormData) {
  const supabase = await as("settings.manage");
  const { error } = await supabase.from("dispatch_bases").insert(baseFields(formData));
  if (error) go("error", error.code === "23505" ? "Another base already uses that code." : dbErrorMessage(error));
  revalidatePath("/", "layout");
  go("saved", "created");
}

export async function updateBase(formData: FormData) {
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) go("error", "Choose a base.");
  const supabase = await as("settings.manage");
  const { error } = await supabase.from("dispatch_bases").update(baseFields(formData)).eq("id", id.data!);
  if (error) go("error", error.code === "23505" ? "Another base already uses that code." : dbErrorMessage(error));
  revalidatePath("/", "layout");
  go("saved", "updated");
}

export async function setBaseActive(formData: FormData) {
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) go("error", "Choose a base.");
  const active = formData.get("active") === "true";
  const supabase = await as("settings.manage");
  // Deactivating never moves or deletes the base's trucks, drivers or orders; the database refuses the default base
  // and enforces the plan limit when reactivating.
  const { error } = await supabase.from("dispatch_bases").update({ active }).eq("id", id.data!);
  if (error) go("error", dbErrorMessage(error));
  revalidatePath("/", "layout");
  go("saved", active ? "activated" : "deactivated");
}

export async function makeDefaultBase(formData: FormData) {
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) go("error", "Choose a base.");
  const supabase = await as("settings.manage");
  const { error } = await supabase.rpc("set_default_dispatch_base", { p_base: id.data! });
  if (error) go("error", dbErrorMessage(error));
  revalidatePath("/", "layout");
  go("saved", "default");
}

export async function setPersonBases(formData: FormData) {
  const user = uuid.safeParse(formData.get("user"));
  if (!user.success) go("error", "Choose a person.");
  const supabase = await as("users.manage");
  const bases = formData.getAll("bases").map(String).filter((b) => uuid.safeParse(b).success);
  // Every base checked (or none) = no limit: store an empty list so new bases are included automatically.
  const all = formData.get("all_count") === String(bases.length);
  const { error } = await supabase.rpc("set_person_bases", { p_user: user.data!, p_bases: all ? [] : bases });
  if (error) go("error", dbErrorMessage(error));
  revalidatePath("/", "layout");
  go("saved", "access");
}

export async function setCrossBaseDispatch(formData: FormData) {
  const supabase = await as("settings.manage");
  const on = formData.get("cross_base") === "on";
  const { data, error } = await supabase.from("company_settings").update({ cross_base_dispatch: on }).not("company_id", "is", null).select("company_id");
  if (error) go("error", dbErrorMessage(error));
  if (!data?.length) go("error", "Settings could not be saved.");
  revalidatePath("/", "layout");
  go("saved", on ? "cross_on" : "cross_off");
}
