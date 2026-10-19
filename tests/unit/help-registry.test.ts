import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_ARTICLES } from "@/lib/help/articles";
import { GUIDES } from "@/lib/help/guides";

// The help registry stays true to the product: every guide anchor is marked in the code, every link points to an
// article that exists, and every route an article claims is a real page of the app.

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const source = files("src").filter((f) => /\.tsx?$/.test(f) && !f.startsWith(join("src", "lib", "help"))).map((f) => readFileSync(f, "utf8")).join("\n");
const appRoutes = files(join("src", "app", "(app)")).filter((f) => f.endsWith("page.tsx")).map((f) => f.split("(app)")[1].replace(/\\/g, "/").replace(/\/?page\.tsx$/, "").replace(/\[[^\]]+\]/g, "*"));

describe("help registry", () => {
  it("article ids are unique and every next/related/guide link resolves", () => {
    const ids = HELP_ARTICLES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of HELP_ARTICLES) for (const x of [...a.next, ...a.related]) expect(ids, `${a.id} → ${x}`).toContain(x);
    for (const g of GUIDES) if (g.article) expect(ids, `guide ${g.id}`).toContain(g.article);
  });

  it("every guide anchor is marked in the code with data-guide", () => {
    for (const g of GUIDES) for (const s of g.steps) if (s.anchor) {
      const marked = source.includes(`data-guide="${s.anchor}"`) || source.includes(`"${s.anchor}"`);
      expect(marked, `${g.id}: ${s.anchor}`).toBe(true);
    }
  });

  it("every route an article or guide names is a page of the app", () => {
    const known = (r: string) => {
      const base = r.replace(/\/\*$/, "");
      return appRoutes.some((p) => p === base || p === r || p.startsWith(`${base}/`) || p.replace(/\*/g, "x") === base);
    };
    for (const a of HELP_ARTICLES) for (const r of a.routes) expect(known(r), `${a.id}: ${r}`).toBe(true);
    for (const g of GUIDES) for (const s of g.steps) expect(known(s.route), `${g.id}: ${s.route}`).toBe(true);
  });
});
