"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { PREVIEW_COOKIE } from "@/lib/platform/preview";
import { isLeadStatus, isOnboardingStage } from "@/lib/platform/leads";
import { isOperationalDate } from "@/lib/dates";
import { PRAIRIE_LANTERN, seedPrairieLantern } from "@/server/demo/prairie-lantern";
import { refreshPrairieLantern } from "@/server/demo/prairie-lantern-refresh";
import { FREIGHT_DEMO, refreshFreightDemo, seedFreightDemo } from "@/server/demo/freight-demo";
import { seedDemoCompany } from "@/server/demo/seed";
import { refreshNorthfield } from "@/server/demo/northfield-refresh";
import { PORTAL_NOT_OPENED, refreshSummary } from "@/server/demo/samples";
import { withDemoRefreshLock } from "@/server/demo/auto-refresh";
import { dbErrorMessage } from "@/server/errors";
import { readImportForm } from "@/server/imports";
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

/**
 * Record a demo refresh in the platform audit (20261118000100) so the Launchpad shows the last refresh and any failure.
 * Before that update is installed the refresh still works; it is just not recorded.
 */
async function recordRefresh(supabase: Awaited<ReturnType<typeof createClient>>, company: string | null, ok: boolean, summary: string) {
  if (!company) return;
  await supabase.rpc("platform_record_demo_refresh", { p_company: company, p_ok: ok, p_summary: summary });
}

export async function updateLead(formData: FormData) {
  const id = uuid.parse(formData.get("id"));
  const status = String(formData.get("status") ?? "");
  const owner = String(formData.get("owner") ?? "");
  const followUp = String(formData.get("follow_up_on") ?? "");
  const spam = formData.get("spam") === "on";
  const onboarding = String(formData.get("onboarding_stage") ?? "");
  const path = `/admin/leads/${id}`;
  if (!isLeadStatus(status)) back(path, "Choose a status.");
  if (!isOnboardingStage(onboarding)) back(path, "Choose the onboarding progress.");
  if (owner && !uuid.safeParse(owner).success) back(path, "Choose an owner.");
  if (followUp && !isOperationalDate(followUp)) back(path, "Enter the follow-up date as a day, for example Nov 14, 2026.");
  // The demo date (20261120020100): only sent when it changed, so the form keeps working before that update.
  const demoOn = String(formData.get("demo_on") ?? "");
  const demoWas = String(formData.get("demo_on_was") ?? "");
  const demoChanged = formData.has("demo_on") && demoOn !== demoWas;
  if (demoChanged && demoOn && !isOperationalDate(demoOn)) back(path, "Enter the demo date as a day, for example Nov 14, 2026.");
  const supabase = await db();
  const { error } = await supabase.rpc("platform_lead_update", {
    p_id: id, p_status: status, p_owner: owner || null, p_follow_up: followUp || null, p_spam: spam, p_onboarding: onboarding,
  });
  if (error) back(path, dbErrorMessage(error));
  if (demoChanged) {
    const demo = await supabase.rpc("platform_lead_demo_date", { p_id: id, p_demo_on: demoOn || null });
    if (demo.error) back(path, `The other changes were saved; the demo date was not: ${dbErrorMessage(demo.error)}`);
  }
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
  const form = readImportForm(formData);
  if (!form.ok) return back(path, form.error);
  const supabase = await db();
  const { data, error } = await supabase.rpc("platform_import_stage", { p_company: company, p_entity: form.entity, p_file_name: form.fileName, p_mapping: form.mapping, p_rows: form.rows });
  if (error) back(path, dbErrorMessage(error));
  // Staged from a file on the company's onboarding checklist: note it in the task's history (20261120001000).
  const document = uuid.safeParse(formData.get("document"));
  if (document.success) {
    const note = await supabase.rpc("platform_onboarding_import_staged", { p_document: document.data, p_batch: data as string });
    if (note.error) console.warn("Onboarding import note not recorded", { code: note.error.code });
  }
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
  // The platform revert predates job-site and trailer imports (20261120008300) and only knows the first four kinds; those
  // batches are undone from the company's own Import page (records made inactive), never half-reverted here.
  const kind = (await supabase.rpc("platform_import_batch", { p_batch: batch })).data as { entity?: string } | null;
  if (kind?.entity === "sites" || kind?.entity === "trailers") back(path, "Undo job-site and trailer imports from the company's Settings, Import page (records are made inactive).");
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

/**
 * Create the standing "Prairie Lantern Freight" prospect demo tenant (separate
 * from the presenter demo; never replaced by "Start the demo"), fill it with
 * fictional data as its owner, and open it. Creates no login for anyone.
 */
export async function createProspectDemo() {
  const supabase = await db();
  const { error } = await supabase.rpc("platform_prospect_demo_create", {
    p_name: PRAIRIE_LANTERN.name, p_city: PRAIRIE_LANTERN.city, p_state: PRAIRIE_LANTERN.state, p_timezone: PRAIRIE_LANTERN.timeZone,
  });
  if (error) back("/admin/demo", error.code === "PGRST202" ? "Prospect demos are not available on this database yet. Nothing was changed." : dbErrorMessage(error));
  try {
    await seedPrairieLantern(supabase);
  } catch (e) {
    back("/admin/demo", e instanceof Error ? e.message : "The demo data could not be created.");
  }
  (await cookies()).delete(PREVIEW_COOKIE);
  revalidatePath("/", "layout");
  redirect("/command-center?demo=prospect");
}

/**
 * Create the standing "Cobalt Plains Freight" demo (MK3: a general-freight carrier beside the aggregate demos), fill it
 * with fictional freight data as its owner, and open it. Creates no login for anyone.
 */
export async function createFreightDemo() {
  const supabase = await db();
  const { error } = await supabase.rpc("platform_prospect_demo_create", {
    p_name: FREIGHT_DEMO.name, p_city: FREIGHT_DEMO.city, p_state: FREIGHT_DEMO.state, p_timezone: FREIGHT_DEMO.timeZone,
  });
  if (error) back("/admin/demo", error.code === "PGRST202" ? "Prospect demos are not available on this database yet. Nothing was changed." : dbErrorMessage(error));
  try {
    await seedFreightDemo(supabase);
  } catch (e) {
    back("/admin/demo", e instanceof Error ? e.message : "The demo data could not be created.");
  }
  (await cookies()).delete(PREVIEW_COOKIE);
  revalidatePath("/", "layout");
  redirect("/command-center?demo=prospect");
}

/**
 * Refresh a prospect demo's sample data (additive; see prairie-lantern-refresh.ts). Works inside the demo as
 * its owner: the platform admin must still be an active member (they are when they created it).
 */
export async function refreshProspectDemo(formData: FormData) {
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) back("/admin/demo", "Invalid demo company.");
  const supabase = await db();
  const { data: company } = await supabase.from("companies").select("name, demo_kind").eq("id", id.data).maybeSingle();
  if (!company || (company as { demo_kind: string }).demo_kind !== "prospect") back("/admin/demo", "Only a prospect demo you belong to can be refreshed.");
  const name = (company as { name: string }).name;
  if (name !== PRAIRIE_LANTERN.name && name !== FREIGHT_DEMO.name) back("/admin/demo", `Refresh is available for the ${PRAIRIE_LANTERN.name} and ${FREIGHT_DEMO.name} demos.`);
  const sw = await supabase.rpc("switch_company", { p_company_id: id.data });
  if (sw.error) back("/admin/demo", "You are no longer a member of this demo, so it cannot be refreshed from here.");
  let r: { added: number; loads: number; notes?: string[] } = { added: 0, loads: 0 };
  try {
    r = await withDemoRefreshLock(supabase, () => (name === FREIGHT_DEMO.name ? refreshFreightDemo(supabase) : refreshPrairieLantern(supabase)));
  } catch (e) {
    const message = e instanceof Error ? e.message : "The demo could not be refreshed.";
    await recordRefresh(supabase, id.data ?? null, false, message);
    back("/admin/demo", message);
  }
  await recordRefresh(supabase, id.data ?? null, true, refreshSummary(r));
  revalidatePath("/", "layout");
  redirect(`/admin/demo?saved=refreshed&loads=${r.loads}&added=${r.added}${r.notes?.includes(PORTAL_NOT_OPENED) ? "&portal=closed" : ""}`);
}

