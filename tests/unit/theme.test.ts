import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast } from "@/lib/branding";
import { THEME_SCRIPT, parseTheme, resolveTheme } from "@/lib/theme";

// The dark palette lives in globals.css; read it from there so this test checks what ships.
const css = readFileSync("src/app/globals.css", "utf8");
const block = css.slice(css.indexOf('html[data-theme="dark"] body {'));
const dark = Object.fromEntries([...block.slice(0, block.indexOf("}")).matchAll(/--color-([a-z]+(?:-\d+)?):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]));

describe("light and dark mode", () => {
  it("parses and resolves the saved choice", () => {
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("anything else")).toBe("system");
    expect(parseTheme(null)).toBe("system");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(THEME_SCRIPT).toContain("taviron-theme");
  });

  it("keeps text readable in dark mode (WCAG AA 4.5:1)", () => {
    expect(Object.keys(dark).length).toBeGreaterThan(20);
    for (const bg of [dark.card, dark.surface]) {
      expect(contrast(dark.ink, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(dark.muted, bg)).toBeGreaterThanOrEqual(4.5);
    }
    // Status text on its own tinted background, and on a plain card.
    for (const hue of ["red", "amber", "green", "blue"]) {
      for (const shade of ["700", "800", "900"]) {
        expect(contrast(dark[`${hue}-${shade}`], dark[`${hue}-50`]), `${hue}-${shade}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(dark[`${hue}-${shade}`], dark.card), `${hue}-${shade} on card`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Selected chips: white text on "strong", and the chip visible against a card (3:1).
    const strong = /--color-strong:\s*(#[0-9a-f]{6})/.exec(css.slice(css.indexOf('html[data-theme="dark"] .app-root')))![1];
    expect(contrast(strong, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(strong, dark.card)).toBeGreaterThanOrEqual(3);
  });

  it("never re-colors the critical (urgency) red", () => {
    expect(block).not.toContain("--color-critical");
  });
});
