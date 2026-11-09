import type { Stop } from "@/lib/dispatch/wait-times";
// Offline driver app (B133, owner 2026-11-02: cached day + queued sends; docs/COMPANION_APP.md §4).
//
// Two things are kept on the driver's phone, both under the signed-in person's id and both removed at sign-out:
//   * the day: today's loads as last read from Taviron, shown offline with the time they were read;
//   * the outbox: tickets, inspections and Arrived/Left taps made without signal, sent in order once signal returns.
// Nothing here is trusted by the server: every queued item goes through the same server action and database checks as
// a live one, with an idempotency key so a retry never records twice. Photos are never queued (they need signal).
//
// Browser storage can be missing or refuse writes (private mode, full disk); every call is wrapped and reports it.

export type OutboxKind = "ticket" | "inspection" | "stop";

export interface OutboxItem {
  /** Also the idempotency key sent with the item. */
  id: string;
  userId: string;
  kind: OutboxKind;
  /** What the driver sees in the list, e.g. "Ticket for ORD-1042 load 2". */
  label: string;
  payload: Record<string, unknown>;
  createdAt: string;
  /** waiting: sends when signal returns; failed: Taviron refused it (message kept), the driver decides. */
  status: "waiting" | "failed";
  error?: string;
}

export interface SnapshotLoad {
  assignmentId: string;
  loadId: string;
  loadNumber: number;
  date: string;
  start: string;
  end: string;
  orderNumber: string;
  customer: string | null;
  project: string;
  site: string;
  instructions: string;
  truck: string | null;
  trailer: string | null;
  canSubmitTicket: boolean;
  tickets: string[];
  lines: Array<{ id: string; description: string; unit_code: string }>;
  /** Pickup and job site, or the order's stops in order (MK2) with a label each. */
  stops: Array<{ stop: Stop; arrivedAt: string | null; departedAt: string | null; label?: string }>;
}

export interface DaySnapshot {
  userId: string;
  savedAt: string;
  today: string;
  timezone: string;
  /** "Enter delivery ticket" in the company's words (MK4); older saved days have none. */
  enterLabel?: string;
  driverName: string;
  loads: SnapshotLoad[];
  units: Array<{ code: string; label: string }>;
  inspectionTrucks: Array<{ id: string; label: string; pending: Array<"pre_trip" | "post_trip">; dump?: boolean }>;
}

const DAY_KEY = "taviron-offline-day";
const OUTBOX_KEY = "taviron-offline-outbox";
/** A saved day is not shown after this long: it would mislead more than it helps. */
export const SNAPSHOT_MAX_AGE_MS = 18 * 60 * 60_000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(s?: Store): Store | null {
  if (s) return s;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read<T>(key: string, s?: Store): T | null {
  try {
    const raw = storage(s)?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown, s?: Store): boolean {
  try {
    const st = storage(s);
    if (!st) return false;
    st.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** The stored text as is (stable between reads, for React's useSyncExternalStore); null when none or unreadable. */
export function rawStored(which: "day" | "outbox"): string | null {
  try {
    return storage()?.getItem(which === "day" ? DAY_KEY : OUTBOX_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveDay(day: DaySnapshot, s?: Store): boolean {
  return write(DAY_KEY, day, s);
}

/** The saved day for this person, or the last saved one when the person is not known (offline page); null if too old. */
export function readDay(now: number, userId?: string | null, s?: Store): DaySnapshot | null {
  const d = read<DaySnapshot>(DAY_KEY, s);
  if (!d || (userId && d.userId !== userId)) return null;
  if (now - Date.parse(d.savedAt) > SNAPSHOT_MAX_AGE_MS) return null;
  return d;
}

export function readOutbox(userId?: string | null, s?: Store): OutboxItem[] {
  const all = read<OutboxItem[]>(OUTBOX_KEY, s) ?? [];
  return userId ? all.filter((i) => i.userId === userId) : all;
}

export function enqueue(item: Omit<OutboxItem, "status" | "createdAt"> & { createdAt?: string }, s?: Store): boolean {
  const all = read<OutboxItem[]>(OUTBOX_KEY, s) ?? [];
  if (all.some((i) => i.id === item.id)) return true; // the same tap or form twice: one item
  return write(OUTBOX_KEY, [...all, { ...item, createdAt: item.createdAt ?? new Date().toISOString(), status: "waiting" }], s);
}

export function updateItem(id: string, patch: Partial<Pick<OutboxItem, "status" | "error">>, s?: Store): void {
  const all = read<OutboxItem[]>(OUTBOX_KEY, s) ?? [];
  write(OUTBOX_KEY, all.map((i) => (i.id === id ? { ...i, ...patch } : i)), s);
}

export function removeItem(id: string, s?: Store): void {
  const all = read<OutboxItem[]>(OUTBOX_KEY, s) ?? [];
  write(OUTBOX_KEY, all.filter((i) => i.id !== id), s);
}

/**
 * Undo of a tap that has not left the phone yet: the waiting item is removed and true is returned. False when it is no
 * longer waiting here (already sent, or refused and kept as failed), so the caller asks Taviron to undo it instead.
 */
export function takeBackQueued(id: string, s?: Store): boolean {
  const all = read<OutboxItem[]>(OUTBOX_KEY, s) ?? [];
  if (!all.some((i) => i.id === id && i.status === "waiting")) return false;
  return write(OUTBOX_KEY, all.filter((i) => i.id !== id), s);
}

/** Sign-out: the saved day and everything queued on this phone are removed. */
export function clearOffline(s?: Store): void {
  try {
    const st = storage(s);
    st?.removeItem(DAY_KEY);
    st?.removeItem(OUTBOX_KEY);
  } catch {
    /* nothing stored */
  }
}

/** A send that failed because there was no connection (rather than an answer from Taviron). */
export function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /fetch|network|load failed|connection|offline/i.test(msg);
}

/**
 * When an item was saved, as a clock time in the company's time zone (the same clock My Day uses), so the list never
 * shows the phone's or the server's zone instead. Without a zone (an older saved day) the phone's clock is used.
 */
export function outboxTime(iso: string, timeZone?: string | null): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(d); // unknown zone name
  }
}

export type SendOutcome = { sent: true } | { sent: false; network: true } | { sent: false; network: false; error: string };

/**
 * Send what is waiting for this person, oldest first, through `send` (the same server actions as a live item). Stops at
 * the first item that fails for lack of a connection; an item Taviron refuses is kept as failed with its message.
 */
export async function flushOutbox(userId: string, send: (item: OutboxItem) => Promise<SendOutcome>, s?: Store): Promise<{ sent: number; failed: number; network: boolean }> {
  const waiting = readOutbox(userId, s).filter((i) => i.status === "waiting");
  let sent = 0;
  let failed = 0;
  let network = false;
  for (const item of waiting) {
    const r = await send(item);
    if (r.sent) { removeItem(item.id, s); sent++; }
    else if (r.network) { network = true; break; }
    else { updateItem(item.id, { status: "failed", error: r.error }, s); failed++; }
    announceOutbox();
  }
  return { sent, failed, network };
}

export const OUTBOX_EVENT = "taviron-outbox-changed";
export function announceOutbox(): void {
  try {
    window.dispatchEvent(new Event(OUTBOX_EVENT));
  } catch {
    /* not in a browser */
  }
}
