import { describe, expect, it } from "vitest";
import { currentReading, ignoredReadingText, readingsToList } from "@/lib/fleet/readings";
import { lastPriceCorrection, priceCheckRow, priceConfirmedMessage } from "@/lib/orders/price-check";
import { unitSingular } from "@/lib/units";
import { orderReasonMissing } from "@/lib/orders/status";
import { urgencyNextStep, URGENCY_NEXT_OWNER } from "@/lib/orders/urgency";
import { alertMainAction } from "@/lib/communications";
import { parkedAfterJobMessage } from "@/lib/maintenance";
import { gettingStartedItems } from "@/lib/getting-started";
import { groupKey, moneyRoles, recoveryCodesText } from "@/lib/mfa-policy";

// First-day walkthrough of release 4912577 (2026-11-11): the pure rules behind the visible fixes.

const r = (id: string, miles: number | null, at: string, aside = false, hours: number | null = null) => ({ id, odometer_miles: miles, engine_hours: hours, read_at: at, set_aside_at: aside ? "2026-11-11T08:00:00Z" : null });

describe("truck readings: the current reading is the highest not marked wrong, over every reading", () => {
  // The newest 20 by date leave out an old wrong reading that is higher than everything since.
  const newest = [r("n1", 235_341, "2026-11-11T07:31:00Z"), r("n2", 235_143, "2026-11-10T07:31:00Z")];
  const old = r("old", 236_466, "2026-11-01T07:00:00Z");

  it("takes the server's highest reading when given, not only the loaded rows", () => {
    const c = currentReading(newest, { odometer: old, hours: null });
    expect(c.odometer_miles).toBe(236_466);
    expect(c.setBy.map((x) => x.id)).toEqual(["old"]);
  });

  it("works from the loaded rows before the set-aside update (no server answer)", () => {
    expect(currentReading(newest, null).odometer_miles).toBe(235_341);
  });

  it("never counts a reading marked wrong; the latest one wins among equal values", () => {
    const rows = [r("a", 100_000, "2026-11-01T00:00:00Z"), r("b", 101_900, "2026-11-02T00:00:00Z", true), r("c", 100_000, "2026-11-03T00:00:00Z")];
    const c = currentReading(rows);
    expect(c.odometer_miles).toBe(100_000);
    expect(c.setBy[0].id).toBe("c");
  });

  it("lists the reading that sets the current one first (so it can be marked wrong), then the newest others", () => {
    const list = readingsToList(newest, currentReading(newest, { odometer: old, hours: null }), 2);
    expect(list.map((x) => [x.id, x.isCurrent])).toEqual([["old", true], ["n1", false]]);
  });

  it("miles and hours from different readings: both are listed first, once each", () => {
    const m = r("m", 120_000, "2026-11-01T00:00:00Z");
    const h = r("h", null, "2026-11-02T00:00:00Z", false, 6_000);
    const c = currentReading([m, h], { odometer: m, hours: h });
    expect(c).toMatchObject({ odometer_miles: 120_000, engine_hours: 6_000 });
    expect(readingsToList([m, h], c).map((x) => x.id)).toEqual(["m", "h"]);
  });

  it("formats the numbers of a reading not used: 236,466 mi, never 236466.0", () => {
    expect(ignoredReadingText({ summary: "x", details: { value: 235_416, current: "236466.0", kind: "odometer", why: "lower", source: "trip_sheet" } }))
      .toBe("Odometer 235,416 mi from a trip sheet was not used: lower than the current reading at the time, 236,466 mi.");
    expect(ignoredReadingText({ summary: "x", details: { value: 9_000, current: 6_000.5, kind: "engine_hours", why: "implausible", source: "fuel" } }))
      .toBe("Engine hours 9,000 from a fuel entry were not used: too far above the current reading at the time, 6,000.5 h.");
    // An older row without details keeps its summary, with the numbers formatted.
    expect(ignoredReadingText({ summary: "Odometer 100250.0 mi from a fuel entry on truck 102 was not used: lower than the current 236466.0 mi.", details: null }))
      .toBe("Odometer 100,250 mi from a fuel entry on truck 102 was not used: lower than the current 236,466 mi.");
  });
});

