"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { crossCheck, normalizeRef, type CrossCheck, type TicketReading } from "@/lib/ai/ticket-reading";
import { isIsoDate, todayIn } from "@/lib/dates";
import { quantityError } from "@/lib/tickets/rules";
import { aiConfig, runSettings } from "@/server/ai/config";
import { capabilityGate, provider, sessionLedger } from "@/server/ai/gates";
import { runCapability } from "@/server/ai/run";
import { ticketReadingRequest } from "@/server/ai/ticket-reading";
import { AiError, publicMessage } from "@/server/ai/types";
import { assertPermission } from "@/server/auth";
import { businessToday } from "@/server/data/settings";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

const optionalUuid = z.preprocess((v) => (v === "" || v === undefined ? null : v), z.uuid().nullable());

const ticketInput = z
  .object({
    loadId: z.uuid("Invalid load."),
    orderLineId: z.uuid("Choose the order line that was delivered."),
    deliveredDate: z.string().refine(isIsoDate, "Enter a valid date."),
    deliveredTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a valid time."),
    quantity: z.string().trim(),
    unitCode: z.string().min(1, "Choose the unit of the delivered quantity."),
    externalReference: z.string().trim().max(60).default(""),
    notes: z.string().trim().max(2000).default(""),
    truckId: z.uuid("Choose the truck."),
    trailerId: optionalUuid,
    driverId: z.uuid("Choose the driver."),
    /** Generated when the form opens: a repeated submit returns the same ticket. */
    submissionKey: optionalUuid,
    confirmDuplicate: z.boolean().default(false),
  })
  .superRefine((t, ctx) => {
    const q = quantityError(t.quantity, t.unitCode);
    if (q) ctx.addIssue({ code: "custom", message: q, path: ["quantity"] });
  });

export type TicketInput = z.input<typeof ticketInput>;

function toPayload(t: z.output<typeof ticketInput>) {
  return {
    load_id: t.loadId,
    order_line_id: t.orderLineId,
    delivered_date: t.deliveredDate,
    delivered_time: t.deliveredTime,
    quantity: t.quantity,
    unit_code: t.unitCode,
    external_reference: t.externalReference,
    notes: t.notes,
    truck_id: t.truckId,
    trailer_id: t.trailerId,
    driver_id: t.driverId,
    submission_key: t.submissionKey,
    confirm_duplicate: t.confirmDuplicate,
  };
}

type DbError = { code?: string; message?: string };

/** A possible duplicate is not an error: the form asks the user to confirm. */
type Outcome<T> = ActionResult<T> | { ok: false; error: string; needsConfirmation: true };

function confirmOrFail(error: DbError) {
  if (error.code === "PT422") return { ok: false as const, error: error.message ?? "Possible duplicate.", needsConfirmation: true as const };
  return fail(dbErrorMessage(error));
}

function revalidateTickets(orderId?: string) {
  revalidatePath("/tickets", "layout");
  revalidatePath("/dispatch");
  revalidatePath("/command-center");
  if (orderId) revalidatePath(`/orders/${orderId}`);
}

export async function submitTicket(input: TicketInput & { orderId: string }): Promise<Outcome<{ ticketId: string; ticketNumber: string; status: string; created: boolean }>> {
  return guard(async () => {
    await assertPermission("tickets.edit");
    const parsed = ticketInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("submit_delivery_ticket", { p_payload: toPayload(parsed.data) });
    if (error) return confirmOrFail(error);
    const r = data as { ticket_id: string; ticket_number: string; status: string; created: boolean };
    revalidateTickets(input.orderId);
    return ok(
      { ticketId: r.ticket_id, ticketNumber: r.ticket_number, status: r.status, created: r.created },
      r.created ? `Ticket ${r.ticket_number} submitted.` : `Ticket ${r.ticket_number} was already submitted.`,
    );
  }) as Promise<Outcome<{ ticketId: string; ticketNumber: string; status: string; created: boolean }>>;
}

