import { describe, expect, it } from "vitest";
import { SNAPSHOT_MAX_AGE_MS, clearOffline, enqueue, readDay, readOutbox, removeItem, saveDay, updateItem, type DaySnapshot } from "@/lib/offline/store";

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
