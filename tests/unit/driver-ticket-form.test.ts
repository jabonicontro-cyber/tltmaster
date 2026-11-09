import { describe, expect, it } from "vitest";
import { TICKET_FIELD_IDS, TICKET_FIELD_ORDER, clearTicketErrors, firstTicketError, preselectedUnit, serverTicketErrors, ticketFormErrors } from "@/lib/driver/ticket-form";
import { defaultReportEquipment } from "@/lib/driver/rules";

// The driver's ticket form and problem report: what is checked before sending, where a failed send takes the driver,
// errors clearing as fields change, and the obvious single choices made for them.
const ok = { lineId: "l1", quantity: "21.5", unit: "ton", time: "08:30", photos: { busy: false, failed: false } };

describe("driver ticket form", () => {
  it("lists every missing field, and the first one on the form is where a failed send goes", () => {
    const e = ticketFormErrors({ lineId: "", quantity: "", unit: "", time: "", photos: { busy: false, failed: false } });
    expect(Object.keys(e).sort()).toEqual(["line", "quantity", "time", "unit"]);
    expect(firstTicketError(e)).toBe("line");
    expect(firstTicketError(ticketFormErrors({ ...ok, time: "" }))).toBe("time");
    expect(firstTicketError(ticketFormErrors(ok))).toBeNull();
    expect(ticketFormErrors({ ...ok, photos: { busy: true, failed: false } }).photos).toMatch(/Wait/);
    for (const f of TICKET_FIELD_ORDER) expect(TICKET_FIELD_IDS[f]).toMatch(/^d-/);
  });

  it("clears only the changed field's error, and keeps the same object when there is nothing to clear", () => {
    const e = { unit: "Tap the unit on the paper ticket.", time: "Enter the delivery time." };
    expect(clearTicketErrors(e, "unit")).toEqual({ time: "Enter the delivery time." });
    expect(clearTicketErrors(e, "quantity")).toBe(e);
    expect(clearTicketErrors(clearTicketErrors(e, "unit"), "time")).toEqual({});
  });

  it("shows the server's field messages under the form's own fields", () => {
    expect(serverTicketErrors({ orderLineId: "Choose what you delivered.", unitCode: "Tap the unit", deliveredTime: "Enter the delivery time.", deliveredDate: "Bad date", quantity: "Too much", other: "ignored" }))
      .toEqual({ line: "Choose what you delivered.", unit: "Tap the unit", time: "Enter the delivery time.", date: "Bad date", quantity: "Too much" });
    expect(serverTicketErrors(undefined)).toEqual({});
  });

  it("chooses the order line's unit when the company offers it, and nothing otherwise", () => {
    const units = [{ code: "ton" }, { code: "load" }];
    expect(preselectedUnit({ unit_code: "load" }, units)).toBe("load");
    expect(preselectedUnit({ unit_code: "hour" }, units)).toBe("");
    expect(preselectedUnit(undefined, units)).toBe("");
  });
});

describe("report a problem", () => {
  it("chooses the truck only when it is the one piece of equipment", () => {
    expect(defaultReportEquipment("101", null)).toBe("truck");
    expect(defaultReportEquipment("101", "T-7")).toBe("");
    expect(defaultReportEquipment(null, null)).toBe("");
  });
});
