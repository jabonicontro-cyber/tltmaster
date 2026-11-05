import { describe, expect, it } from "vitest";
import { isLong, median, minutesLabel, summarizeByPlace, waitMinutes, type StopTime } from "@/lib/dispatch/wait-times";

const at = (m: number) => new Date(Date.UTC(2026, 10, 1, 12, m)).toISOString();
const stop = (over: Partial<StopTime>): StopTime => ({ loadId: "l", orderId: "o", orderNumber: "ORD-1", stop: "site", placeKey: "s1", placeLabel: "Site 1", customerName: "C", arrivedAt: at(0), departedAt: at(30), source: "driver", ...over, kind: over.kind ?? (over.stop === "pickup" ? "pickup" : "site") });

describe("wait times", () => {
  it("measures waits and flags only over a set free time", () => {
    expect(waitMinutes(stop({}))).toBe(30);
    expect(waitMinutes(stop({ departedAt: null }))).toBeNull();
    expect(isLong(50, 45)).toBe(true);
    expect(isLong(45, 45)).toBe(false);
    expect(isLong(500, null)).toBe(false);
    expect(median([10, 40, 20])).toBe(20);
    expect(median([10, 20])).toBe(15);
    expect(median([])).toBeNull();
    expect(minutesLabel(65)).toBe("1 h 5 min");
    expect(minutesLabel(45)).toBe("45 min");
  });

  it("groups by place, slowest first, ignoring unfinished stops", () => {
    const rows = [
      stop({ departedAt: at(20) }), stop({ departedAt: at(80) }), stop({ departedAt: null }),
      stop({ placeKey: "s2", placeLabel: "Site 2", departedAt: at(10) }),
      stop({ stop: "pickup", placeKey: null, placeLabel: null, departedAt: at(15) }),
    ];
    const s = summarizeByPlace(rows, 45);
    expect(s.map((p) => p.label)).toEqual(["Site 1", "Pickup not recorded", "Site 2"]);
    expect(s[0]).toMatchObject({ visits: 2, medianMinutes: 50, longest: 80, long: 1, minutesOver: 35 });
    expect(summarizeByPlace(rows, null)[0]).toMatchObject({ long: null, minutesOver: null });
  });
});

describe("wait times at an order's stops (MK2)", () => {
  it("groups freight stops with the pickups or job sites by their kind", () => {
    const rows = [
      stop({ stop: "stop:00000000-0000-4000-8000-000000000001", kind: "pickup", placeKey: "stop:acme steel, gary, in", placeLabel: "Acme Steel, Gary, IN", departedAt: at(50) }),
      stop({ stop: "stop:00000000-0000-4000-8000-000000000002", kind: "pickup", placeKey: "stop:acme steel, gary, in", placeLabel: "Acme Steel, Gary, IN", departedAt: at(70) }),
      stop({ stop: "stop:00000000-0000-4000-8000-000000000003", kind: "site", placeKey: "stop:lakeside, joliet, il", placeLabel: "Lakeside, Joliet, IL", departedAt: at(20) }),
    ];
    const places = summarizeByPlace(rows, 45);
    expect(places.map((p) => [p.label, p.stop, p.visits, p.medianMinutes, p.long])).toEqual([
      ["Acme Steel, Gary, IN", "pickup", 2, 60, 2],
      ["Lakeside, Joliet, IL", "site", 1, 20, 0],
    ]);
  });

  it("recognises a stop key", async () => {
    const { STOP_KEY } = await import("@/lib/dispatch/wait-times");
    expect(STOP_KEY.test("stop:00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(STOP_KEY.test("stop:nope")).toBe(false);
    expect(STOP_KEY.test("site")).toBe(false);
  });
});
