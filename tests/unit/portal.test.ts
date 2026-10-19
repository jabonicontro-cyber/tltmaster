import { describe, expect, it } from "vitest";
import { formatDay, formatQuantity, formatTime, isPortalSlug, isPortalToken, responseLabel, scheduleText } from "@/lib/portal";
import { PORTAL_GENERAL_HELP } from "@/lib/portal-help";
import { LAB_VIEWS, latestCheck } from "@/lib/platform/testing-lab";
import { PREVIEW_ROLES } from "@/lib/platform/preview";

describe("customer portal formatting", () => {
  it("shows calendar dates without shifting them by time zone", () => {
    expect(formatDay("2026-10-21")).toBe("Oct 21, 2026");
    expect(formatDay(null)).toBe("");
    expect(formatTime("07:00:00")).toBe("7:00 AM");
    expect(formatTime("13:30:00")).toBe("1:30 PM");
    expect(formatTime("00:05:00")).toBe("12:05 AM");
  });

  it("describes a schedule only when one exists (never an invented date)", () => {
    expect(scheduleText({ scheduled_start: null, scheduled_end: null, window_start: null, window_end: null, requested_date: "2026-10-30" })).toBeNull();
    expect(scheduleText({ scheduled_start: "2026-10-21", scheduled_end: "2026-10-21", window_start: "07:00:00", window_end: "10:00:00", requested_date: null })).toBe("Oct 21, 2026, 7:00 AM–10:00 AM");
    expect(scheduleText({ scheduled_start: "2026-10-21", scheduled_end: "2026-10-23", window_start: null, window_end: null, requested_date: null })).toBe("Oct 21, 2026 – Oct 23, 2026");
  });

  it("labels the customer's quote answer from its state", () => {
    expect(responseLabel("accept:pending")).toBe("You accepted — waiting for confirmation");
    expect(responseLabel("decline:confirmed")).toBe("You declined — confirmed");
    expect(responseLabel("accept:dismissed")).toBeNull();
    expect(responseLabel(null)).toBeNull();
  });

  it("accepts only exact slugs and 64-hex tokens", () => {
    expect(isPortalSlug("top-line-trucking")).toBe(true);
    expect(isPortalSlug("../admin")).toBe(false);
    expect(isPortalSlug("A")).toBe(false);
    expect(isPortalToken("a".repeat(64))).toBe(true);
    expect(isPortalToken("a".repeat(63))).toBe(false);
    expect(isPortalToken("g".repeat(64))).toBe(false);
    expect(formatQuantity(12.5, "tons")).toBe("12.5 tons");
  });

  it("general help never states a company's business rules", () => {
    for (const a of PORTAL_GENERAL_HELP) expect(a.body).not.toMatch(/\$\d|per ton|net \d+|fee|surcharge/i);
  });
});

describe("Testing Lab catalog", () => {
  it("every role view uses a real preview role; keys are unique", () => {
    const keys = LAB_VIEWS.map((v) => v.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const v of LAB_VIEWS) if (v.open.kind === "role" && v.open.role) expect(PREVIEW_ROLES).toContain(v.open.role);
  });

  it("a view that is not implemented or blocked says why, and is not offered as openable", () => {
    for (const v of LAB_VIEWS.filter((x) => x.implementation !== "available")) {
      expect(v.note, v.key).toBeTruthy();
      expect(v.open.kind, v.key).toBe("none");
    }
  });

  it("the latest check is per company and newest first", () => {
    const checks = [
      { view_key: "a", company_id: "c1", checked_at: "2026-10-19T10:00:00Z", status: "failing" },
      { view_key: "a", company_id: "c1", checked_at: "2026-10-19T11:00:00Z", status: "tested" },
      { view_key: "a", company_id: "c2", checked_at: "2026-10-19T12:00:00Z", status: "blocked" },
    ];
    expect(latestCheck(checks, "a", "c1")?.status).toBe("tested");
    expect(latestCheck(checks, "a", "c2")?.status).toBe("blocked");
    expect(latestCheck(checks, "b", "c1")).toBeNull();
  });
});
