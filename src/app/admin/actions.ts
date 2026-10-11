"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { IMPORT_ENTITIES, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, mappingProblems, parseCsv, prepareRows } from "@/lib/platform/imports";
import { PREVIEW_COOKIE } from "@/lib/platform/preview";
import { isLeadStatus } from "@/lib/platform/leads";
import { seedDemoCompany } from "@/server/demo/seed";
import { dbErrorMessage } from "@/server/errors";
import { assertPlatformAdmin } from "@/server/platform";
import { createClient } from "@/server/supabase/server";

// Platform-team actions. Each checks the platform role here, and the database
// function it calls checks it again. Results come back as ?error= / ?saved=
// on the page, so every form also works without JavaScript.

const uuid = z.uuid();
const back = (path: string, error: string): never => redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(error.slice(0, 300))}`);

async function db() {
  await assertPlatformAdmin();
  return createClient();
}

export async function updateLead(formData: FormData) {
  const id = uuid.parse(formData.get("id"));
  const status = String(formData.get("status") ?? "");
  const owner = String(formData.get("owner") ?? "");
  const followUp = String(formData.get("follow_up_on") ?? "");
  const path = `/admin/leads/${id}`;
  if (!isLeadStatus(status)) back(path, "Choose a status.");
  if (owner && !uuid.safeParse(owner).success) back(path, "Choose an owner.");
  if (followUp && !/^\d{4}-\d{2}-\d{2}$/.test(followUp)) back(path, "Enter the follow-up date as YYYY-MM-DD.");
  const supabase = await db();
  const { error } = await supabase.rpc("platform_lead_update", { p_id: id, p_status: status, p_owner: owner || null, p_follow_up: followUp || null });
  if (error) back(path, dbErrorMessage(error));
  revalidatePath("/admin/leads");
  revalidatePath(path);
  redirect(`${path}?saved=1`);
}

export async function addLeadNote(formData: FormData) {
  const id = uuid.parse(formData.get("id"));
  const note = String(formData.get("note") ?? "").trim();
  const path = `/admin/leads/${id}`;
  if (!note) back(path, "Write the note first.");
  const supabase = await db();
  const { error } = await supabase.rpc("platform_lead_note", { p_id: id, p_note: note });
  if (error) back(path, dbErrorMessage(error));
  // The same page with only a new #hash would not re-render: refresh its data.
  revalidatePath(path);
  redirect(`${path}?saved=1#history`);
}

export async function createCompany(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const timezone = String(formData.get("timezone") ?? "").trim();
  const lead = String(formData.get("lead") ?? "");
  const from = lead && uuid.safeParse(lead).success ? `/admin/leads/${lead}` : "/admin/onboarding";
  const supabase = await db();
  const { data, error } = await supabase.rpc("platform_create_company", { p_name: name, p_timezone: timezone, p_lead: lead && uuid.safeParse(lead).success ? lead : null });
  if (error) back(from, dbErrorMessage(error));
  revalidatePath("/admin/onboarding");
  redirect(`/admin/onboarding/${data as string}?created=1`);
}