export async function correctTicket(ticketId: string, input: TicketInput & { orderId: string; reason: string }): Promise<Outcome<{ ticketId: string; revision: number }>> {
  return guard(async () => {
    await assertPermission("tickets.edit");
    if (!z.uuid().safeParse(ticketId).success) return fail("Invalid ticket.");
    const reason = input.reason.trim();
    if (!reason) return fail("Enter the reason for the correction.", { reason: "Enter the reason for the correction." });
    const parsed = ticketInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("correct_delivery_ticket", { p_ticket_id: ticketId, p_payload: toPayload(parsed.data), p_reason: reason });
    if (error) return confirmOrFail(error);
    const r = data as { ticket_id: string; revision: number };
    revalidateTickets(input.orderId);
    return ok({ ticketId: r.ticket_id, revision: r.revision }, `Correction saved as revision ${r.revision}.`);
  }) as Promise<Outcome<{ ticketId: string; revision: number }>>;
}

const reviewInput = z.object({
  ticketId: z.uuid("Invalid ticket."),
  action: z.enum(["accept", "flag", "void"]),
  note: z.string().trim().max(500).default(""),
  orderId: z.uuid(),
});

export async function reviewTicket(input: z.input<typeof reviewInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("tickets.review");
    const parsed = reviewInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { error } = await supabase.rpc("review_delivery_ticket", { p_ticket_id: parsed.data.ticketId, p_action: parsed.data.action, p_note: parsed.data.note });
    if (error) return fail(dbErrorMessage(error));
    revalidateTickets(parsed.data.orderId);
    return ok(undefined, parsed.data.action === "accept" ? "Ticket accepted." : parsed.data.action === "flag" ? "Ticket flagged for review." : "Ticket voided.");
  });
}

const bulkInput = z.object({ ticketIds: z.array(z.uuid()).min(1, "Choose at least one ticket.").max(50, "At most 50 tickets at a time.") });

export interface BulkAcceptResult {
  ticketId: string;
  ticketNumber: string | null;
  outcome: "accepted" | "skipped" | "failed";
  message: string;
}

/**
 * Accept several received tickets that nothing flagged. Each ticket is checked
 * again on the server (still "submitted", still no review reason) and accepted
 * on its own, so one failure never blocks or undoes the others. Repeating is
 * safe: an already accepted ticket is reported, not accepted twice.
 */
export async function acceptCleanTickets(input: z.input<typeof bulkInput>): Promise<ActionResult<{ results: BulkAcceptResult[] }>> {
  return guard(async () => {
    await assertPermission("tickets.review");
    const parsed = bulkInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const ids = [...new Set(parsed.data.ticketIds)];
    const { data, error } = await supabase.from("delivery_tickets").select("id, ticket_number, status, review_reasons, order_id").in("id", ids);
    if (error) return fail(dbErrorMessage(error));
    const rows = new Map(((data ?? []) as Array<{ id: string; ticket_number: string; status: string; review_reasons: string[]; order_id: string }>).map((r) => [r.id, r]));
    const results: BulkAcceptResult[] = [];
    const orders = new Set<string>();
    for (const id of ids) {
      const t = rows.get(id);
      if (!t) { results.push({ ticketId: id, ticketNumber: null, outcome: "skipped", message: "Not found." }); continue; }
      if (t.status === "accepted") { results.push({ ticketId: id, ticketNumber: t.ticket_number, outcome: "skipped", message: "Already accepted." }); continue; }
      if (t.status !== "submitted" || t.review_reasons.length > 0) {
        results.push({ ticketId: id, ticketNumber: t.ticket_number, outcome: "skipped", message: "Needs individual review." });
        continue;
      }
      const r = await supabase.rpc("review_delivery_ticket", { p_ticket_id: id, p_action: "accept", p_note: "Accepted in a batch of clean tickets" });
      if (r.error) results.push({ ticketId: id, ticketNumber: t.ticket_number, outcome: "failed", message: dbErrorMessage(r.error) });
      else { results.push({ ticketId: id, ticketNumber: t.ticket_number, outcome: "accepted", message: "Accepted." }); orders.add(t.order_id); }
    }
    revalidateTickets();
    for (const o of orders) revalidatePath(`/orders/${o}`);
    const n = results.filter((r) => r.outcome === "accepted").length;
    return ok({ results }, `${n} ticket${n === 1 ? "" : "s"} accepted.${results.length > n ? ` ${results.length - n} not accepted — see the list.` : ""}`);
  });
}

const readInput = z.object({ ticketId: z.uuid(), photoId: z.uuid() });

export interface TicketReadingView {
  reading: TicketReading;
  checks: CrossCheck[];
  model: string;
  tokens: { input: number | null; output: number | null };
  estimatedCostUsd: number | null;
}

