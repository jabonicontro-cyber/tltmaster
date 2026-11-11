// A quote's History (owner walkthrough WK1: quote edits were missing). Status changes come from quote_status_events;
// edits and new revisions from the audit log the database functions write (save_quote_draft → quote.updated,
// revise_quote → quote.revised), read with the person's own session: owners always, everyone with quotes.view once
// 20261120019000 is installed. Created, issued, sent and decided are already status changes and are not repeated.

import { formatCents } from "@/lib/money";
import { QUOTE_STATUS_LABELS, type QuoteStatus } from "@/lib/quotes/status";

export interface QuoteStatusEvent { id: string; from_status: QuoteStatus | null; to_status: QuoteStatus; note: string; actor_id: string | null; occurred_at: string }
export interface QuoteAuditEntry { id: string; occurred_at: string; actor_id: string | null; action: string; summary: string; details: Record<string, unknown> | null }

export interface QuoteHistoryItem { key: string; at: string; actorId: string | null; title: string; note: string }

/** The audit actions shown in History (the rest are status changes, listed from quote_status_events). */
export const QUOTE_HISTORY_ACTIONS = ["quote.updated", "quote.revised"] as const;

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** One audit entry in plain words ("Edited revision 1" · "Total $1,234.00, 2 lines"). Null for actions not shown. */
export function auditHistoryItem(e: QuoteAuditEntry, versionNo: (versionId: string) => number | null): QuoteHistoryItem | null {
  const d = e.details ?? {};
  if (e.action === "quote.updated") {
    const v = typeof d.version_id === "string" ? versionNo(d.version_id) : null;
    const total = num(d.total_cents);
    const lines = num(d.line_count);
    const parts = [total !== null ? `Total ${formatCents(total)}` : "", lines !== null ? `${lines} line${lines === 1 ? "" : "s"}` : "", d.pricing_override === true ? "a price differs from the price list" : ""].filter(Boolean);
    return { key: `a:${e.id}`, at: e.occurred_at, actorId: e.actor_id, title: v !== null ? `Edited revision ${v}` : "Edited", note: parts.join(", ") };
  }
  if (e.action === "quote.revised") {
    const v = typeof d.to_version_id === "string" ? versionNo(d.to_version_id) : null;
    // The summary ends with the reason the person gave ("QTE-1001 revision 2 started: <reason>").
    const reason = e.summary.includes(": ") ? e.summary.slice(e.summary.indexOf(": ") + 2) : "";
    return { key: `a:${e.id}`, at: e.occurred_at, actorId: e.actor_id, title: v !== null ? `Revision ${v} started` : "New revision started", note: reason };
  }
  return null;
}

/** Status changes and edits together, newest first. */
export function quoteHistory(events: readonly QuoteStatusEvent[], audit: readonly QuoteAuditEntry[], versions: ReadonlyArray<{ id: string; version_no: number }>): QuoteHistoryItem[] {
  const byId = new Map(versions.map((v) => [v.id, v.version_no]));
  const versionNo = (id: string) => byId.get(id) ?? null;
  const status: QuoteHistoryItem[] = events.map((e) => ({
    key: `s:${e.id}`, at: e.occurred_at, actorId: e.actor_id,
    title: `${e.from_status ? `${QUOTE_STATUS_LABELS[e.from_status]} → ` : ""}${QUOTE_STATUS_LABELS[e.to_status]}`, note: e.note,
  }));
  const edits = audit.map((a) => auditHistoryItem(a, versionNo)).filter((x): x is QuoteHistoryItem => x !== null);
  return [...status, ...edits].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.key < b.key ? 1 : -1));
}
