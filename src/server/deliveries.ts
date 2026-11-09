import "server-only";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";

// Verified deliveries (security audit 2026-11-06, L2; migration 20261120009300). A signed-in person's request records an
// invoice or quote as emailed, or an invoice as created in QuickBooks, only with a proof the server issues after the
// email or accounting service answered. The proof travels with the person's own request (the recording functions keep
// their permission checks and history names) in this header, and is good once, for this record only.

export const DELIVERY_PROOF_HEADER = "x-taviron-delivery-proof";

export type DeliveryKind = "invoice.sent" | "quote.sent" | "accounting.sent";

/**
 * Issue a proof for one confirmed delivery. Call it only after the provider reported success. Returns null when the
 * database has no verified-delivery update yet (it then records sends as before) or the server account is missing;
 * the recording request then goes without a proof and the database decides.
 */
export async function deliveryProof(companyId: string, kind: DeliveryKind, targetId: string): Promise<string | null> {
  if (!adminAvailable()) return null;
  const { data, error } = await createAdminClient().rpc("delivery_proof_issue", { p_company: companyId, p_kind: kind, p_target: targetId });
  if (error) return null;
  return typeof data === "string" ? data : null;
}

/** Attaches a proof to a PostgREST request builder (a no-op without one). */
export function withProof<T extends { setHeader(name: string, value: string): T }>(request: T, proof: string | null): T {
  return proof ? request.setHeader(DELIVERY_PROOF_HEADER, proof) : request;
}