describe("price to check", () => {
  it("one Command Center row for the office, opening the filtered Orders list; none when nothing waits or it cannot be read", () => {
    expect(priceCheckRow(null)).toBeNull();
    expect(priceCheckRow([])).toBeNull();
    expect(priceCheckRow([{ order_number: "ORD-1030", customer_name: "Harlow Homes" }, { order_number: "ORD-1031", customer_name: null }]))
      .toMatchObject({ label: "Price to check", count: 2, urgent: 0, example: "ORD-1030, Harlow Homes", href: "/orders?price=check" });
  });

  it("finds the latest correction in the order's history", () => {
    expect(lastPriceCorrection([{ action: "order.price_checked", occurred_at: "2026-11-11T10:00:00Z", actor_id: "u1" }])).toBeNull();
    expect(lastPriceCorrection([
      { action: "order.price_corrected", occurred_at: "2026-11-11T09:00:00Z", actor_id: "u1" },
      { action: "order.price_corrected", occurred_at: "2026-11-11T10:00:00Z", actor_id: "u2" },
    ])).toEqual({ at: "2026-11-11T10:00:00Z", actorId: "u2" });
  });

  it("says billing can go ahead only when it can; otherwise what it waits for", () => {
    expect(priceConfirmedMessage({ confirmed: false, corrected: 0 }, null)).toBe("The price was already confirmed.");
    expect(priceConfirmedMessage({ confirmed: true, corrected: 0 }, { readiness: "blocked", tickets_accepted: 0 })).toBe("Price checked. Billing can go ahead once the loads are delivered.");
    expect(priceConfirmedMessage({ confirmed: true, corrected: 1 }, { readiness: "blocked", tickets_accepted: 0 })).toBe("Price corrected and confirmed. Billing can go ahead once the loads are delivered.");
    expect(priceConfirmedMessage({ confirmed: true, corrected: 0 }, { readiness: "ready", tickets_accepted: 3 })).toBe("Price checked. The order can be billed.");
    expect(priceConfirmedMessage({ confirmed: true, corrected: 0 }, { readiness: "needs_review", tickets_accepted: 2 })).toMatch(/other billing checks/);
    expect(priceConfirmedMessage({ confirmed: true, corrected: 0 }, null)).toBe("Price checked.");
    // A draft has no billing row: nothing has run, so nothing is delivered yet.
    expect(priceConfirmedMessage({ confirmed: true, corrected: 1 }, null, "draft")).toBe("Price corrected and confirmed. Billing can go ahead once the loads are delivered.");
    expect(priceConfirmedMessage({ confirmed: true, corrected: 0 }, null, "completed")).toBe("Price checked.");
  });
});

