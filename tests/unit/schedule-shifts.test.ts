import { describe, expect, it } from "vitest";
import { cellText, shiftLine, staffingForecast, timelineBar, type ShiftDay } from "@/lib/schedule/shifts";

const day = (over: Partial<ShiftDay>): ShiftDay => ({ date: "2026-11-02", status: "shift", start: "06:00", end: "16:30", overnight: false, breakMinutes: 30, ...over });

describe("shift text", () => {
  it("writes the grid cell and the My Day line", () => {
    expect(cellText(day({}))).toBe("6a–4:30p");
    expect(shiftLine(day({}))).toBe("6:00 AM – 4:30 PM · 30 min break");
    expect(shiftLine(day({ start: "22:00", end: "06:00", overnight: true, breakMinutes: 0 }))).toBe("10:00 PM – 6:00 AM (next day)");
    expect(shiftLine(day({ status: "off" }))).toBe("Day off");
    expect(shiftLine(day({ status: "none" }))).toBeNull();
    expect(shiftLine(undefined)).toBeNull();
  });
});

describe("day timeline", () => {
  it("places a shift in minutes and cuts an overnight shift at midnight", () => {
    expect(timelineBar(day({}))).toEqual({ from: 360, to: 990, continues: false });
    expect(timelineBar(day({ start: "22:00", end: "06:00", overnight: true }))).toEqual({ from: 1320, to: 1440, continues: true });
    expect(timelineBar(day({ status: "off" }))).toBeNull();
  });
});

describe("staffing forecast", () => {
  const dates = ["2026-11-02", "2026-11-03"];
  const people = [
    { driverId: "d1", days: [day({}), day({ date: "2026-11-03", status: "off" })] },
    { driverId: "d2", days: [day({}), day({ date: "2026-11-03", status: "none" })] },
    { driverId: null, days: [day({}), day({ date: "2026-11-03" })] }, // office: not a driver
  ];
  it("counts drivers on shift and loads per day, and leaves non-drivers out", () => {
    expect(staffingForecast(people, dates, { "2026-11-02": 5, "2026-11-03": 2 })).toEqual([
      { date: "2026-11-02", drivers: 2, unknown: 0, loads: 5, perDriver: 2.5 },
      { date: "2026-11-03", drivers: 0, unknown: 1, loads: 2, perDriver: null },
    ]);
  });
  it("says loads are unknown when they could not be read", () => {
    expect(staffingForecast(people, dates, null)[0].loads).toBeNull();
  });
});
