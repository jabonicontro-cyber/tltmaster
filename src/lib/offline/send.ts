"use client";

import { submitDriverTicket } from "@/app/(app)/driver/actions";
import { submitInspection } from "@/app/(app)/fleet/inspections/actions";
import { markStopAt } from "@/app/(app)/reports/wait-times/actions";
import { isNetworkError, type OutboxItem } from "./store";

export type SendOutcome = { sent: true } | { sent: false; network: true } | { sent: false; network: false; error: string };

/**
 * Send one queued item through the same server action as a live one (B133). The server re-checks everything: who is
 * signed in, their permission, the load or truck, and the business rules; a ticket carries its idempotency key.
 */
export async function sendQueued(item: OutboxItem): Promise<SendOutcome> {
  try {
    const p = item.payload;
    const r =
      item.kind === "ticket" ? await submitDriverTicket(p as Parameters<typeof submitDriverTicket>[0])
      : item.kind === "inspection" ? await submitInspection(p as Parameters<typeof submitInspection>[0])
      : await markStopAt(p as Parameters<typeof markStopAt>[0]);
    if (r.ok) return { sent: true };
    return { sent: false, network: false, error: r.error };
  } catch (e) {
    if (isNetworkError(e)) return { sent: false, network: true };
    return { sent: false, network: false, error: "Taviron could not take this item. Tell the office." };
  }
}