/** Photos sent for reading are capped well below the provider's limit; scans from the app are re-encoded JPEGs. */
const MAX_READ_BYTES = 6 * 1024 * 1024;
const READABLE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/**
 * B84: read a ticket's paper-ticket photo with AI and cross-check it against the ticket and its order. Read only: the
 * reading is shown to the reviewer to compare with the photo; changing the ticket stays a person's correction, and
 * accepting stays a person's review.
 */
export async function readTicketPhoto(input: z.input<typeof readInput>): Promise<ActionResult<TicketReadingView>> {
  return guard(async () => {
    const access = await assertPermission("tickets.review");
    const parsed = readInput.safeParse(input);
    if (!parsed.success) return fail("Invalid photo.");
    const config = aiConfig();
    const ledger = await sessionLedger();
    const gate = await capabilityGate("ticket_reading", access, ledger, config);
    const ai = provider(config);
    if (!gate.canRun || !ai) return fail(`AI ticket reading is not available: ${gate.reasons[0] ?? "not configured"}`);

    const supabase = await createClient();
    const { data: t } = await supabase.from("delivery_tickets").select("id, ticket_number, external_reference, delivered_at, quantity, unit_code, snapshot").eq("id", parsed.data.ticketId).maybeSingle();
    if (!t) return fail("Ticket not found.");
    // The photo must belong to this ticket number (RLS already limits both to the person's company).
    const { data: photo } = await supabase.from("ticket_attachments").select("object_path, mime_type, size_bytes").eq("id", parsed.data.photoId).eq("ticket_number", t.ticket_number).maybeSingle();
    if (!photo) return fail("Photo not found on this ticket.");
    const mediaType = READABLE_TYPES.find((m) => m === photo.mime_type);
    if (!mediaType) return fail("This photo's format cannot be read. Add a JPEG, PNG or WebP scan.");
    if (Number(photo.size_bytes) > MAX_READ_BYTES) return fail("This photo is too large to read. Add a smaller scan.");
    const file = await supabase.storage.from("ticket-photos").download(photo.object_path as string);
    if (file.error || !file.data) return fail("The photo file could not be opened.");
    const base64 = Buffer.from(await file.data.arrayBuffer()).toString("base64");

    let run;
    try {
      run = await runCapability(ticketReadingRequest({ mediaType, base64 }), { provider: ai, ledger, gate, settings: runSettings(config), toolContext: { permissions: access.permissions, data: null } });
    } catch (e) {
      if (e instanceof AiError) return fail(`AI reading unavailable: ${publicMessage(e)} The ticket is unchanged.`);
      throw e;
    }

    const s = (t.snapshot ?? {}) as { load_date?: string; line_description?: string; truck_unit?: string };
    const [{ timezone }, unit, others] = await Promise.all([
      businessToday(),
      supabase.from("units_of_measure").select("label").eq("code", t.unit_code).maybeSingle(),
      run.value.ticket_number
        ? supabase.from("delivery_tickets").select("ticket_number, external_reference").ilike("external_reference", normalizeRef(run.value.ticket_number).split("").join("%")).neq("ticket_number", t.ticket_number).not("status", "in", "(voided,superseded)").limit(20)
        : Promise.resolve({ data: [] }),
    ]);
    const readRef = run.value.ticket_number ? normalizeRef(run.value.ticket_number) : null;
    const checks = crossCheck(run.value, {
      externalReference: t.external_reference,
      deliveredDate: todayIn(timezone, new Date(t.delivered_at)),
      loadDate: s.load_date ?? "",
      lineDescription: s.line_description ?? "",
      quantity: Number(t.quantity),
      unitCode: t.unit_code,
      unitLabel: (unit.data?.label as string | undefined) ?? t.unit_code,
      truckUnit: s.truck_unit ?? null,
      otherTicketsWithNumber: ((others.data ?? []) as Array<{ ticket_number: string; external_reference: string | null }>).filter((o) => o.external_reference && normalizeRef(o.external_reference) === readRef).map((o) => o.ticket_number),
    });
    return ok({ reading: run.value, checks, model: run.model, tokens: { input: run.usage.inputTokens, output: run.usage.outputTokens }, estimatedCostUsd: run.estimatedCostUsd });
  });
}
