import { describe, expect, it } from "vitest";
import { iftaCsv, iftaSummary, quarterOf, quarterRange } from "@/lib/fuel/ifta";

describe("IFTA summary (B130)", () => {
  it("adds miles and gallons per state, uses the fleet MPG and nets taxable against bought gallons", () => {
    const s = iftaSummary(
      [{ jurisdiction: "IA", miles: 500 }, { jurisdiction: "NE", miles: 100 }, { jurisdiction: "IA", miles: 400 }],
      [{ jurisdiction: "IA", gallons: 150 }, { jurisdiction: "NE", gallons: 50 }],
    );
    expect([s.miles, s.gallons, s.mpg]).toEqual([1000, 200, 5]);
    expect(s.rows).toEqual([
      { jurisdiction: "IA", miles: 900, gallonsBought: 150, taxableGallons: 180, netGallons: 30 },
      { jurisdiction: "NE", miles: 100, gallonsBought: 50, taxableGallons: 20, netGallons: -30 },
    ]);
    expect(iftaCsv(s, "2026 Q4")).toContain("IA,900,150,180,30");
  });

  it("does not guess MPG without fuel, and lists states with fuel but no miles", () => {
    const s = iftaSummary([{ jurisdiction: "IA", miles: 300 }], []);
    expect(s.mpg).toBeNull();
    expect(s.rows[0]).toEqual({ jurisdiction: "IA", miles: 300, gallonsBought: 0, taxableGallons: null, netGallons: null });
    expect(iftaSummary([], [{ jurisdiction: "MO", gallons: 40 }]).rows).toEqual([{ jurisdiction: "MO", miles: 0, gallonsBought: 40, taxableGallons: null, netGallons: null }]);
  });

  it("knows quarter boundaries", () => {
    expect(quarterRange(2026, 4)).toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(quarterRange(2028, 1)).toEqual({ from: "2028-01-01", to: "2028-03-31" });
    expect(quarterOf("2026-11-02")).toEqual({ year: 2026, quarter: 4 });
  });
});
