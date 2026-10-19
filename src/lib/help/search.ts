import type { Permission } from "@/lib/permissions";
import type { HelpArticle } from "./types";

// Help Center logic (B65): which articles a person may see, which ones belong to the page they are on, and search.
// Pure, so the same rules run on the server and in tests. Context comes from each article's declared routes (a
// maintained registry), not from guessing at words in the URL.

/** Articles the person may read: no permission listed, or at least one of theirs. */
export function visibleArticles(articles: HelpArticle[], permissions: readonly Permission[]): HelpArticle[] {
  return articles.filter((a) => a.permissions.length === 0 || a.permissions.some((p) => permissions.includes(p)));
}

/** How well a route pattern matches a path: exact = 1000; "/x/*" prefix = its length; no match = -1. */
export function routeScore(pattern: string, pathname: string): number {
  const path = pathname.split("?")[0].replace(/\/+$/, "") || "/";
  if (pattern === path) return 1000;
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    if (path === base || path.startsWith(`${base}/`)) return base.length;
  }
  return -1;
}

/** Articles for the page the person is on, best match first. */
export function articlesForPath(articles: HelpArticle[], pathname: string): HelpArticle[] {
  return articles
    .map((a) => ({ a, s: Math.max(-1, ...a.routes.map((r) => routeScore(r, pathname))) }))
    .filter((x) => x.s >= 0)
    .sort((x, y) => y.s - x.s || x.a.title.localeCompare(y.a.title))
    .map((x) => x.a);
}

const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter((w) => w.length > 1);

/** Plain text of an article, for search. */
export function articleText(a: HelpArticle): string {
  return [
    a.title, a.summary, a.audience, ...a.whatYouSee, ...a.tasks.flatMap((t) => [t.title, ...t.steps]), ...a.prerequisites,
    ...a.troubleshooting.flatMap((t) => [t.problem, t.fix]), ...(a.limitations ?? []),
  ].join(" ");
}

/**
 * Search titles, summaries, tasks and troubleshooting. Every query word must appear somewhere (prefix match, so
 * "dispat" finds "dispatch"); title and task hits rank higher. Returns [] for an empty query.
 */
export function searchArticles(articles: HelpArticle[], query: string): HelpArticle[] {
  const q = words(query.slice(0, 120));
  if (!q.length) return [];
  const scored = articles.map((a) => {
    const title = words(a.title);
    const summary = words(a.summary);
    const tasks = words(a.tasks.map((t) => t.title).join(" "));
    const body = words(articleText(a));
    let score = 0;
    for (const w of q) {
      const hit = (list: string[]) => list.some((x) => x.startsWith(w));
      if (!hit(body)) return { a, score: -1 };
      score += (hit(title) ? 6 : 0) + (hit(tasks) ? 3 : 0) + (hit(summary) ? 2 : 0) + 1;
    }
    return { a, score };
  });
  return scored.filter((x) => x.score > 0).sort((x, y) => y.score - x.score || x.a.title.localeCompare(y.a.title)).map((x) => x.a);
}
