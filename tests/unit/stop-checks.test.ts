// Stops outside the load's window and saved places for stops (owner decisions 2026-11-16/17, WK3): warnings in plain
// words that never block saving; suggestions that put the customer's job sites first; typed places offered for saving.
import { describe, expect, it } from "vitest";
import { canOfferSave, isKnownPlace, matchPlaces, orderLoadWindow, placeKindFor, savedWindowNote, stopWindowWarning, stopWindowWarnings, type LoadWindow, type StopPlace } from "@/lib/orders/stop-checks";
import { emptyStop, type StopInput } from "@/lib/orders/stops";

const win: LoadWindow = { firstDay: "2026-11-20", lastDay: "2026-11-20", start: "07:00", end: "14:00", noun: "load" };
const stop = (kind: "pickup" | "delivery", date: string, from = "", to = ""): StopInput => ({ ...emptyStop(kind), name: "X", appointment_date: date, window_start: from, window_end: to });

describe("stopWindowWarning", () => {
  it("says a stop after the window ends, in the owner's words", () => {
    expect(stopWindowWarning(stop("delivery", "2026-11-20", "15:00", "16:00"), win)).toBe("This stop is after the load's window ends at 2:00 PM.");
    expect(stopWindowWarning(stop("pickup", "2026-11-20", "14:00", "15:00"), win)).toBe("This stop is after the load's window ends at 2:00 PM.");
    expect(stopWindowWarning(stop("delivery", "2026-11-20", "13:00", "15:00"), win)).toBe("This stop runs past the end of the load's window at 2:00 PM.");
  });

  it("checks a delivery against the start too, but lets a pickup load before the window opens", () => {
    expect(stopWindowWarning(stop("delivery", "2026-11-20", "05:00", "06:30"), win)).toBe("This stop is before the load's window starts at 7:00 AM.");
    expect(stopWindowWarning(stop("delivery", "2026-11-20", "06:00", "08:00"), win)).toBe("This stop starts before the load's window opens at 7:00 AM.");
    expect(stopWindowWarning(stop("pickup", "2026-11-20", "05:00", "06:00"), win)).toBeNull();
    expect(stopWindowWarning(stop("pickup", "2026-11-19", "18:00", "19:00"), win)).toBeNull();
  });

  it("says a stop on a day outside the window's days", () => {
    expect(stopWindowWarning(stop("delivery", "2026-11-21"), win)).toBe("This stop is on Nov 21, 2026, after the load's window ends on Nov 20, 2026.");
    expect(stopWindowWarning(stop("delivery", "2026-11-19"), win)).toBe("This stop is on Nov 19, 2026, before the load's window starts on Nov 20, 2026.");
  });

  it("is quiet inside the window and when either side has no window", () => {
    expect(stopWindowWarning(stop("delivery", "2026-11-20", "08:00", "10:00"), win)).toBeNull();
    expect(stopWindowWarning(stop("delivery", "2026-11-20", "08:00", "14:00"), win)).toBeNull();
    expect(stopWindowWarning(stop("delivery", ""), win)).toBeNull();
    expect(stopWindowWarning(stop("delivery", "2026-11-20"), win)).toBeNull();
    expect(stopWindowWarning(stop("delivery", "2026-11-20", "18:00", "19:00"), { ...win, start: null, end: null })).toBeNull();
    expect(stopWindowWarning(stop("delivery", "2030-01-01", "18:00", "19:00"), { firstDay: null, lastDay: null, start: null, end: null, noun: "load" })).toBeNull();
  });

  it("names the order for aggregate companies and numbers the stops after saving", () => {
    const w = orderLoadWindow({ scheduled_start: "2026-11-20", scheduled_end: null, window_start: "07:00:00", window_end: "14:00:00" }, "aggregate");
    expect(w).toEqual({ firstDay: "2026-11-20", lastDay: "2026-11-20", start: "07:00", end: "14:00", noun: "order" });
    expect(orderLoadWindow({ scheduled_start: null, scheduled_end: null, window_start: null, window_end: null }, "freight").noun).toBe("load");
    const list = [stop("pickup", "2026-11-20", "06:00", "07:00"), stop("delivery", "2026-11-20", "15:00", "16:00")];
    const warnings = stopWindowWarnings(list, win);
    expect(warnings).toEqual([{ index: 1, message: "This stop is after the load's window ends at 2:00 PM." }]);
    expect(savedWindowNote(warnings)).toBe("Stop 2 is after the load's window ends at 2:00 PM.");
  });
});

const place = (over: Partial<StopPlace>): StopPlace => ({ key: "location:1", group: "location", name: "North Yard", address_line1: "1 Yard Rd", city: "Gary", state: "IN", postal_code: "46402", label: "Yard", ...over });

describe("saved places", () => {
  const places = [
    place({ key: "location:1" }),
    place({ key: "site:1", group: "site", name: "Lakeside Build", address_line1: "50 Shore Dr", city: "Gary", label: "Customer site" }),
    place({ key: "location:2", name: "Midwest Steel (shipper)", address_line1: "9 Mill St", city: "Portage", label: "Shipper" }),
  ];

  it("suggests the customer's job sites first and matches every typed word against name and address", () => {
    expect(matchPlaces(places, "").map((p) => p.key)).toEqual(["site:1", "location:1", "location:2"]);
    expect(matchPlaces(places, "gary").map((p) => p.key)).toEqual(["site:1", "location:1"]);
    expect(matchPlaces(places, "mill portage").map((p) => p.key)).toEqual(["location:2"]);
    expect(matchPlaces(places, "nowhere")).toEqual([]);
  });

  it("offers to save only a new typed place with a name and a street or town", () => {
    const s = (name: string, address_line1: string, city: string) => ({ name, address_line1, city, state: "", postal_code: "" });
    expect(isKnownPlace(places, s(" north  yard ", "1 yard rd", "GARY"))).toBe(true);
    expect(canOfferSave(places, s("North Yard", "1 Yard Rd", "Gary"))).toBe(false);
    expect(canOfferSave(places, s("New Dock", "", ""))).toBe(false);
    expect(canOfferSave(places, s("", "2 Dock St", "Joliet"))).toBe(false);
    expect(canOfferSave(places, s("New Dock", "", "Joliet"))).toBe(true);
  });

  it("gives a saved place the kind its stop suggests for the company's industry", () => {
    expect(placeKindFor("pickup", "freight")).toBe("shipper");
    expect(placeKindFor("delivery", "both")).toBe("receiver");
    expect(placeKindFor("pickup", "aggregate")).toBe("pickup");
    expect(placeKindFor("delivery", "aggregate")).toBe("other");
  });
});
