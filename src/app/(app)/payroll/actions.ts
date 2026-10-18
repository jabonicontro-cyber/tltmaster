"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { validateFormula } from "@/lib/payroll/formula";
import { isOperationalDate } from "@/lib/dates";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import { calculatePeriod } from "@/server/payroll/calculate";
import { createClient } from "@/server/supabase/server";

// Payroll actions (owner-only: payroll.manage, checked here and again in every database function). Results come back
// as ?error= / ?saved= so every form works without JavaScript.

const uuid = z.uuid();
const back = (path: string, error: string): never => redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(error.slice(0, 300))}`);
const done = (path: string, saved: string): never => redirect(`${path}${path.includes("?") ? "&" : "?"}saved=${saved}`);

async function db(path: string) {
  try {
    await assertPermission("payroll.manage");
  } catch {
    back(path, "Only people with payroll access can do this.");
  }
  return createClient();
}

export async function savePayrollSettings(formData: FormData) {
  const supabase = await db("/payroll");
  const length = String(formData.get("period_length") ?? "");
  const anchor = String(formData.get("period_anchor") ?? "");
  if (anchor && !isOperationalDate(anchor)) back("/payroll", "Enter a valid first day for the pay period.");
  const { error } = await supabase.rpc("payroll_settings_save", {
    p: { enabled: formData.get("enabled") === "on", period_length: ["weekly", "biweekly", "semimonthly", "monthly"].includes(length) ? length : "", period_anchor: anchor },
  });
  if (error) back("/payroll", dbErrorMessage(error));
  revalidatePath("/payroll");
  done("/payroll", "settings");
}

export async function draftRule(formData: FormData) {
  const supabase = await db("/payroll/rules");
  const formula = String(formData.get("formula") ?? "").trim();
  const check = validateFormula(formula);
  if (!check.ok) back("/payroll/rules", check.error ?? "Check the formula.");
  const rate = String(formData.get("rate") ?? "").trim();
  if (rate && !/^\d+(\.\d{1,6})?$/.test(rate)) back("/payroll/rules", "Enter the rate as a number (up to 6 decimals), or leave it empty.");
  if (check.variables.includes("rate") && !rate) back("/payroll/rules", "The formula uses rate: enter the rate.");
  const from = String(formData.get("effective_from") ?? "");
  const to = String(formData.get("effective_to") ?? "");
  if (!isOperationalDate(from) || (to && !isOperationalDate(to))) back("/payroll/rules", "Enter valid dates.");
  const scope: Record<string, string> = {};
  for (const k of ["driver_id", "customer_id"] as const) {
    const v = String(formData.get(k) ?? "");
    if (v && uuid.safeParse(v).success) scope[k] = v;
  }
  const ruleId = String(formData.get("rule_id") ?? "");
  const { error } = await supabase.rpc("payroll_rule_draft", {
    p: {
      rule_id: uuid.safeParse(ruleId).success ? ruleId : "",
      name: String(formData.get("name") ?? ""),
      formula, rate, unit_code: String(formData.get("unit_code") ?? ""), scope,
      effective_from: from, effective_to: to, evidence_note: String(formData.get("evidence_note") ?? "").slice(0, 2000),
    },
  });
  if (error) back("/payroll/rules", dbErrorMessage(error));
  revalidatePath("/payroll/rules");
  done("/payroll/rules", "drafted");
}

export async function activateRule(formData: FormData) {
  const supabase = await db("/payroll/rules");
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) back("/payroll/rules", "Invalid rule.");
  if (formData.get("confirm") !== "on") back("/payroll/rules", "Tick the box to confirm this rule matches your agreed pay terms.");
  const { error } = await supabase.rpc("payroll_rule_activate", { p_version: id.data, p_note: String(formData.get("note") ?? "") });
  if (error) back("/payroll/rules", dbErrorMessage(error));
  revalidatePath("/payroll", "layout");
  done("/payroll/rules", "activated");
}

export async function endRule(formData: FormData) {
  const supabase = await db("/payroll/rules");
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) back("/payroll/rules", "Invalid rule.");
  const last = String(formData.get("last_day") ?? "");
  if (last && !isOperationalDate(last)) back("/payroll/rules", "Enter a valid last day.");
  const { error } = await supabase.rpc("payroll_rule_end", { p_version: id.data, p_last_day: last || null });
  if (error) back("/payroll/rules", dbErrorMessage(error));
  revalidatePath("/payroll", "layout");
  done("/payroll/rules", "ended");
}

export async function createPeriod(formData: FormData) {
  const supabase = await db("/payroll");
  const from = String(formData.get("starts_on") ?? "");
  const to = String(formData.get("ends_on") ?? "");
  if (!isOperationalDate(from) || !isOperationalDate(to)) back("/payroll", "Enter the first and last day of the period.");
  const { data, error } = await supabase.rpc("payroll_period_create", { p_starts: from, p_ends: to });
  if (error) back("/payroll", dbErrorMessage(error));
  revalidatePath("/payroll");
  redirect(`/payroll/periods/${data as string}?saved=created`);
}

const periodPath = (id: string) => `/payroll/periods/${id}`;

export async function calculate(formData: FormData) {
  const id = uuid.safeParse(formData.get("period"));
  if (!id.success) back("/payroll", "Invalid period.");
  await db(periodPath(id.data!));
  let added = 0;
  try {
    const r = await calculatePeriod(id.data!, true);
    added = r.recorded?.added ?? 0;
  } catch (e) {
    back(periodPath(id.data!), e instanceof Error ? e.message : "The period could not be calculated.");
  }
  revalidatePath(periodPath(id.data!));
  redirect(`${periodPath(id.data!)}?saved=calculated&n=${added}`);
}

export async function setEntry(formData: FormData) {
  const period = String(formData.get("period") ?? "");
  const supabase = await db(periodPath(period));
  const id = uuid.safeParse(formData.get("id"));
  const status = String(formData.get("status") ?? "");
  if (!id.success || !["reversed", "excluded"].includes(status)) back(periodPath(period), "Invalid change.");
  const { error } = await supabase.rpc("payroll_entry_set", { p_entry: id.data, p_status: status, p_note: String(formData.get("note") ?? "") });
  if (error) back(periodPath(period), dbErrorMessage(error));
  revalidatePath(periodPath(period));
  done(periodPath(period), status);
}

export async function addAdjustment(formData: FormData) {
  const period = String(formData.get("period") ?? "");
  const supabase = await db(periodPath(period));
  const driver = uuid.safeParse(formData.get("driver"));
  const amount = String(formData.get("amount") ?? "").trim();
  if (!driver.success) back(periodPath(period), "Choose the driver.");
  if (!/^-?\d+(\.\d{1,2})?$/.test(amount) || Number(amount) === 0) back(periodPath(period), "Enter the amount in dollars (a minus sign for a deduction).");
  const [whole, frac = ""] = amount.replace("-", "").split(".");
  const cents = (Number(whole) * 100 + Number(frac.padEnd(2, "0"))) * (amount.startsWith("-") ? -1 : 1);
  const entry = String(formData.get("entry") ?? "");
  const { error } = await supabase.rpc("payroll_adjust", { p_period: period, p_driver: driver.data, p_amount_cents: cents, p_reason: String(formData.get("reason") ?? ""), p_entry: uuid.safeParse(entry).success ? entry : null });
  if (error) back(periodPath(period), dbErrorMessage(error));
  revalidatePath(periodPath(period));
  done(periodPath(period), "adjusted");
}

export async function approvePeriod(formData: FormData) {
  const period = String(formData.get("period") ?? "");
  const supabase = await db(periodPath(period));
  if (formData.get("confirm") !== "on") back(periodPath(period), "Tick the box to confirm the totals before approving.");
  const { error } = await supabase.rpc("payroll_period_approve", { p_period: period });
  if (error) back(periodPath(period), dbErrorMessage(error));
  revalidatePath("/payroll", "layout");
  done(periodPath(period), "approved");
}

export async function recordExportOutcome(formData: FormData) {
  const period = String(formData.get("period") ?? "");
  const supabase = await db(periodPath(period));
  const id = uuid.safeParse(formData.get("id"));
  const status = String(formData.get("status") ?? "");
  if (!id.success || !["accepted", "rejected", "failed"].includes(status)) back(periodPath(period), "Choose what happened to the export.");
  const { error } = await supabase.rpc("payroll_export_outcome", { p_export: id.data, p_status: status, p_reference: String(formData.get("reference") ?? ""), p_note: String(formData.get("note") ?? "") });
  if (error) back(periodPath(period), dbErrorMessage(error));
  revalidatePath("/payroll", "layout");
  done(periodPath(period), "outcome");
}
