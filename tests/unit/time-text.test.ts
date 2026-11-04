import { describe, expect, it } from "vitest";
import { twelveHour } from "@/lib/time-text";

describe("twelveHour (UX15)", () => {
  it("rewrites 24-hour times in notice titles", () => {
    expect(twelveHour("New load: ORD-1009 load 4 on Tue Nov 3, 15:00–16:00")).toBe("New load: ORD-1009 load 4 on Tue Nov 3, 3:00 PM–4:00 PM");
    expect(twelveHour("7:30–8:30 and 0:15, 12:00")).toBe("7:30 AM–8:30 AM and 12:15 AM, 12:00 PM");
  });
  it("leaves other numbers alone", () => {
    expect(twelveHour("ORD-1009 load 4, 22 ton")).toBe("ORD-1009 load 4, 22 ton");
  });
});
