import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/safe-redirect";
import { PUBLIC_WEBSITE_URL } from "@/lib/site/urls";

describe("redirect targets", () => {
  it("keeps same-site paths", () => {
    expect(safeNextPath("/orders?status=open#top")).toBe("/orders?status=open#top");
  });

  it("refuses anything that a browser could resolve to another site", () => {
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "/\r\n/evil.example", "/\u0000/x", "orders", ""]) {
      expect(safeNextPath(bad, "/fallback"), JSON.stringify(bad)).toBe("/fallback");
    }
    expect(safeNextPath(null, "/fallback")).toBe("/fallback");
  });
});

describe("public website address", () => {
  it("is the production domain over HTTPS, never the preview address", () => {
    expect(PUBLIC_WEBSITE_URL).toBe("https://mytaviron.com");
    expect(PUBLIC_WEBSITE_URL).not.toMatch(/vercel\.app/);
  });
});