export async function stageImport(formData: FormData) {
  const company = uuid.parse(formData.get("company"));
  const path = `/admin/onboarding/${company}`;
  const entity = z.enum(IMPORT_ENTITIES).safeParse(formData.get("entity"));
  if (!entity.success) back(path, "Choose what the spreadsheet contains.");
  const csv = String(formData.get("csv") ?? "");
  const fileName = String(formData.get("file_name") ?? "").slice(0, 200);
  if (!csv.trim()) back(path, "Choose a spreadsheet file (CSV).");
  if (csv.length > MAX_IMPORT_BYTES) back(path, "The file is too large. Split it into smaller files.");
  let mapping: string[] = [];
  try {
    mapping = z.array(z.string().max(40)).max(200).parse(JSON.parse(String(formData.get("mapping") ?? "[]")));
  } catch {
    back(path, "The column choices could not be read. Choose the columns again.");
  }
  const table = parseCsv(csv);
  if (table.length < 2) back(path, "The file has a header row but no data rows.");
  if (table.length - 1 > MAX_IMPORT_ROWS) back(path, `Import at most ${MAX_IMPORT_ROWS.toLocaleString()} rows at a time.`);
  const problems = mappingProblems(mapping, entity.data!);
  if (problems.length) back(path, problems[0]);
  // The server's own validation is authoritative; the browser preview only helps.
  const rows = prepareRows(table, mapping, entity.data!);
  const mapped = Object.fromEntries(table[0].map((h, i) => [h, mapping[i] ?? ""]).filter(([, k]) => k));
  const supabase = await db();
  const { data, error } = await supabase.rpc("platform_import_stage", { p_company: company, p_entity: entity.data, p_file_name: fileName, p_mapping: mapped, p_rows: rows });
  if (error) back(path, dbErrorMessage(error));
  redirect(`/admin/onboarding/batch/${data as string}`);
}

export async function decideImportRow(formData: FormData) {
  const batch = uuid.parse(formData.get("batch"));
  const row = uuid.parse(formData.get("row"));
  const decision = z.enum(["import", "skip"]).parse(formData.get("decision"));
  const path = `/admin/onboarding/batch/${batch}`;
  const supabase = await db();
  const { error } = await supabase.rpc("platform_import_decide", { p_row: row, p_decision: decision });
  if (error) back(path, dbErrorMessage(error));
  revalidatePath(path);
  redirect(`${path}#row-${row}`);
}

export async function approveImport(formData: FormData) {
  const batch = uuid.parse(formData.get("batch"));
  const path = `/admin/onboarding/batch/${batch}`;
  if (formData.get("confirm") !== "yes") back(path, "Tick the box to confirm the review.");
  const supabase = await db();
  const { error } = await supabase.rpc("platform_import_approve", { p_batch: batch });
  if (error) back(path, dbErrorMessage(error));
  revalidatePath(path);
  redirect(`${path}?saved=approved`);
}

export async function discardImport(formData: FormData) {
  const batch = uuid.parse(formData.get("batch"));
  const path = `/admin/onboarding/batch/${batch}`;
  const supabase = await db();
  const { error } = await supabase.rpc("platform_import_discard", { p_batch: batch });
  if (error) back(path, dbErrorMessage(error));
  revalidatePath(path);
  redirect(`${path}?saved=discarded`);
}

export async function revertImport(formData: FormData) {
  const batch = uuid.parse(formData.get("batch"));
  const reason = String(formData.get("reason") ?? "").trim();
  const path = `/admin/onboarding/batch/${batch}`;
  if (!reason) back(path, "Give a reason for reverting.");
  const supabase = await db();
  const { error } = await supabase.rpc("platform_import_revert", { p_batch: batch, p_reason: reason });
  if (error) back(path, dbErrorMessage(error));
  revalidatePath(path);
  redirect(`${path}?saved=reverted`);
}

/** Start a fresh demo company, fill it with fictional data, and open it. */
export async function startDemo(formData: FormData) {
  const timezone = String(formData.get("timezone") ?? "America/Chicago");
  const supabase = await db();
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase.rpc("platform_demo_start", { p_timezone: timezone });
  if (error) back("/admin/demo", dbErrorMessage(error));
  try {
    await seedDemoCompany(supabase, userData.user!.id, timezone);
  } catch (e) {
    back("/admin/demo", e instanceof Error ? e.message : "The demo data could not be created.");
  }
  (await cookies()).delete(PREVIEW_COOKIE);
  revalidatePath("/", "layout");
  redirect("/command-center?demo=started");
}

export async function enterDemo() {
  const supabase = await db();
  const { error } = await supabase.rpc("platform_demo_enter");
  if (error) back("/admin/demo", dbErrorMessage(error));
  revalidatePath("/", "layout");
  redirect("/command-center");
}
