import { describe, expect, it } from "vitest";
import { capacityDays } from "@/lib/portal-booking";

describe("customer booking capacity view (B115)", () => {
  it("lists each day with what was opened and what pending and approved requests took", () => {
    const days = capacityDays("2026-11-02", 3, [{ day: "2026-11-03", loads: 8 }, { day: "2026-11-04", loads: 0 }], [
      { day: "2026-11-03", loads: 3, status: "pending" },
      { day: "2026-11-03", loads: 2, status: "approved" },
      { day: "2026-11-03", loads: 4, status: "declined" },
      { day: "2026-11-03", loads: 1, status: "canceled" },
    ]);
    expect(days).toEqual([
      { day: "2026-11-02", open: null, taken: 0 },
      { day: "2026-11-03", open: 8, taken: 5 },
      { day: "2026-11-04", open: 0, taken: 0 },
    ]);
  });
});
