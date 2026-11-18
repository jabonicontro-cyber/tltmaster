import type { Stop } from "@/lib/dispatch/wait-times";
// Offline driver app (B133, owner 2026-11-02: cached day + queued sends; docs/COMPANION_APP.md §4).
//
// Two things are kept on the driver's phone, both under the signed-in person's id and both removed at sign-out:
//   * the day: today's loads as last read from Taviron, shown offline with the time they were read;
//   * the outbox: tickets, inspections, problem reports and Arrived/Left taps made without signal, sent in order once
//     signal returns (problem reports: walkthrough P1, 2026-11-16).
// Nothing here is trusted by the server: every queued item goes through the same server action and database checks as
// a live one, with an idempotency key so a retry never records twice. Photos of a queued ticket or report (P2) are kept
// beside the queue as small JPEGs under the same person, uploaded before their item is sent (a ticket's with its own
// upload key, so a retry never stores a second copy), and removed at sign-out with everything else.
//
// Browser storage can be missing or refuse writes (private mode, full disk); every call is wrapped and reports it.

/** mistake: "Mistake on my ticket" (TM1), sent like a problem report, with its one optional photo after it. */
export type OutboxKind = "ticket" | "inspection" | "stop" | "report" | "mistake";

export interface OutboxItem {
  /** Also the idempotency key sent with the item. */
  id: string;
  userId: string;
  kind: OutboxKind;
  /** What the driver sees in the list, e.g. "Ticket for ORD-1042 load 2". */
  label: string;
  payload: Record<string, unknown>;
  /** Photos kept on the phone for this item (keys into the photo store), still to be uploaded. */
  photos?: string[];
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
  /** The sent tickets with their ids and paper numbers ("Mistake on my ticket" without signal, TM1); older days have none. */
  ticketRefs?: Array<{ id: string; number: string; paper: string | null }>;
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
const PHOTOS_KEY = "taviron-offline-photos";
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

/** A photo kept on the phone for a queued item: a JPEG as a data URL, for the person who took it. */
export interface StoredPhoto { key: string; userId: string; data: string }

function readPhotos(s?: Store): StoredPhoto[] {
  return read<StoredPhoto[]>(PHOTOS_KEY, s) ?? [];
}

/** One kept photo by its key, for this person only; null when it is gone. */
export function readPhoto(key: string, userId: string, s?: Store): StoredPhoto | null {
  return readPhotos(s).find((p) => p.key === key && p.userId === userId) ?? null;
}

function dropPhotos(keys: readonly string[], s?: Store): void {
  if (!keys.length) return;
  const all = readPhotos(s);
  if (!all.some((p) => keys.includes(p.key))) return;
  const left = all.filter((p) => !keys.includes(p.key));
  if (left.length) {
    write(PHOTOS_KEY, left, s);
    return;
  }
  try {
    storage(s)?.removeItem(PHOTOS_KEY);
  } catch {
    /* nothing stored */
  }
}

/**
 * Queue an item with its photos (P2): the photos are kept first, then the item. If the phone refuses either (storage
 * full, private mode) nothing is kept and false is returned, so the form says so instead of losing them quietly.
 */
export function enqueueWithPhotos(
  item: Omit<OutboxItem, "status" | "createdAt" | "photos"> & { createdAt?: string },
  photos: ReadonlyArray<{ key: string; data: string }>,
  s?: Store,
): boolean {
  if (!photos.length) return enqueue(item, s);
  const outbox = read<OutboxItem[]>(OUTBOX_KEY, s) ?? [];
  if (outbox.some((i) => i.id === item.id)) return true; // the same form twice: one item
  const all = readPhotos(s);
  const fresh = photos.filter((p) => !all.some((x) => x.key === p.key));
  if (!write(PHOTOS_KEY, [...all, ...fresh.map((p) => ({ key: p.key, userId: item.userId, data: p.data }))], s)) return false;
  const ok = write(OUTBOX_KEY, [...outbox, { ...item, photos: photos.map((p) => p.key), createdAt: item.createdAt ?? new Date().toISOString(), status: "waiting" }], s);
  if (!ok) dropPhotos(fresh.map((p) => p.key), s);
  return ok;
}

export function updateItem(id: string, patch: Partial<Pick<OutboxItem, "status" | "error">>, s?: Store): void {
  const all = read<OutboxItem[]>(OUTBOX_KEY, s) ?? [];
  write(OUTBOX_KEY, all.map((i) => (i.id === id ? { ...i, ...patch } : i)), s);
}

/** Removes the item and the photos kept for it (sent, or deleted by the driver). */
export function removeItem(id: string, s?: Store): void {
  const all = read<OutboxItem[]>(OUTBOX_KEY, s) ?? [];
  write(OUTBOX_KEY, all.filter((i) => i.id !== id), s);
  dropPhotos(all.find((i) => i.id === id)?.photos ?? [], s);
}

/**
 * Photos of a queued item that reached Taviron (P2): they leave the phone, and the item keeps what Taviron gave back
 * (the ticket's photo ids, in its payload), so a retry after a lost connection never uploads them again.
 */
export function photosSent(id: string, keys: readonly string[], payload: Record<string, unknown>, s?: Store): void {
  const all = read<OutboxItem[]>(OUTBOX_KEY, s) ?? [];
  write(OUTBOX_KEY, all.map((i) => (i.id === id ? { ...i, payload, photos: (i.photos ?? []).filter((k) => !keys.includes(k)) } : i)), s);
  dropPhotos(keys, s);
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
    st?.removeItem(PHOTOS_KEY);
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
 * What the driver is told once queued items reach the office (P3), e.g. "Sent to the office: Ticket for ORD-1042
 * load 2." Several at once are counted, with the first three named.
 */
export function sentSummary(labels: readonly string[]): string {
  if (!labels.length) return "";
  if (labels.length === 1) return `Sent to the office: ${labels[0]}.`;
  const more = labels.length > 3 ? `, and ${labels.length - 3} more` : "";
  return `${labels.length} items saved on this phone were sent to the office: ${labels.slice(0, 3).join("; ")}${more}.`;
}

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
