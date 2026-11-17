import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Offline driver app, walkthrough fixes P1–P3 (2026-11-16): a problem report waits on the phone like a ticket, photos
// of a queued ticket or report wait with it (kept per person, uploaded before the item, never twice), and the driver is
// told once queued items reach the office. The server actions are stand-ins here; the store is the real one.

const actions = vi.hoisted(() => ({
  submitDriverTicket: vi.fn(),
  submitFieldReport: vi.fn(),
  submitInspection: vi.fn(),
  markStopAt: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock("@/app/(app)/driver/actions", () => ({ submitDriverTicket: actions.submitDriverTicket, submitFieldReport: actions.submitFieldReport }));
vi.mock("@/app/(app)/fleet/inspections/actions", () => ({ submitInspection: actions.submitInspection }));
vi.mock("@/app/(app)/reports/wait-times/actions", () => ({ markStopAt: actions.markStopAt }));
vi.mock("sonner", () => ({ toast: actions.toast }));

import { sendQueued } from "@/lib/offline/send";
import { clearOffline, enqueue, enqueueWithPhotos, flushOutbox, photosSent, readOutbox, readPhoto, removeItem, sentSummary } from "@/lib/offline/store";

function fakeStorage(limit = Infinity) {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > limit) throw new Error("QuotaExceededError");
      m.set(k, v);
    },
    removeItem: (k: string) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}
const PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

describe("offline store: problem reports and kept photos", () => {
  it("queues a report like any item, and keeps a ticket's photos with it for its person only", () => {
    const s = fakeStorage();
    expect(enqueue({ id: "r1", userId: "u1", kind: "report", label: "Breakdown · ORD-1 load 2", payload: { kind: "breakdown" } }, s)).toBe(true);
    expect(enqueueWithPhotos({ id: "t1", userId: "u1", kind: "ticket", label: "Ticket", payload: { photoIds: [] } }, [{ key: "p1", data: PHOTO }, { key: "p2", data: PHOTO }], s)).toBe(true);
    expect(enqueueWithPhotos({ id: "t1", userId: "u1", kind: "ticket", label: "Ticket", payload: {} }, [{ key: "p3", data: PHOTO }], s)).toBe(true); // double tap: one item
    expect(readOutbox("u1", s).map((i) => [i.id, i.kind, i.photos ?? null])).toEqual([["r1", "report", null], ["t1", "ticket", ["p1", "p2"]]]);
    expect(readPhoto("p1", "u1", s)?.data).toBe(PHOTO);
    expect(readPhoto("p3", "u1", s)).toBeNull();
    expect(readPhoto("p1", "u2", s)).toBeNull(); // someone else's sign-in never reads them
  });

  it("an uploaded photo leaves the phone; a sent or deleted item takes its photos with it; sign-out removes them all", () => {
    const s = fakeStorage();
    enqueueWithPhotos({ id: "t1", userId: "u1", kind: "ticket", label: "Ticket", payload: { photoIds: [] } }, [{ key: "p1", data: PHOTO }, { key: "p2", data: PHOTO }], s);
    photosSent("t1", ["p1"], { photoIds: ["a1"] }, s);
    expect(readOutbox("u1", s)[0]).toMatchObject({ photos: ["p2"], payload: { photoIds: ["a1"] } });
    expect(readPhoto("p1", "u1", s)).toBeNull();
    removeItem("t1", s);
    expect(readPhoto("p2", "u1", s)).toBeNull();
    expect(s.keys()).not.toContain("taviron-offline-photos");

    enqueueWithPhotos({ id: "t2", userId: "u1", kind: "ticket", label: "Ticket", payload: {} }, [{ key: "p9", data: PHOTO }], s);
    clearOffline(s);
    expect(s.keys()).toEqual([]);
  });

  it("a phone without room keeps neither the photos nor the item, and says so", () => {
    const s = fakeStorage(200);
    expect(enqueueWithPhotos({ id: "t1", userId: "u1", kind: "ticket", label: "Ticket", payload: {} }, [{ key: "p1", data: PHOTO.repeat(20) }], s)).toBe(false);
    expect(readOutbox("u1", s)).toEqual([]);
    expect(readPhoto("p1", "u1", s)).toBeNull();
  });

  it("tells the driver what reached the office in plain words", () => {
    expect(sentSummary([])).toBe("");
    expect(sentSummary(["Ticket for ORD-1 load 2"])).toBe("Sent to the office: Ticket for ORD-1 load 2.");
    expect(sentSummary(["A", "B", "C", "D", "E"])).toBe("5 items saved on this phone were sent to the office: A; B; C, and 2 more.");
  });
});

describe("sending queued items", () => {
  let store: ReturnType<typeof fakeStorage>;
  let uploads: Array<{ url: string; fields: Record<string, string> }>;
  let answer: (url: string, n: number) => Response | "offline";

  beforeEach(() => {
    store = fakeStorage();
    uploads = [];
    answer = (url) => new Response(JSON.stringify(url.includes("driver") ? { attachmentId: `att-${uploads.length}` } : {}), { status: 200 });
    vi.stubGlobal("window", { localStorage: store, dispatchEvent: () => true });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: FormData }) => {
      const fields: Record<string, string> = {};
      init.body.forEach((v, k) => { if (typeof v === "string") fields[k] = v; });
      uploads.push({ url, fields });
      const r = answer(url, uploads.length);
      if (r === "offline") throw new TypeError("Failed to fetch");
      return r;
    }));
    for (const f of [actions.submitDriverTicket, actions.submitFieldReport, actions.submitInspection, actions.markStopAt, actions.toast.success, actions.toast.warning, actions.toast.error]) f.mockReset();
    // The "sent" message gathers items sent within a few seconds; each test starts a fresh window.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.advanceTimersByTime(60_000);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a ticket's kept photos go first, each with its own upload key, and the ticket carries their ids", async () => {
    actions.submitDriverTicket.mockResolvedValue({ ok: true, data: { ticketId: "t", ticketNumber: "TKT-1", created: true } });
    enqueueWithPhotos({ id: "k1", userId: "u1", kind: "ticket", label: "Ticket for ORD-1 load 2", payload: { assignmentId: "as1", photoIds: ["already"] } }, [{ key: "p1", data: PHOTO }], store);
    const r = await flushOutbox("u1", sendQueued, store);
    expect(r).toEqual({ sent: 1, failed: 0, network: false });
    expect(uploads).toEqual([{ url: "/driver/photos", fields: { assignment_id: "as1", upload_key: "p1" } }]);
    expect(actions.submitDriverTicket).toHaveBeenCalledWith(expect.objectContaining({ photoIds: ["already", "att-1"] }));
    expect(readOutbox("u1", store)).toEqual([]);
    expect(store.keys()).not.toContain("taviron-offline-photos");
    expect(actions.toast.success).toHaveBeenCalledWith("Sent to the office: Ticket for ORD-1 load 2.", expect.anything());
  });

  it("no connection halfway: the uploaded photo is not sent again, and nothing is reported as sent", async () => {
    actions.submitDriverTicket.mockResolvedValue({ ok: true, data: { ticketId: "t", ticketNumber: "TKT-1", created: true } });
    enqueueWithPhotos({ id: "k1", userId: "u1", kind: "ticket", label: "Ticket", payload: { assignmentId: "as1", photoIds: [] } }, [{ key: "p1", data: PHOTO }, { key: "p2", data: PHOTO }], store);
    answer = (url, n) => (n === 2 ? "offline" : new Response(JSON.stringify({ attachmentId: "att-a" }), { status: 200 }));
    expect(await flushOutbox("u1", sendQueued, store)).toEqual({ sent: 0, failed: 0, network: true });
    expect(actions.submitDriverTicket).not.toHaveBeenCalled();
    expect(actions.toast.success).not.toHaveBeenCalled();
    expect(readOutbox("u1", store)[0]).toMatchObject({ status: "waiting", photos: ["p2"], payload: { photoIds: ["att-a"] } });

    answer = () => new Response(JSON.stringify({ attachmentId: "att-b" }), { status: 200 });
    expect(await flushOutbox("u1", sendQueued, store)).toEqual({ sent: 1, failed: 0, network: false });
    expect(uploads.map((u) => u.fields.upload_key)).toEqual(["p1", "p2", "p2"]);
    expect(actions.submitDriverTicket).toHaveBeenCalledWith(expect.objectContaining({ photoIds: ["att-a", "att-b"] }));
  });

  it("a problem report is saved first, then its photos; a refused photo never undoes the report and is said", async () => {
    actions.submitFieldReport.mockResolvedValue({ ok: true, data: { reportId: "rep-1", created: true } });
    enqueueWithPhotos({ id: "k2", userId: "u1", kind: "report", label: "Breakdown · ORD-1 load 2", payload: { assignmentId: "as1", kind: "breakdown", description: "Engine quit", submissionKey: "k2" } }, [{ key: "p1", data: PHOTO }, { key: "p2", data: PHOTO }], store);
    answer = (_url, n) => (n === 1 ? new Response(JSON.stringify({ error: "Too large." }), { status: 413 }) : new Response("{}", { status: 200 }));
    expect(await flushOutbox("u1", sendQueued, store)).toEqual({ sent: 1, failed: 0, network: false });
    expect(actions.submitFieldReport).toHaveBeenCalledWith(expect.objectContaining({ kind: "breakdown", submissionKey: "k2" }));
    expect(uploads.map((u) => [u.url, u.fields.report])).toEqual([["/field-reports/photos", "rep-1"], ["/field-reports/photos", "rep-1"]]);
    expect(actions.toast.warning).toHaveBeenCalledWith("Sent to the office: Breakdown · ORD-1 load 2. 1 photo could not be added to the report.", expect.anything());
  });

  it("a report Taviron refuses stays on the phone with the reason; no signal leaves it waiting", async () => {
    actions.submitFieldReport.mockResolvedValueOnce({ ok: false, error: "This load is no longer available." });
    enqueue({ id: "k3", userId: "u1", kind: "report", label: "Delay", payload: { assignmentId: "as1", kind: "delay", description: "Stuck", submissionKey: "k3" } }, store);
    expect(await flushOutbox("u1", sendQueued, store)).toEqual({ sent: 0, failed: 1, network: false });
    expect(readOutbox("u1", store)[0]).toMatchObject({ status: "failed", error: "This load is no longer available." });
    expect(actions.toast.error).toHaveBeenCalled();

    actions.submitFieldReport.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    enqueue({ id: "k4", userId: "u1", kind: "report", label: "Delay", payload: {} }, store);
    expect(await flushOutbox("u1", sendQueued, store)).toEqual({ sent: 0, failed: 0, network: true });
    expect(readOutbox("u1", store).find((i) => i.id === "k4")?.status).toBe("waiting");
  });

  it("several items sent together are told as one message, naming them", async () => {
    actions.markStopAt.mockResolvedValue({ ok: true });
    actions.submitInspection.mockResolvedValue({ ok: true, data: { id: "i", defects: 0 } });
    enqueue({ id: "s1", userId: "u1", kind: "stop", label: "Arrived pickup · ORD-1 load 2", payload: {} }, store);
    enqueue({ id: "i1", userId: "u1", kind: "inspection", label: "Pre-trip inspection, Truck 101", payload: {} }, store);
    await flushOutbox("u1", sendQueued, store);
    expect(actions.toast.success).toHaveBeenLastCalledWith("2 items saved on this phone were sent to the office: Arrived pickup · ORD-1 load 2; Pre-trip inspection, Truck 101.", expect.objectContaining({ id: "outbox-sent" }));
  });
});
