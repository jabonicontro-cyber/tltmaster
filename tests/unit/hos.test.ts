import { describe, expect, it } from "vitest";
import { approvalNote, hosApprovalAllowed, hosProvider, NO_HOS_PROVIDER, type HosProvider } from "@/lib/hos";

describe("hours of service in approvals", () => {
  it("has no provider today, so nothing is ever HOS-verified", () => {
    expect(hosProvider().source).toBe("none");
    expect(hosProvider().verified("d1", "2026-10-15")).toBe(false);
  });

  it("refuses an approval without the dispatcher's confirmation unless a provider verified every driver", () => {
    expect(hosApprovalAllowed(NO_HOS_PROVIDER, ["d1"], "2026-10-15", false)).toBe(false);
    expect(hosApprovalAllowed(NO_HOS_PROVIDER, ["d1"], "2026-10-15", true)).toBe(true);
    const partial: HosProvider = { source: "none", verified: (d) => d === "d1" };
    expect(hosApprovalAllowed(partial, ["d1", "d2"], "2026-10-15", false)).toBe(false); // one unknown driver is enough
  });

  it("records on the assignment that a person confirmed, not that Taviron verified", () => {
    expect(approvalNote("Approved Smart Dispatch proposal", true)).toBe("Approved Smart Dispatch proposal; hours of service confirmed by the dispatcher (not verified by Taviron)");
    expect(approvalNote("x".repeat(600), true)).toHaveLength(500);
  });
});
