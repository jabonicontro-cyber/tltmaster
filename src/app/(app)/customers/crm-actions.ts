"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ACTIVITY_KINDS, STAGES, dollarsToCents, parseTags } from "@/lib/crm/labels";
import { isOperationalDate } from "@/lib/dates";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Company CRM actions (20261119000100): customers.edit, checked here and by RLS. Results come back as ?saved= / ?error=
// so every form works without JavaScript. Nothing is sent to anyone from here: an "email" activity is a record.

const uuid = z.uuid();
const go = (path: string, key: string, value: string): never => {
  const [base, hash] = path.split("#");
  redirect(`${base}${base.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value.slice(0, 300))}${hash ? `#${hash}` : ""}`);
};
const text = (f: FormData, k: string, max: number) => String(f.get(k) ?? "").trim().slice(0, max);
const optionalDate = (f: FormData, k: string): string | null | false => {
  const v = text(f, k, 10);
  if (!v) return null;
  return isOperationalDate(v) ? v : false;
};
const optionalUser = (f: FormData, k: string) => {
  const v = text(f, k, 40);
  return uuid.safeParse(v).success ? v : null;
};

async function db(back: string) {
  try {
    await assertPermission("customers.edit");
  } catch {
    go(back, "error", "You do not have permission to change customer records.");
  }
  return createClient();
}

function backTo(f: FormData, customer: string, section: string) {
  const b = text(f, "back", 200);
  return b.startsWith("/customers") ? b : `/customers/${customer}#${section}`;
}

export async function saveRelationship(formData: FormData) {
  const id = uuid.safeParse(formData.get("customer"));
  if (!id.success) redirect("/customers");
  const back = `/customers/${id.data}#crm`;
  const supabase = await db(back);
  const relationship = text(formData, "relationship", 20);
  if (!["prospect", "customer"].includes(relationship)) go(back, "error", "Choose prospect or customer.");
  const { error } = await supabase.from("customers").update({ relationship, account_owner_id: optionalUser(formData, "account_owner_id"), tags: parseTags(text(formData, "tags", 1000)) }).eq("id", id.data);
  if (error) go(back, "error", dbErrorMessage(error));
  revalidatePath(`/customers/${id.data}`);
  go(back, "crm", "1");
}

export async function logActivity(formData: FormData) {
  const id = uuid.safeParse(formData.get("customer"));
  if (!id.success) redirect("/customers");
  const back = backTo(formData, id.data, "activity");
  const supabase = await db(back);
  const kind = text(formData, "kind", 20);
  if (!(ACTIVITY_KINDS as readonly string[]).includes(kind)) go(back, "error", "Choose what kind of contact it was.");
  const subject = text(formData, "subject", 200);
  if (!subject) go(back, "error", "Write a short summary.");
  const when = text(formData, "occurred_on", 10);
  if (when && !isOperationalDate(when)) go(back, "error", "Enter a valid date.");
  const contact = optionalUser(formData, "contact_id");
  const { error } = await supabase.from("customer_activities").insert({
    customer_id: id.data, kind, subject, body: text(formData, "body", 4000), contact_id: contact,
    ...(when ? { occurred_at: `${when}T12:00:00Z` } : {}),
  });
  if (error) go(back, "error", dbErrorMessage(error));
  revalidatePath(`/customers/${id.data}`);
  go(back, "activity", "1");
}

export async function addTask(formData: FormData) {
  const id = uuid.safeParse(formData.get("customer"));
  if (!id.success) redirect("/customers");
  const back = backTo(formData, id.data, "tasks");
  const supabase = await db(back);
  const title = text(formData, "title", 200);
  if (!title) go(back, "error", "Write what needs to be done.");
  const due = optionalDate(formData, "due_on");
  if (due === false) go(back, "error", "Enter a valid due date.");
  const opp = optionalUser(formData, "opportunity_id");
  const { error } = await supabase.from("customer_tasks").insert({ customer_id: id.data, title, notes: text(formData, "notes", 2000), due_on: due, assigned_to: optionalUser(formData, "assigned_to"), opportunity_id: opp });
  if (error) go(back, "error", dbErrorMessage(error));
  revalidatePath(`/customers/${id.data}`);
  revalidatePath("/customers/pipeline");
  go(back, "task", "1");
}

export async function setTaskStatus(formData: FormData) {
  const id = uuid.safeParse(formData.get("task"));
  const customer = uuid.safeParse(formData.get("customer"));
  if (!id.success || !customer.success) redirect("/customers");
  const back = backTo(formData, customer.data, "tasks");
  const supabase = await db(back);
  const status = text(formData, "status", 10);
  if (!["open", "done", "canceled"].includes(status)) go(back, "error", "Invalid change.");
  const { error } = await supabase.from("customer_tasks").update({ status }).eq("id", id.data);
  if (error) go(back, "error", dbErrorMessage(error));
  revalidatePath(`/customers/${customer.data}`);
  revalidatePath("/customers/pipeline");
  go(back, "task", "1");
}

export async function saveOpportunity(formData: FormData) {
  const customer = uuid.safeParse(formData.get("customer"));
  if (!customer.success) redirect("/customers");
  const back = backTo(formData, customer.data, "opportunities");
  const supabase = await db(back);
  const oppId = uuid.safeParse(formData.get("opportunity"));
  const stage = text(formData, "stage", 20) || "new";
  if (!(STAGES as readonly string[]).includes(stage)) go(back, "error", "Choose a stage.");
  const valueText = text(formData, "value", 20);
  const value = valueText ? dollarsToCents(valueText) : null;
  if (valueText && value === null) go(back, "error", "Enter the value in dollars, e.g. 12500.");
  const probText = text(formData, "probability", 3);
  const probability = probText ? Number(probText) : null;
  if (probability !== null && !(Number.isInteger(probability) && probability >= 0 && probability <= 100)) go(back, "error", "Enter a probability from 0 to 100, or leave it empty.");
  const follow = optionalDate(formData, "follow_up_on");
  const close = optionalDate(formData, "expected_close_on");
  if (follow === false || close === false) go(back, "error", "Enter valid dates.");
  const lostReason = text(formData, "lost_reason", 500);
  if (stage === "lost" && !lostReason) go(back, "error", "Say why it was lost — it helps the next quote.");
  const row = {
    stage, value_cents: value, probability, follow_up_on: follow, expected_close_on: close, lost_reason: lostReason,
    next_action: text(formData, "next_action", 300), owner_id: optionalUser(formData, "owner_id"),
  };
  const { error } = oppId.success
    ? await supabase.from("crm_opportunities").update(row).eq("id", oppId.data)
    : await supabase.from("crm_opportunities").insert({ ...row, customer_id: customer.data, title: text(formData, "title", 200) });
  if (error) go(back, "error", dbErrorMessage(error));
  revalidatePath(`/customers/${customer.data}`);
  revalidatePath("/customers/pipeline");
  go(back, "opportunity", "1");
}
