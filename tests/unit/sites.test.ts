import { describe, expect, it } from "vitest";
import { directionsNeedAttention, directionsStatus } from "@/lib/sites";
import { companySettingsSchema } from "@/lib/schemas/settings";
import { siteSchema } from "@/lib/schemas/customer";

// Mirrors private.site_directions_status (20261115000200; tests/db/site-directions.test.ts checks the database side).
const NOW = Date.parse("2026-10-15T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const none = { site_review_days_standard: null, site_review_days_safety: null };

describe("site directions status", () => {
  it("is none without directions and unverified until someone checks them", () => {
    expect(directionsStatus({ directions: "  ", directions_risk: "safety_access", directions_verified_at: null }, none, NOW)).toBe("none");
    expect(directionsStatus({ directions: null, directions_risk: "standard", directions_verified_at: daysAgo(1) }, none, NOW)).toBe("none");
    expect(directionsStatus({ directions: "Gate 4411", directions_risk: "standard", directions_verified_at: null }, none, NOW)).toBe("unverified");
  });

  it("uses the company's interval for that kind of site, and none means no due date", () => {
    const site = (risk: "standard" | "safety_access", days: number) => ({ directions: "Gate 4411", directions_risk: risk, directions_verified_at: daysAgo(days) });
    expect(directionsStatus(site("standard", 4000), none, NOW)).toBe("verified");
    const intervals = { site_review_days_standard: 90, site_review_days_safety: 30 };
    expect(directionsStatus(site("standard", 60), intervals, NOW)).toBe("verified");
    expect(directionsStatus(site("safety_access", 60), intervals, NOW)).toBe("due");
    expect(directionsStatus(site("safety_access", 29), intervals, NOW)).toBe("verified");
    expect(directionsStatus(site("standard", 91), intervals, NOW)).toBe("due");
  });

  it("flags unverified safety or access directions and anything overdue, not a new standard site", () => {
    expect(directionsNeedAttention("unverified", "safety_access")).toBe(true);
    expect(directionsNeedAttention("due", "standard")).toBe(true);
    expect(directionsNeedAttention("unverified", "standard")).toBe(false);
    expect(directionsNeedAttention("verified", "safety_access")).toBe(false);
    expect(directionsNeedAttention(undefined, "safety_access")).toBe(false);
  });
});

describe("forms", () => {
  const base = { company_name: "Co", timezone: "America/Indiana/Indianapolis", default_tax_rate: "0", quote_validity_days: "30", quote_followup_days: "7" };

  it("leaves the review intervals out when the form does not show them, and empty means no interval", () => {
    const absent = companySettingsSchema.safeParse(base);
    expect(absent.success && "site_review_days_standard" in absent.data && absent.data.site_review_days_standard !== undefined).toBe(false);
    const empty = companySettingsSchema.safeParse({ ...base, site_review_days_standard: "", site_review_days_safety: "30" });
    expect(empty.success && [empty.data.site_review_days_standard, empty.data.site_review_days_safety]).toEqual([null, 30]);
    expect(companySettingsSchema.safeParse({ ...base, site_review_days_safety: "0" }).success).toBe(false);
  });

  it("accepts only the two kinds of directions, and the field is optional", () => {
    const site = { label: "Pit", line1: "1 Rd", state: "IN", postal_code: "" };
    expect(siteSchema.safeParse(site).success).toBe(true);
    expect(siteSchema.safeParse({ ...site, directions_risk: "safety_access" }).success).toBe(true);
    expect(siteSchema.safeParse({ ...site, directions_risk: "urgent" }).success).toBe(false);
  });
});
