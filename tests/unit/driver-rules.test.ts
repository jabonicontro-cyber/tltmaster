import { describe, expect, it } from "vitest";
import { DRIVER_TICKET_STATUS, REPORT_KINDS, REPORT_KIND_HELP, REPORT_KIND_LABELS, qualificationReminders, reportNeedsEquipment, siteAddress } from "@/lib/driver/rules";
import { TICKET_STATUSES } from "@/lib/tickets/rules";

describe("driver portal rules", () => {
  it("explains every report kind and ticket status in plain words", () => {
    for (const k of REPORT_KINDS) {
      expect(REPORT_KIND_LABELS[k]).toBeTruthy();
      expect(REPORT_KIND_HELP[k]).toBeTruthy();
    }
    for (const s of TICKET_STATUSES) expect(DRIVER_TICKET_STATUS[s]).toBeTruthy();
    expect(REPORT_KINDS.filter(reportNeedsEquipment)).toEqual(["breakdown", "equipment_issue", "inspection_issue"]);
  });

  it("reminds about missing, expired, expiring and unchecked CDL and medical card", () => {
    const today = "2026-10-10";
    expect(qualificationReminders([], today).map((r) => r.tone)).toEqual(["bad", "bad"]);
    const r = qualificationReminders([
      { kind: "cdl", cdl_class: "A", expires_on: "2026-10-01", verified: true, description: "" },
      { kind: "medical_card", cdl_class: null, expires_on: "2026-10-20", verified: false, description: "" },
    ], today);
    expect(r).toEqual([
      { tone: "bad", text: expect.stringMatching(/CDL expired on 2026-10-01/) },
      { tone: "warn", text: expect.stringMatching(/medical card expires on 2026-10-20/) },
      { tone: "warn", text: expect.stringMatching(/medical card has not been checked/) },
    ]);
    expect(qualificationReminders([
      { kind: "cdl", cdl_class: "A", expires_on: "2028-01-01", verified: true, description: "" },
      { kind: "medical_card", cdl_class: null, expires_on: "2028-01-01", verified: true, description: "" },
    ], today)).toEqual([]);
  });

  it("formats a job-site address without empty parts", () => {
    expect(siteAddress({ label: "North pad", line1: "100 Main St", line2: "", city: "Valparaiso", state: "IN", postal_code: "46383" })).toBe("100 Main St · Valparaiso, IN · 46383");
  });
});
