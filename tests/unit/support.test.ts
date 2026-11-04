import { describe, expect, it } from "vitest";
import { checkSupportFiles, hoursWaiting, isSupportKind, SUPPORT_KINDS } from "@/lib/support";

describe("support center rules (B138)", () => {
  it("knows the four case types", () => {
    expect(Object.values(SUPPORT_KINDS)).toEqual(["Delivery problem", "Billing question", "Wrong material or quantity", "Other"]);
    expect(isSupportKind("billing")).toBe(true);
    expect(isSupportKind("refund")).toBe(false);
  });
  it("checks attachments before sending", () => {
    const ok = { type: "application/pdf", size: 1000 };
    expect(checkSupportFiles([ok, { type: "image/png", size: 10 * 1024 * 1024 }])).toBeNull();
    expect(checkSupportFiles(Array(6).fill(ok))).toMatch(/at most 5/);
    expect(checkSupportFiles([{ type: "text/plain", size: 10 }])).toMatch(/photos .* or PDFs/);
    expect(checkSupportFiles([{ type: "image/jpeg", size: 10 * 1024 * 1024 + 1 }])).toMatch(/10 MB/);
  });
  it("counts whole hours waiting", () => {
    expect(hoursWaiting("2026-11-04T08:00:00Z", new Date("2026-11-04T13:59:00Z"))).toBe(5);
  });
});
