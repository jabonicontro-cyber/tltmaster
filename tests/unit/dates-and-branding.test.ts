import { describe, expect, it } from "vitest";
import { brandingProblems, brandingStyle, contrast, sniffImage } from "@/lib/branding";
import { isIsoDate, isOperationalDate, normalizeTypedDate } from "@/lib/dates";
import { orderDraftInput } from "@/lib/schemas/order";

describe("date entry (N15 regression)", () => {
  it("rejects years that are not four digits or out of range", () => {
    expect(isIsoDate("2026-10-15")).toBe(true);
    expect(isIsoDate("0026-10-15")).toBe(false);
    expect(isIsoDate("202610-10-15")).toBe(false);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isOperationalDate("1999-12-31")).toBe(false);
    expect(isOperationalDate("2026-10-15")).toBe(true);
    expect(isOperationalDate("2100-01-01")).toBe(false);
  });

  it("turns a two-digit year typed into a date field into this century", () => {
    expect(normalizeTypedDate("0026-10-15")).toBe("2026-10-15");
    expect(normalizeTypedDate("2026-10-15")).toBe("2026-10-15");
    expect(normalizeTypedDate("0126-10-15")).toBe("0126-10-15"); // left for validation to reject
    expect(normalizeTypedDate("")).toBe("");
  });

  it("order forms refuse a malformed requested date on the server", () => {
    const base = { customerId: "00000000-0000-4000-8000-000000000001", orderDate: "2026-10-12", lines: [] };
    expect(orderDraftInput.safeParse({ ...base, requestedDate: "2026-10-15" }).success).toBe(true);
    for (const [field, value] of [["requestedDate", "0026-10-15"], ["orderDate", "0026-10-12"], ["requestedDate", "202610-10-15"]]) {
      const r = orderDraftInput.safeParse({ ...base, [field]: value });
      expect(r.success, `${field}=${value}`).toBe(false);
      expect(r.error?.issues.map((i) => i.path.join("."))).toContain(field);
    }
  });
});

describe("company branding", () => {
  it("computes WCAG contrast", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("refuses colors that make white text unreadable, and malformed values", () => {
    expect(brandingProblems({ color: "", sidebarColor: "" })).toEqual({});
    expect(brandingProblems({ color: "#1f6feb", sidebarColor: "#102030" })).toEqual({});
    expect(Object.keys(brandingProblems({ color: "#ffee00", sidebarColor: "#aaaaaa" }))).toEqual(["brand_color", "brand_sidebar_color"]);
    expect(brandingProblems({ color: "red", sidebarColor: "" }).brand_color).toMatch(/#1F6FEB/);
  });

  it("sets only the CSS variables for the colors chosen; unbranded companies keep the defaults", () => {
    expect(brandingStyle({ logo: "", color: "", sidebarColor: "" })).toEqual({});
    const s = brandingStyle({ logo: "", color: "#1f6feb", sidebarColor: "" });
    expect(s["--color-brand"]).toBe("#1f6feb");
    expect(s["--color-brand-dark"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(s["--color-charcoal"]).toBeUndefined();
    // Derived in CSS so they follow light and dark mode.
    expect(s["--color-brand-light"]).toBeUndefined();
    expect(brandingStyle({ logo: "", color: "javascript:alert(1)", sidebarColor: "#zzzzzz" })).toEqual({});
  });

  it("identifies logo images by their bytes, not their name", () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("png");
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniffImage(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
});
