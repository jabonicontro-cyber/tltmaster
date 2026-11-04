import { describe, expect, it } from "vitest";
import { directionsUrl, telUrl } from "@/lib/driver/navigate";

describe("driver navigation links (UX7)", () => {
  it("uses coordinates when known", () => {
    expect(directionsUrl({ address: "1 Quarry Rd", latitude: 41.6, longitude: "-93.6" })).toBe("https://www.google.com/maps/dir/?api=1&destination=41.6%2C-93.6");
  });
  it("falls back to the address, and to nothing", () => {
    expect(directionsUrl({ address: "1 Quarry Rd, Ames, IA", latitude: null, longitude: null })).toBe("https://www.google.com/maps/dir/?api=1&destination=1%20Quarry%20Rd%2C%20Ames%2C%20IA");
    expect(directionsUrl({ address: "  ", latitude: 0, longitude: 0 })).toBeNull();
    expect(directionsUrl({ address: "x", latitude: 200, longitude: 5 })).toContain("destination=x");
  });
  it("builds tel links only for real numbers", () => {
    expect(telUrl("(515) 555-0142")).toBe("tel:5155550142");
    expect(telUrl("+1 515 555 0142")).toBe("tel:+15155550142");
    expect(telUrl("ask office")).toBeNull();
    expect(telUrl(null)).toBeNull();
  });
});
