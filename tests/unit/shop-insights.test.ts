import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { freeDays, partsUsuallyNeeded, repeatFailures, type PastJob } from "@/lib/maintenance/insights";

const TODAY = "2026-11-02";
const job = (id: string, unit: string, category: string, daysAgo: number): PastJob => ({ id, unitId: unit, unitLabel: `Truck ${unit}`, category, completedAt: `${addDays(TODAY, -daysAgo)}T12:00:00Z` });

describe("shop insights", () => {
  it("flags three or more same-kind repairs on one truck in 90 days, never PM or inspections", () => {
    const jobs = [job("a", "103", "brakes", 10), job("b", "103", "brakes", 40), job("c", "103", "brakes", 80), job("d", "103", "brakes", 120),
      job("e", "104", "preventive", 5), job("f", "104", "preventive", 30), job("g", "104", "preventive", 60), job("h", "105", "tires", 3), job("i", "105", "tires", 9)];
    expect(repeatFailures(jobs, TODAY)).toEqual([{ unitId: "103", unitLabel: "Truck 103", category: "brakes", count: 3, detail: "3 brake jobs in 90 days — worth finding the root cause." }]);
  });

  it("learns which parts a kind of job usually needs and whether stock covers it", () => {
    const jobs = [job("a", "1", "brakes", 10), job("b", "2", "brakes", 20), job("c", "3", "brakes", 30), job("x", "4", "tires", 5)];
    const uses = [
      { workOrderId: "a", partId: "kit", quantity: 1 }, { workOrderId: "b", partId: "kit", quantity: 2 }, { workOrderId: "c", partId: "kit", quantity: 2 },
      { workOrderId: "a", partId: "fluid", quantity: 1 }, { workOrderId: "x", partId: "tire", quantity: 2 }, { workOrderId: "b", partId: "fluid", quantity: 1 },
      { workOrderId: "c", partId: "rare", quantity: 1 },
    ];
    const stock = [{ id: "kit", name: "Brake shoe kit", unit: "kit", onHand: 1, reorderPoint: 2 }, { id: "fluid", name: "Brake fluid", unit: "qt", onHand: 6, reorderPoint: 2 }, { id: "rare", name: "Rare part", unit: "ea", onHand: 0, reorderPoint: null }, { id: "tire", name: "Tire", unit: "ea", onHand: 8, reorderPoint: 4 }];
    const hints = partsUsuallyNeeded("brakes", jobs, uses, stock);
    expect(hints.map((h) => [h.name, h.usedOn, h.typical, h.short])).toEqual([["Brake shoe kit", 3, 2, true], ["Brake fluid", 2, 1, false]]);
  });

  it("lists the truck's load-free days", () => {
    expect(freeDays([addDays(TODAY, 1), addDays(TODAY, 3)], TODAY, 4)).toEqual([addDays(TODAY, 2), addDays(TODAY, 4)]);
  });
});
