"use client";

import { toast } from "sonner";
import { reportTicketMistake, submitDriverTicket, submitFieldReport } from "@/app/(app)/driver/actions";
import { submitInspection } from "@/app/(app)/fleet/inspections/actions";
import { markStopAt } from "@/app/(app)/reports/wait-times/actions";
import { dataUrlToBlob } from "@/lib/files/phone-photo";
import { isNetworkError, photosSent, readPhoto, sentSummary, type OutboxItem, type SendOutcome } from "./store";

export type { SendOutcome };

type PhotoResult = { ok: true; id: string | null } | { ok: false; network: true } | { ok: false; network: false; error: string; stop?: boolean };

/** One kept photo to Taviron (P2). No answer at all is "no connection"; a 5xx is treated the same (try again later). */
async function upload(url: string, fields: Record<string, string>, data: string): Promise<PhotoResult> {
  let blob: Blob;
  try {
    blob = dataUrlToBlob(data);
  } catch {
    return { ok: false, network: false, error: "A photo kept on the phone could not be read." };
  }
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  body.set("file", new File([blob], "photo.jpg", { type: blob.type || "image/jpeg" }));
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", body });
  } catch {
    return { ok: false, network: true };
  }
  const json = (await res.json().catch(() => ({}))) as { attachmentId?: string; error?: string };
  if (res.ok) return { ok: true, id: json.attachmentId ?? null };
  if (res.status >= 500 && res.status !== 501) return { ok: false, network: true };
  return { ok: false, network: false, error: json.error ?? "A photo was not accepted.", stop: res.status === 501 };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * A ticket's kept photos (P2), each with its own upload key (the key it was kept under), so a retry after a lost
 * connection gets the same stored photo back instead of a second copy. Returns the ticket to send with every photo id.
 */
async function ticketPhotos(item: OutboxItem): Promise<{ payload: Record<string, unknown>; refused: number } | { network: true }> {
  let payload = item.payload;
  let refused = 0;
  for (const key of item.photos ?? []) {
    const kept = readPhoto(key, item.userId);
    if (!kept) continue;
    const r = await upload("/driver/photos", { assignment_id: String(payload.assignmentId ?? ""), upload_key: key }, kept.data);
    if (!r.ok && r.network) return { network: true };
    if (r.ok && r.id) payload = { ...payload, photoIds: [...((payload.photoIds as string[] | undefined) ?? []), r.id] };
    else refused++;
    photosSent(item.id, [key], payload);
  }
  return { payload, refused };
}

/** A report's kept photos, after the report is saved (as on the live form): a refused photo never undoes the report. */
async function reportPhotos(item: OutboxItem, reportId: string): Promise<{ refused: number; sent: number } | { network: true }> {
  let refused = 0;
  let sent = 0;
  const keys = item.photos ?? [];
  for (let i = 0; i < keys.length; i++) {
    const kept = readPhoto(keys[i], item.userId);
    if (!kept) continue;
    const r = await upload("/field-reports/photos", { report: reportId }, kept.data);
    if (!r.ok && r.network) return { network: true };
    if (r.ok) sent++;
    else if (r.stop) {
      // Photos on reports are not available yet: none of them can go, the report already has.
      refused += keys.length - i;
      photosSent(item.id, keys.slice(i), item.payload);
      break;
    } else refused++;
    photosSent(item.id, [keys[i]], item.payload);
  }
  return { refused, sent };
}

// Items sent in the last few seconds, so a run of them shows as one message instead of one per item (P3).
let recent: string[] = [];
let recentTimer: ReturnType<typeof setTimeout> | undefined;
function tellSent(label: string, note: string) {
  recent = [...recent, label];
  clearTimeout(recentTimer);
  recentTimer = setTimeout(() => { recent = []; }, 10_000);
  const text = `${sentSummary(recent)}${note ? ` ${note}` : ""}`;
  if (note) toast.warning(text, { id: "outbox-sent", duration: 10_000 });
  else toast.success(text, { id: "outbox-sent", duration: 8_000 });
}

/**
 * Send one queued item through the same server action as a live one (B133). The server re-checks everything: who is
 * signed in, their permission, the load or truck, and the business rules; a ticket and a report carry their
 * idempotency key. Once it is in, the driver is told (P3), unless the caller says it tells them itself.
 */
export async function sendQueued(item: OutboxItem, opts: { quiet?: boolean } = {}): Promise<SendOutcome> {
  try {
    const p = item.payload;
    let note = "";
    let r: { ok: true } | { ok: false; error: string };
    if (item.kind === "ticket") {
      const photos = await ticketPhotos(item);
      if ("network" in photos) return { sent: false, network: true };
      if (photos.refused) note = `${plural(photos.refused, "photo")} could not be added. Show the paper ticket to the office.`;
      r = await submitDriverTicket(photos.payload as Parameters<typeof submitDriverTicket>[0]);
    } else if (item.kind === "report") {
      const rep = await submitFieldReport(p as Parameters<typeof submitFieldReport>[0]);
      if (rep.ok) {
        const photos = await reportPhotos(item, rep.data.reportId);
        if ("network" in photos) return { sent: false, network: true };
        if (photos.refused) note = `${plural(photos.refused, "photo")} could not be added to the report.`;
      }
      r = rep;
    } else if (item.kind === "mistake") {
      // "Mistake on my ticket" (TM1): the report first (its submission key makes a retry record nothing twice), then its
      // one kept photo; a refused photo never undoes the report.
      const rep = await reportTicketMistake(p as Parameters<typeof reportTicketMistake>[0]);
      if (rep.ok) {
        for (const key of item.photos ?? []) {
          const kept = readPhoto(key, item.userId);
          if (!kept) continue;
          const up = await upload("/driver/mistake-photo", { report: rep.data.reportId }, kept.data);
          if (!up.ok && up.network) return { sent: false, network: true };
          if (!up.ok) note = "The photo could not be added: show the paper ticket to the office.";
          photosSent(item.id, [key], item.payload);
        }
      }
      r = rep;
    } else if (item.kind === "inspection") {
      r = await submitInspection(p as Parameters<typeof submitInspection>[0]);
    } else {
      r = await markStopAt(p as Parameters<typeof markStopAt>[0]);
    }
    if (r.ok) {
      if (!opts.quiet) tellSent(item.label, note);
      return { sent: true };
    }
    if (!opts.quiet) toast.error(`Not accepted: ${item.label}. It stays under Waiting to send with the reason.`, { duration: 10_000 });
    return { sent: false, network: false, error: r.error };
  } catch (e) {
    if (isNetworkError(e)) return { sent: false, network: true };
    return { sent: false, network: false, error: "Taviron could not take this item. Tell the office." };
  }
}
