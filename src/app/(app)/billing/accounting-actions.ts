"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { uuid } from "@/lib/schemas/common";
import { revokeTokens } from "@/server/accounting/qbo";
import { sendHandoffOrder } from "@/server/accounting/send";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Billing businesses (cost centers) and QuickBooks Online (master plan B82, B89). Every change needs billing.manage and
// is checked again by the database function it calls. Sending is always a person's action, one order or one batch.

const refresh = () => {
  revalidatePath("/billing", "layout");
};

const entityInput = z.object({
  id: uuid.nullable().optional(),
  name: z.string().trim().min(1, "Give the business a name.").max(120),
  legal_name: z.string().trim().max(200).default(""),
  address_line1: z.string().trim().max(200).default(""),
  address_line2: z.string().trim().max(200).default(""),
  city: z.string().trim().max(100).default(""),
  region: z.string().trim().max(50).default(""),
  postal_code: z.string().trim().max(20).default(""),
  phone: z.string().trim().max(40).default(""),
  email: z.union([z.literal(""), z.email("Enter a valid email.")]).default(""),
  invoice_prefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{0,6}$/, "Up to 6 letters, digits or dashes.").default(""),
  is_default: z.boolean().default(false),
  active: z.boolean().default(true),
});

export async function saveBillingEntity(input: z.input<typeof entityInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("billing.manage");
    const p = entityInput.safeParse(input);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "Check the business details.");
    const { id, ...rest } = p.data;
    const supabase = await createClient();
    const { error } = await supabase.rpc("billing_entity_save", { p_id: id ?? null, p: rest });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Business saved.");
  });
}

const KINDS = ["material", "hauling", "service", "surcharge", "discount", "other"] as const;

export async function saveBillingRules(input: Partial<Record<(typeof KINDS)[number], string>>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("billing.manage");
    const p = z.object(Object.fromEntries(KINDS.map((k) => [k, z.union([z.literal(""), uuid]).optional()]))).safeParse(input);
    if (!p.success) return fail("Choose a business for each charge type.");
    const supabase = await createClient();
    const { error } = await supabase.rpc("billing_entity_rules_save", { p: p.data });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Billing split saved.");
  });
}

export async function setQuickBooksItem(input: { connectionId: string; itemId: string; itemName: string }): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("billing.manage");
    const p = z.object({ connectionId: uuid, itemId: z.string().min(1).max(40), itemName: z.string().max(200) }).safeParse(input);
    if (!p.success) return fail("Choose a product or service.");
    const supabase = await createClient();
    const { error } = await supabase.rpc("accounting_set_item", { p_connection: p.data.connectionId, p_item_id: p.data.itemId, p_item_name: p.data.itemName });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "Invoice lines will use this product or service.");
  });
}

export async function disconnectQuickBooks(input: { connectionId: string }): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("billing.manage");
    const p = z.object({ connectionId: uuid }).safeParse(input);
    if (!p.success) return fail("Invalid connection.");
    const supabase = await createClient();
    const { data } = await supabase.from("accounting_connections").select("id").eq("id", p.data.connectionId).maybeSingle();
    if (!data) return fail("Connection not found.");
    await revokeTokens(p.data.connectionId);
    const { error } = await supabase.rpc("accounting_disconnect", { p_connection: p.data.connectionId });
    if (error) return fail(dbErrorMessage(error));
    refresh();
    return ok(undefined, "QuickBooks disconnected. Nothing in QuickBooks was changed.");
  });
}

export async function sendToQuickBooks(input: { handoffOrderIds: string[] }): Promise<ActionResult> {
  return guard(async () => {
    const access = await assertPermission("billing.manage");
    const p = z.object({ handoffOrderIds: z.array(uuid).min(1).max(200) }).safeParse(input);
    if (!p.success) return fail("Choose what to send.");
    const results = [];
    // One at a time: QuickBooks limits request rates, and each order must finish (or fail) on its own.
    for (const id of p.data.handoffOrderIds) results.push(await sendHandoffOrder(id, { isDemo: Boolean(access.isDemo) }));
    refresh();
    const failed = results.filter((r) => !r.ok);
    if (p.data.handoffOrderIds.length === 1) return results[0].ok ? ok(undefined, results[0].message) : fail(results[0].message);
    return failed.length ? fail(`${results.length - failed.length} sent, ${failed.length} not sent: ${failed.map((f) => f.message).join(" ")}`.slice(0, 900)) : ok(undefined, `${results.length} orders sent to QuickBooks.`);
  });
}
