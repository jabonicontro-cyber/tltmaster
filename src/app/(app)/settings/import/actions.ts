"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import { readImportForm } from "@/server/imports";
import { createClient } from "@/server/supabase/server";

// A company importing its own records (B106, migration 20261120004600): stage a spreadsheet, review every row, approve
// all at once, or undo later (records become inactive, never deleted). settings.manage is checked here and again by the
// database functions. Results come back as ?saved= / ?error= so the forms work without JavaScript.

const uuid = z.uuid();
const LIST = "/settings?tab=import";
const go = (path: string, key: string, value: string): never =>
  redirect(`${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value.slice(0, 300))}`);

async function db(path: string) {
  try {
    await assertPermission("settings.manage");
  } catch {
    go(path, "error", "You do not have permission to import records.");
  }
  return createClient();
}

export async function stageCompanyImport(formData: FormData) {
  const form = readImportForm(formData);
  if (!form.ok) return go(LIST, "error", form.error);
  const supabase = await db(LIST);
  const { data, error } = await supabase.rpc("company_import_stage", { p_entity: form.entity, p_file_name: form.fileName, p_mapping: form.mapping, p_rows: form.rows });
  if (error) go(LIST, "error", dbErrorMessage(error));
  redirect(`/settings/import/${data as string}`);
}

export async function decideCompanyImportRow(formData: FormData) {
  const batch = uuid.parse(formData.get("batch"));
  const row = uuid.parse(formData.get("row"));
  const decision = z.enum(["import", "skip"]).parse(formData.get("decision"));
  const path = `/settings/import/${batch}`;
  const supabase = await db(path);
  const { error } = await supabase.rpc("company_import_decide", { p_row: row, p_decision: decision });
  if (error) go(path, "error", dbErrorMessage(error));
  revalidatePath(path);
  redirect(`${path}#row-${row}`);
}

export async function approveCompanyImport(formData: FormData) {
  const batch = uuid.parse(formData.get("batch"));
  const path = `/settings/import/${batch}`;
  if (formData.get("confirm") !== "yes") go(path, "error", "Tick the box to confirm the review.");
  const supabase = await db(path);
  const { error } = await supabase.rpc("company_import_approve", { p_batch: batch });
  if (error) go(path, "error", dbErrorMessage(error));
  revalidatePath(path);
  go(path, "saved", "approved");
}

export async function discardCompanyImport(formData: FormData) {
  const batch = uuid.parse(formData.get("batch"));
  const path = `/settings/import/${batch}`;
  const supabase = await db(path);
  const { error } = await supabase.rpc("company_import_discard", { p_batch: batch });
  if (error) go(path, "error", dbErrorMessage(error));
  revalidatePath(path);
  go(path, "saved", "discarded");
}

export async function undoCompanyImport(formData: FormData) {
  const batch = uuid.parse(formData.get("batch"));
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 300);
  const path = `/settings/import/${batch}`;
  if (!reason) go(path, "error", "Give a reason for undoing the import.");
  const supabase = await db(path);
  const { error } = await supabase.rpc("company_import_undo", { p_batch: batch, p_reason: reason });
  if (error) go(path, "error", dbErrorMessage(error));
  revalidatePath(path);
  go(path, "saved", "undone");
}
