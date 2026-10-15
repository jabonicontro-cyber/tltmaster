import { describe, expect, it } from "vitest";
import { driverTabs, freshness, isDriverOnly, STALE_AFTER_MS } from "@/lib/companion";

describe("companion app shell", () => {
  it("gives the phone tab bar only to logins whose work is driving", () => {
    expect(isDriverOnly(["driver.portal", "comms.message"])).toBe(true);
    expect(isDriverOnly(["driver.portal", "dispatch.view"])).toBe(false); // dispatcher who also drives keeps the full menu
    expect(isDriverOnly(["driver.portal", "maintenance.view"])).toBe(false);
    expect(isDriverOnly(["comms.message"])).toBe(false);
  });

  it("shows Messages only with comms.message; My Day, Time off and Profile always", () => {
    expect(driverTabs(["driver.portal"]).map((t) => t.label)).toEqual(["My Day", "Time off", "Profile"]);
    expect(driverTabs(["driver.portal", "comms.message"]).map((t) => t.label)).toEqual(["My Day", "Messages", "Time off", "Profile"]);
    const myDay = driverTabs([])[0];
    expect([myDay.match("/driver"), myDay.match("/driver/assignments/x/report"), myDay.match("/drivers")]).toEqual([true, true, false]);
  });

  it("never presents data as current when offline or older than the limit", () => {
    const t = 1_000_000;
    expect(freshness(t, t + 1000, true)).toBe("current");
    expect(freshness(t, t + STALE_AFTER_MS + 1, true)).toBe("stale");
    expect(freshness(t, t + 1000, false)).toBe("offline");
  });
});
