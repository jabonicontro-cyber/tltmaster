import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The app's dark mode is the person's choice (html[data-theme], src/lib/theme.ts) and works by remapping the
// colour palette (globals.css). Tailwind's `dark:` variant follows the device setting instead, so it misfires:
// on a dark device it picks the remapped dark shades, and with "Light" chosen on a dark device it puts pale
// text on white. Use the palette (e.g. text-amber-800) and let the theme remap it.
const ROOT = join(__dirname, "..", "..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : /\.(tsx|ts)$/.test(n) ? [p] : []; });
}

describe("theme", () => {
  it("no Tailwind dark: variants in app code (the theme remaps the palette instead)", () => {
    const offenders = files(join(ROOT, "src")).filter((f) => /(["'`\s])dark:[a-z]/.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("app UI uses only light fills and dark text shades the dark theme remaps (an unmapped one keeps its light-mode colour in dark mode)", () => {
    const css = readFileSync(join(ROOT, "src", "app", "globals.css"), "utf8");
    const dark = css.slice(css.indexOf('html[data-theme="dark"] body {'));
    const remapped = new Set([...dark.slice(0, dark.indexOf("}")).matchAll(/--color-([a-z]+-\d+)/g)].map((m) => m[1]));
    expect(remapped.size, "dark palette block not found in globals.css").toBeGreaterThan(20);
    const families = new Set([...remapped].map((c) => c.split("-")[0]));
    const app = [...files(join(ROOT, "src", "app", "(app)")), ...files(join(ROOT, "src", "components"))].filter((f) => !f.includes(join("components", "site")));
    const offenders: string[] = [];
    for (const f of app) {
      for (const m of readFileSync(f, "utf8").matchAll(/\b(?:bg|text|border|ring)-([a-z]+-\d{2,3})\b/g)) {
        // Mid shades (300–700) read on both backgrounds; light fills and dark text must follow the theme.
        const shade = Number(m[1].split("-")[1]);
        if (families.has(m[1].split("-")[0]) && !remapped.has(m[1]) && (shade <= 200 || shade >= 800)) offenders.push(`${relative(ROOT, f)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
