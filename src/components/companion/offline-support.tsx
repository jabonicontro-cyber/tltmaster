"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { CloudOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { loadOfflineDay } from "@/app/(app)/driver/offline-actions";
import { sendQueued } from "@/lib/offline/send";
import { OUTBOX_EVENT, announceOutbox, flushOutbox, outboxTime, rawStored, readOutbox, removeItem, saveDay, type OutboxItem } from "@/lib/offline/store";

const RETRY_MS = 20_000;

function subscribe(onChange: () => void) {
  window.addEventListener(OUTBOX_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => { window.removeEventListener(OUTBOX_EVENT, onChange); window.removeEventListener("storage", onChange); };
}

/** The queue on this phone for this person, kept in step with changes from any form (B133). */
export function useOutbox(userId: string | null) {
  const raw = useSyncExternalStore(subscribe, () => rawStored("outbox"), () => null);
  // Re-read only when the stored text changes.
  return useMemo(() => (raw ? readOutbox(userId) : []), [raw, userId]);
}

/**
 * Sends what is waiting for this person (one run at a time, never while the phone says it is offline). Shared by My Day
 * and the offline page so both use the same sync.
 */
export function useOutboxFlush(userId: string | null) {
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const flush = useCallback(async () => {
    if (!userId || busy.current || (typeof navigator !== "undefined" && navigator.onLine === false)) return { sent: 0, failed: 0, network: false, skipped: true };
    busy.current = true;
    setSending(true);
    try {
      return { ...(await flushOutbox(userId, sendQueued)), skipped: false };
    } finally {
      busy.current = false;
      setSending(false);
    }
  }, [userId]);
  return { flush, sending };
}

/** What is waiting on this phone: each item, when it was saved (company time zone), and why Taviron refused it if it did. */
export function OutboxList({ items, onSend, sending, timeZone }: { items: OutboxItem[]; onSend?: () => void; sending?: boolean; timeZone?: string | null }) {
  if (!items.length) return null;
  const failed = items.filter((i) => i.status === "failed");
  return (
    <section aria-label="Waiting to send" className="rounded-panel bg-amber-50 p-4 text-amber-950 ring-1 ring-amber-200">
      <div className="flex items-center gap-2">
        <CloudOff className="size-5 shrink-0" aria-hidden />
        <h2 className="flex-1 text-base font-bold">Waiting to send ({items.length})</h2>
        {onSend && <Button size="sm" variant="secondary" loading={sending} onClick={onSend}><RefreshCw className="size-4" aria-hidden /> Send now</Button>}
      </div>
      <p className="mt-1 text-sm">Saved on this phone, not yet with the office. They send by themselves when you have signal.</p>
      <ul className="mt-3 space-y-2">
        {items.map((i) => (
          <li key={i.id} className="rounded-xl bg-card px-3 py-2 text-sm text-ink ring-1 ring-line">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 font-semibold">{i.label}</span>
              <span className="text-muted tabular">{outboxTime(i.createdAt, timeZone)}</span>
            </div>
            {i.status === "failed" && (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-critical">Not accepted: {i.error}</p>
                <button
                  type="button"
                  className="min-h-10 rounded-lg px-3 text-sm font-semibold text-critical underline"
                  onClick={() => { if (window.confirm("Delete this from the phone? It was not sent and cannot be recovered.")) { removeItem(i.id); announceOutbox(); } }}
                >
                  Delete
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {failed.length > 0 && <p className="mt-2 text-sm">Items Taviron did not accept stay here until you delete them. Tell the office what they were.</p>}
    </section>
  );
}

/**
 * On My Day (B133): keeps today's loads on the phone for when signal drops, and sends what is waiting as soon as there
 * is signal, oldest first. An answer from Taviron that refuses an item is kept and shown, never silently dropped.
 */
export function OfflineSupport({ userId, timeZone }: { userId: string; /** The company's time zone, for the saved times. */ timeZone?: string }) {
  const router = useRouter();
  const items = useOutbox(userId);
  const { flush: send, sending } = useOutboxFlush(userId);

  const flush = useCallback(async () => {
    const r = await send();
    if (r.sent > 0) router.refresh();
  }, [send, router]);

  // Keep today's loads on the phone (after the page has loaded; never in its way).
  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    loadOfflineDay().then((d) => { if (d) saveDay(d); }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void flush(), 0);
    const online = () => void flush();
    window.addEventListener("online", online);
    const t = window.setInterval(() => void flush(), RETRY_MS);
    return () => { window.clearTimeout(first); window.removeEventListener("online", online); window.clearInterval(t); };
  }, [flush]);

  return <OutboxList items={items} onSend={() => void flush()} sending={sending} timeZone={timeZone} />;
}