describe("plain words", () => {
  it("units in the singular for rates: $/load, never $/loads", () => {
    expect(unitSingular("Loads", "load")).toBe("load");
    expect(unitSingular("Tons", "ton")).toBe("ton");
    expect(unitSingular("Cubic yards", "cu yd")).toBe("cubic yard");
    expect(unitSingular("Hours", "hr")).toBe("hour");
    expect(unitSingular("Each", "ea")).toBe("each");
    expect(unitSingular("Boxes", "box")).toBe("box");
    expect(unitSingular("Batteries", "batt")).toBe("batt");
    expect(unitSingular("", "")).toBe("unit");
  });

  it("canceling or holding an order needs a reason, said in plain words", () => {
    expect(orderReasonMissing("canceled", "  ")).toBe("Say why the order is canceled.");
    expect(orderReasonMissing("on_hold", "")).toBe("Say why the order is put on hold.");
    expect(orderReasonMissing("canceled", "Entered twice")).toBeNull();
    expect(orderReasonMissing("confirmed", "")).toBeNull();
  });

  it("the person who flagged an order urgent is not told to wait for someone else", () => {
    expect(urgencyNextStep("awaiting_acknowledgement", { flaggedIt: false, canAcknowledge: true })).toBe(URGENCY_NEXT_OWNER.awaiting_acknowledgement);
    expect(urgencyNextStep("awaiting_acknowledgement", { flaggedIt: true, canAcknowledge: true })).toMatch(/^You flagged this; it is on the board for dispatch\. Acknowledge it/);
    expect(urgencyNextStep("awaiting_acknowledgement", { flaggedIt: true, canAcknowledge: false })).toBe("You flagged this; it is on the board for dispatch to acknowledge.");
    expect(urgencyNextStep("evaluating", { flaggedIt: true, canAcknowledge: true })).toBe(URGENCY_NEXT_OWNER.evaluating);
  });

  it("a certificate alert leads to the fix, not to Acknowledge", () => {
    expect(alertMainAction({ event_type: "documents.certificate_check", title: "Check the inspection certificate of truck 109", link: "/fleet/trucks/abc" }))
      .toEqual({ label: "Open truck 109 to check it", href: "/fleet/trucks/abc" });
    expect(alertMainAction({ event_type: "documents.certificate_check", title: "Check the inspection certificate of trailer B-31", link: "/fleet/trailers/x" })!.label).toBe("Open trailer B-31 to check it");
    expect(alertMainAction({ event_type: "documents.expiring", title: "x", link: "/fleet/trucks/abc" })).toBeNull();
    expect(alertMainAction({ event_type: "documents.certificate_check", title: "x", link: "https://example.com" })).toBeNull();
  });

  it("after the last job on a parked unit: ask those who may put it back; tell others who does", () => {
    expect(parkedAfterJobMessage("truck", "104", true)).toBe("Truck 104 is still parked. Put it back in service?");
    expect(parkedAfterJobMessage("trailer", "B-31", false)).toBe("Trailer B-31 is still parked. Ask the office or shop to put it back in service.");
  });
});

describe("getting started (mechanic)", () => {
  it("Open a job ticks itself once a timer was started or stopped on a job", () => {
    const job = (f: Parameters<typeof gettingStartedItems>[1]) => gettingStartedItems("mechanic", f, () => true).find((i) => i.key === "job")!;
    expect(job({}).done).toBeNull();
    expect(job({ myTimerStarted: true, myTimerStopped: true }).done).toBe(true);
    expect(job({ myTimerStarted: false, myTimerStopped: false }).done).toBeNull();
  });
});

describe("two-step verification", () => {
  it("names the roles holding a money permission, with their active people", () => {
    const roles = moneyRoles(
      [
        { role: "owner", permission: "billing.manage" }, { role: "owner", permission: "orders.edit" },
        { role: "office", permission: "billing.view" }, { role: "dispatcher", permission: "orders.create" },
        { role: "office", permission: "pricing.something_new" },
      ],
      [
        { id: "1", name: "Omar Office", role: "office", active: true }, { id: "2", name: "Old Office", role: "office", active: false },
        { id: "3", name: "Daniel", role: "dispatcher", active: true }, { id: "4", name: "Ann Owner", role: "owner", active: true },
      ],
    );
    expect(roles).toEqual([
      { role: "owner", permissions: ["billing.manage"], people: [{ id: "4", name: "Ann Owner" }] },
      { role: "office", permissions: ["billing.view", "pricing.something_new"], people: [{ id: "1", name: "Omar Office" }] },
    ]);
  });

  it("shows the setup key in groups of four and the recovery codes as a text file", () => {
    expect(groupKey("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")).toBe("ABCD EFGH IJKL MNOP QRST UVWX YZ23 4567");
    expect(groupKey("ABCDEF")).toBe("ABCD EF");
    expect(recoveryCodesText(["aaaaa-bbbbb", "ccccc-ddddd"]).split("\n")).toEqual(["Taviron recovery codes", expect.stringContaining("works once"), "", "aaaaa-bbbbb", "ccccc-ddddd", ""]);
  });
});
