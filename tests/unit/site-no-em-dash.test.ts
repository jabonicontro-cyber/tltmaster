import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publicGuides } from "@/lib/site/guides";

// Owner 2026-11-04: no em dashes on the public website (they read as machine-written). Covers the site's pages,
// components, copy and screenshot captions, the sign-in pages, and the Help Center articles published as guides.
// Code comments are not shown to visitors and are skipped.
const ROOTS = ["src/app/(site)", "src/lib/site", "src/components/site", "src/app/(auth)", "src/app/early-access", "src/app/not-found.tsx"];

function files(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((f) => files(join(path, f))).filter((f) => /\.(tsx?|json)$/.test(f));
}

describe("public website copy", () => {
  it("has no em dashes", () => {
    const found: string[] = [];
    for (const f of ROOTS.flatMap(files)) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*")) return;
        if (line.includes("—")) found.push(`${f}:${i + 1}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("publishes guides without em dashes", () => {
    const found = publicGuides().filter((a) => JSON.stringify(a).includes("—")).map((a) => a.id);
    expect(found).toEqual([]);
  });
});
