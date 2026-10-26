import { describe, expect, it } from "vitest";
import { proposePreviousCrews, type PastCrew } from "@/lib/dispatch/board";

const crew = (order: string, date: string, at: string, truck: string, driver: string, trailer: string | null = null): PastCrew => ({ order_id: order, load_date: date, starts_at: `${date}T${at}:00Z`, truck_id: truck, driver_id: driver, trailer_id: trailer });

describe("proposePreviousCrews", () => {
  it("copies the most recent earlier day's crews to today's open loads in time order", () => {
    const past = [crew("o1", "2026-10-20", "07:00", "t-old", "d-old"), crew("o1", "2026-10-23", "08:00", "t2", "d2"), crew("o1", "2026-10-23", "07:00", "t1", "d1", "r1")];
    const open = [{ id: "l2", order_id: "o1", starts_at: "2026-10-26T09:00:00Z" }, { id: "l1", order_id: "o1", starts_at: "2026-10-26T07:00:00Z" }];
    expect(proposePreviousCrews(open, past)).toEqual([
      { load_id: "l1", truck_id: "t1", trailer_id: "r1", driver_id: "d1", from_date: "2026-10-23" },
      { load_id: "l2", truck_id: "t2", trailer_id: null, driver_id: "d2", from_date: "2026-10-23" },
    ]);
  });

  it("cycles through the crews when today has more loads, and counts each truck/driver pair once", () => {
    const past = [crew("o1", "2026-10-23", "07:00", "t1", "d1"), crew("o1", "2026-10-23", "10:00", "t1", "d1")];
    const open = ["07", "09", "11"].map((h, i) => ({ id: `l${i}`, order_id: "o1", starts_at: `2026-10-26T${h}:00:00Z` }));
    expect(proposePreviousCrews(open, past).map((p) => p.truck_id)).toEqual(["t1", "t1", "t1"]);
  });

  it("proposes nothing for orders without an earlier crew", () => {
    expect(proposePreviousCrews([{ id: "l1", order_id: "o2", starts_at: "2026-10-26T07:00:00Z" }], [crew("o1", "2026-10-23", "07:00", "t1", "d1")])).toEqual([]);
  });
});
