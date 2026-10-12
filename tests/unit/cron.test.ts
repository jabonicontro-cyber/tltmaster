import { describe, expect, it } from "vitest";
import { authorizedCron, housekeepingFailed } from "@/server/cron";
import { effectivePresence } from "@/lib/communications";

describe("scheduled job authorization", () => {
  const secret = "s3cret-value-long-enough";
  it("accepts only the exact bearer secret", () => {
    expect(authorizedCron(`Bearer ${secret}`, secret)).toBe(true);
    expect(authorizedCron(`Bearer ${secret}x`, secret)).toBe(false);
    expect(authorizedCron(secret, secret)).toBe(false);
    expect(authorizedCron(null, secret)).toBe(false);
  });
  it("refuses everything without a (long enough) secret", () => {
    expect(authorizedCron("Bearer ", undefined)).toBe(false);
    expect(authorizedCron("Bearer short", "short")).toBe(false);
  });
});

describe("own presence", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  it("manual status wins; otherwise Away after the threshold; unknown when never seen", () => {
    expect(effectivePresence({ manual_status: "busy", last_active_at: null }, 15, now)).toBe("busy");
    expect(effectivePresence({ manual_status: null, last_active_at: "2026-10-12T11:50:00Z" }, 15, now)).toBe("available");
    expect(effectivePresence({ manual_status: null, last_active_at: "2026-10-12T11:40:00Z" }, 15, now)).toBe("away");
    expect(effectivePresence({ manual_status: null, last_active_at: null }, 15, now)).toBeNull();
    expect(effectivePresence(null, 15, now)).toBeNull();
  });
});

describe("housekeeping result", () => {
  it("is a failure when any company failed or any expired file could not be removed", () => {
    expect(housekeepingFailed({ failed: [] }, 0)).toBe(false);
    expect(housekeepingFailed({ failed: [{ company_id: "x", error: "boom" }] }, 0)).toBe(true);
    expect(housekeepingFailed({ failed: [] }, 3)).toBe(true);
    expect(housekeepingFailed(null, 0)).toBe(false);
  });
});