/**
 * Refresh the presenter demo (Northfield Aggregates) the same way as a prospect demo: additive, inside the demo as its
 * owner (northfield-refresh.ts). Existing presenter demos get new samples without a Reset.
 */
export async function refreshPresenterDemo() {
  const supabase = await db();
  const { error } = await supabase.rpc("platform_demo_enter");
  if (error) back("/admin/demo", dbErrorMessage(error));
  // The presenter demo the platform admin is now in (platform_demo_enter switched to it).
  const { data: me } = await supabase.rpc("my_access");
  const company = (me as { company_id?: string | null } | null)?.company_id ?? null;
  let r: { added: number; loads: number; notes?: string[] } = { added: 0, loads: 0 };
  try {
    r = await withDemoRefreshLock(supabase, () => refreshNorthfield(supabase));
  } catch (e) {
    const message = e instanceof Error ? e.message : "The demo could not be refreshed.";
    await recordRefresh(supabase, company, false, message);
    back("/admin/demo", message);
  }
  await recordRefresh(supabase, company, true, refreshSummary(r));
  revalidatePath("/", "layout");
  redirect(`/admin/demo?saved=refreshed&loads=${r.loads}&added=${r.added}${r.notes?.includes(PORTAL_NOT_OPENED) ? "&portal=closed" : ""}`);
}

/** Retire a prospect demo (kept, inactive) so a fresh one can be created. */
export async function retireProspectDemo(formData: FormData) {
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) back("/admin/demo", "Invalid demo company.");
  if (formData.get("confirm") !== "on") back("/admin/demo", "Tick the box to confirm retiring the demo.");
  const supabase = await db();
  const { error } = await supabase.rpc("platform_prospect_demo_retire", { p_company: id.data });
  if (error) back("/admin/demo", error.code === "PGRST202" ? "Retiring a demo is not available on this database yet. Nothing was changed." : dbErrorMessage(error));
  revalidatePath("/", "layout");
  redirect("/admin/demo?saved=retired");
}

export async function enterDemo() {
  const supabase = await db();
  const { error } = await supabase.rpc("platform_demo_enter");
  if (error) back("/admin/demo", dbErrorMessage(error));
  revalidatePath("/", "layout");
  redirect("/command-center");
}

/**
 * Show a demo company as Essential, Growth or Professional (20261120000300): bases follow the plan and the demo's
 * fictional records are spread across them once. Demo companies only; audited in the platform log.
 */
export async function setDemoPlan(formData: FormData) {
  const id = uuid.safeParse(formData.get("id"));
  const plan = String(formData.get("plan") ?? "");
  if (!id.success || !["essential", "growth", "professional"].includes(plan)) back("/admin/demo", "Choose a demo and a plan.");
  const supabase = await db();
  const { error } = await supabase.rpc("platform_demo_set_plan", { p_company: id.data!, p_plan: plan });
  if (error) back("/admin/demo", error.code === "PGRST202" ? "Choosing a demo plan is not available on this database yet. Nothing was changed." : error.message);
  revalidatePath("/", "layout");
  redirect(`/admin/demo?saved=plan&plan=${plan}`);
}
