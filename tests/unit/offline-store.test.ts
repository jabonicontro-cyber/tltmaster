import { describe, expect, it } from "vitest";
import { SNAPSHOT_MAX_AGE_MS, clearOffline, enqueue, flushOutbox, outboxTime, readDay, readOutbox, removeItem, saveDay, updateItem, type DaySnapshot } from "@/lib/offline/store";

// Offline driver app (B133): what is kept on the phone, for whom, for how long, and that sign-out removes it.
function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), size: () => m.size };
}
const day = (userId: string, savedAt: string): DaySnapshot => ({ userId, savedAt, today: "2026-11-02", timezone: "America/Chicago", driverName: "Drew", loads: [], units: [], inspectionTrucks: [] });

describe("offline store", () => {
  it("keeps the day for its person only, and not once it is too old", () => {
    const s = fakeStorage();
    const now = Date.parse("2026-11-02T15:00:00Z");
    saveDay(day("u1", "2026-11-02T13:00:00Z"), s);
    expect(readDay(now, "u1", s)?.userId).toBe("u1");
    expect(readDay(now, "u2", s)).toBeNull();
    expect(readDay(now, null, s)?.userId).toBe("u1"); // the offline page does not know who is signed in
    expect(readDay(Date.parse("2026-11-02T13:00:00Z") + SNAPSHOT_MAX_AGE_MS + 1, "u1", s)).toBeNull();
  });

  it("queues each item once, per person, in order; marks refusals; removes sent items", () => {
    const s = fakeStorage();
    enqueue({ id: "a", userId: "u1", kind: "ticket", label: "Ticket", payload: { q: 1 } }, s);
    enqueue({ id: "a", userId: "u1", kind: "ticket", label: "Ticket", payload: { q: 1 } }, s); // double tap
    enqueue({ id: "b", userId: "u1", kind: "stop", label: "Arrived", payload: {} }, s);
    enqueue({ id: "c", userId: "u2", kind: "inspection", label: "Pre-trip", payload: {} }, s);
    expect(readOutbox("u1", s).map((i) => [i.id, i.status])).toEqual([["a", "waiting"], ["b", "waiting"]]);
    expect(readOutbox("u2", s).map((i) => i.id)).toEqual(["c"]);
    updateItem("b", { status: "failed", error: "Tap Arrived first." }, s);
    expect(readOutbox("u1", s)[1]).toMatchObject({ status: "failed", error: "Tap Arrived first." });
    removeItem("a", s);
    expect(readOutbox("u1", s).map((i) => i.id)).toEqual(["b"]);
  });

  it("sign-out removes the day and everything queued", () => {
    const s = fakeStorage();
    saveDay(day("u1", new Date().toISOString()), s);
    enqueue({ id: "a", userId: "u1", kind: "ticket", label: "Ticket", payload: {} }, s);
    clearOffline(s);
    expect(s.size()).toBe(0);
  });

  it("a phone that refuses storage reports it instead of failing", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => undefined };
    expect(saveDay(day("u1", new Date().toISOString()), broken)).toBe(false);
    expect(enqueue({ id: "a", userId: "u1", kind: "ticket", label: "x", payload: {} }, broken)).toBe(false);
    expect(readOutbox("u1", broken)).toEqual([]);
  });
});

describe("outbox times and sending (B133)", () => {
  it("shows when an item was saved in the company's time zone, not the phone's or UTC", () => {
    expect(outboxTime("2026-11-03T05:12:00Z", "America/Chicago")).toBe("11:12 PM");
    expect(outboxTime("2026-11-03T05:12:00Z", "UTC")).toBe("5:12 AM");
    expect(outboxTime("2026-11-03T05:12:00Z", "Not/AZone")).not.toBe(""); // an unknown zone falls back to the phone's clock
    expect(outboxTime("not a date", "America/Chicago")).toBe("");
  });

  it("sends oldest first, keeps refused items with their message, and stops when there is no connection", async () => {
    const s = fakeStorage();
    for (const id of ["a", "b", "c", "d"]) enqueue({ id, userId: "u1", kind: "stop", label: id, payload: {} }, s);
    enqueue({ id: "x", userId: "u2", kind: "stop", label: "x", payload: {} }, s);
    const seen: string[] = [];
    const r = await flushOutbox("u1", async (i) => {
      seen.push(i.id);
      if (i.id === "b") return { sent: false, network: false, error: "Load is closed." };
      if (i.id === "c") return { sent: false, network: true };
      return { sent: true };
    }, s);
    expect(seen).toEqual(["a", "b", "c"]); // d waits: no connection at c
    expect(r).toEqual({ sent: 1, failed: 1, network: true });
    expect(readOutbox("u1", s).map((i) => [i.id, i.status, i.error ?? null])).toEqual([["b", "failed", "Load is closed."], ["c", "waiting", null], ["d", "waiting", null]]);
    expect(readOutbox("u2", s)).toHaveLength(1); // someone else's items are never sent

    const again = await flushOutbox("u1", async () => ({ sent: true }), s);
    expect(again).toEqual({ sent: 2, failed: 0, network: false }); // the refused one is not retried by itself
    expect(readOutbox("u1", s).map((i) => i.id)).toEqual(["b"]);
  });
});
