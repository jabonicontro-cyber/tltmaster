import { describe, expect, it } from "vitest";
import { A11Y_DEFAULTS, A11Y_KEY, A11Y_SCRIPT, accessibilityAttributes, isDefaultAccessibility, parseAccessibility } from "@/lib/accessibility";

// Accessibility mode (owner 2026-11-05, UX19): settings are parsed safely, mapped to the <html> attributes globals.css
// reads, and the before-paint script applies the same attributes as the app.
describe("accessibility settings", () => {
  it("keeps only known values and falls back to the defaults", () => {
    expect(parseAccessibility(null)).toEqual(A11Y_DEFAULTS);
    expect(parseAccessibility({ textSize: 999, highContrast: "yes", extra: 1 })).toEqual(A11Y_DEFAULTS);
    expect(parseAccessibility({ textSize: 130, highContrast: true, reduceMotion: true, readableFont: true })).toEqual({ textSize: 130, highContrast: true, reduceMotion: true, readableFont: true });
    expect(isDefaultAccessibility(A11Y_DEFAULTS)).toBe(true);
  });

  it("maps settings to <html> attributes, absent when off", () => {
    expect(accessibilityAttributes(A11Y_DEFAULTS)).toEqual({ "data-text-size": undefined, "data-contrast": undefined, "data-motion": undefined, "data-font": undefined });
    expect(accessibilityAttributes({ textSize: 115, highContrast: true, reduceMotion: false, readableFont: true })).toEqual({ "data-text-size": "115", "data-contrast": "high", "data-motion": undefined, "data-font": "readable" });
  });

  it("the before-paint script applies the same attributes from this browser's copy", () => {
    const run = (stored: string | null) => {
      const dataset: Record<string, string> = {};
      const fn = new Function("localStorage", "document", A11Y_SCRIPT);
      fn({ getItem: (k: string) => (k === A11Y_KEY ? stored : null) }, { documentElement: { dataset } });
      return dataset;
    };
    expect(run(null)).toEqual({});
    expect(run("not json")).toEqual({});
    expect(run(JSON.stringify({ textSize: 130, highContrast: true, reduceMotion: true, readableFont: true }))).toEqual({ textSize: "130", contrast: "high", motion: "reduce", font: "readable" });
    expect(run(JSON.stringify({ textSize: 999, highContrast: "yes" }))).toEqual({});
  });
});
