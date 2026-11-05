"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OUTREACH_STATUSES, SEGMENTS, readCarrierRows, type ProspectInput, type ReadResult } from "@/lib/platform/outreach";
import { MAX_ROWS, searchCensus } from "@/server/fmcsa";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/server/errors";
import { assertPlatformAdmin } from "@/server/platform";
import { createClient } from "@/server/supabase/server";

// Outreach (master plan B139). Platform team only: checked here and again in every database function. Nothing here
// sends an email; the person sends it from their own mailbox and records that they did.

async function db() {
  await assertPlatformAdmin();
  return createClient();
}

const prospect = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  company_name: z.string().trim().min(1).max(160),
  contact_name: z.string().trim().max(120).default(""),
  phone: z.string().trim().max(40).default(""),
  city: z.string().trim().max(80).default(""),
  state: z.string().trim().toUpperCase().max(2).default(""),
  dot_number: z.string().trim().regex(/^\d{0,10}$/).default(""),
  power_units: z.number().int().min(0).max(100000).nullable().default(null),
  drivers: z.number().int().min(0).max(100000).nullable().default(null),
  segment: z.enum(SEGMENTS).default("other"),
});

export interface ImportSummary { added: number; updated: number; suppressed: number; invalid: number }

/** Up to 1000 rows per call (the page sends a large list in parts). */
export async function importProspects(rows: ProspectInput[], source: "fmcsa_census" | "csv"): Promise<ActionResult<ImportSummary>> {
  const supabase = await db();
  if (!Array.isArray(rows) || rows.length === 0) return fail("Nothing to add.");
  if (rows.length > 1000) return fail("Send at most 1000 rows at a time.");
  if (source !== "fmcsa_census" && source !== "csv") return fail("Unknown source.");
  const clean = rows.map((r) => prospect.safeParse(r)).filter((r) => r.success).map((r) => r.data);
  const invalid = rows.length - clean.length;
  const { data, error } = await supabase.rpc("platform_outreach_import", { p_rows: clean, p_source: source });
  if (error) return fail(dbErrorMessage(error));
  const r = data as ImportSummary;
  revalidatePath("/admin/outreach");
  return ok({ ...r, invalid: r.invalid + invalid });
}

export async function addProspect(input: unknown): Promise<ActionResult<{ id: string | null }>> {
  const supabase = await db();
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const units = Number(raw.power_units);
  const parsed = prospect.safeParse({ ...raw, power_units: raw.power_units === "" || raw.power_units == null || Number.isNaN(units) ? null : units, drivers: null });
  if (!parsed.success) return fail("Enter a company name and a valid email address.");
  const { data, error } = await supabase.rpc("platform_outreach_import", { p_rows: [parsed.data], p_source: "manual" });
  if (error) return fail(dbErrorMessage(error));
  const r = data as ImportSummary;
  if (r.suppressed) return fail("That address asked not to be contacted, so it was not added.");
  revalidatePath("/admin/outreach");
  const { data: found } = await supabase.rpc("platform_outreach_list", { p_search: parsed.data.email, p_status: "", p_state: "", p_segment: "", p_min_units: null, p_max_units: null, p_limit: 1, p_offset: 0 });
  const id = ((found as { rows?: Array<{ id: string }> } | null)?.rows ?? [])[0]?.id ?? null;
  return ok({ id }, r.added ? "Prospect added." : "That address was already on the list; empty details were filled in.");
}

const id = z.uuid();

export async function recordOutreach(prospectId: string, action: "prepared" | "marked_sent"): Promise<ActionResult> {
  const supabase = await db();
  if (!id.safeParse(prospectId).success || !["prepared", "marked_sent"].includes(action)) return fail("Unknown prospect.");
  const { error } = await supabase.rpc("platform_outreach_record", { p_id: prospectId, p_action: action });
  if (error) return fail(dbErrorMessage(error));
  revalidatePath("/admin/outreach");
  revalidatePath(`/admin/outreach/${prospectId}`);
  return ok(undefined, action === "marked_sent" ? "Marked as sent." : undefined);
}

export async function updateProspect(prospectId: string, status: string | null, notes: string | null): Promise<ActionResult> {
  const supabase = await db();
  if (!id.safeParse(prospectId).success) return fail("Unknown prospect.");
  if (status !== null && !(OUTREACH_STATUSES as readonly string[]).includes(status)) return fail("Unknown status.");
  const { error } = await supabase.rpc("platform_outreach_update", { p_id: prospectId, p_status: status, p_notes: notes === null ? null : notes.slice(0, 2000) });
  if (error) return fail(dbErrorMessage(error));
  revalidatePath("/admin/outreach");
  revalidatePath(`/admin/outreach/${prospectId}`);
  return ok(undefined, status === "do_not_contact" ? "They won't be contacted again." : "Saved.");
}

export async function convertProspect(prospectId: string): Promise<ActionResult<{ leadId: string }>> {
  const supabase = await db();
  if (!id.safeParse(prospectId).success) return fail("Unknown prospect.");
  const { data, error } = await supabase.rpc("platform_outreach_convert", { p_id: prospectId });
  if (error) return fail(dbErrorMessage(error));
  revalidatePath("/admin/outreach");
  revalidatePath("/admin/leads");
  return ok({ leadId: String(data) }, "Added to Leads.");
}

const settings = z.object({
  sender_name: z.string().trim().max(120),
  postal_address: z.string().trim().max(300),
  subject: z.string().trim().max(200),
  body: z.string().max(8000),
  faq: z.array(z.object({ q: z.string().trim().max(200), a: z.string().trim().max(1000) })).max(12),
});

export async function saveOutreachSettings(input: unknown): Promise<ActionResult> {
  const supabase = await db();
  const parsed = settings.safeParse(input);
  if (!parsed.success) return fail("Check the fields: a value is too long.");
  const { error } = await supabase.rpc("platform_outreach_settings_save", { p: { ...parsed.data, faq: parsed.data.faq.filter((f) => f.q && f.a), reply_to: "" } });
  if (error) return fail(dbErrorMessage(error));
  revalidatePath("/admin/outreach");
  return ok(undefined, "Email saved.");
}

const search = z.object({
  states: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).min(1).max(10),
  minUnits: z.number().int().min(0).max(100000).nullable(),
  maxUnits: z.number().int().min(0).max(100000).nullable(),
  segments: z.array(z.enum(SEGMENTS)).max(3),
  activeOnly: z.boolean(),
});

/**
 * Search the public FMCSA registry (free, no key; src/server/fmcsa.ts) and return the matching carriers with an email,
 * ready to add. Nothing is saved here: the page shows what was found and the person adds it.
 */
export async function searchRegistry(input: unknown): Promise<ActionResult<ReadResult & { truncated: boolean; max: number }>> {
  await assertPlatformAdmin();
  const parsed = search.safeParse(input);
  if (!parsed.success) return fail("Choose one to ten states (two letters, like TX).");
  const r = await searchCensus(parsed.data);
  if (!r.ok) return fail(r.error);
  const read = readCarrierRows(r.table, { ...parsed.data, states: parsed.data.states });
  return ok({ ...read, rows: read.rows.slice(0, 5000), truncated: r.truncated || read.rows.length > 5000, max: MAX_ROWS });
}
