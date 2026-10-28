// Best match first for list searches (owner 2026-10-28: "as I type the results that best match show"). Pure scoring of
// the fields a row was found by; the database still decides which rows match, this only orders them.

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").trim();

/**
 * How well `q` matches a row's fields, highest first: the main field equal to the search, then starting with it, then
 * a word in it starting with it, then containing it; other fields (number, email, phone, city) count less. 0 = no match.
 */
export function matchScore(q: string, main: string | null | undefined, others: Array<string | null | undefined> = []): number {
  const n = norm(q);
  if (!n) return 0;
  const score = (text: string | null | undefined, weight: number) => {
    const t = norm(text ?? "");
    if (!t) return 0;
    if (t === n) return 100 * weight;
    if (t.startsWith(n)) return 80 * weight;
    if (t.split(/[\s.,&@/()-]+/).some((w) => w.startsWith(n))) return 60 * weight;
    if (t.includes(n)) return 40 * weight;
    return 0;
  };
  return Math.max(score(main, 1), ...others.map((o) => score(o, 0.7)));
}

/** Rows ordered by match (stable: equal scores keep their order). Without a search the order is unchanged. */
export function rankRows<T>(rows: T[], q: string | undefined, fields: (row: T) => { main: string | null | undefined; others?: Array<string | null | undefined> }): T[] {
  if (!q || !norm(q)) return rows;
  return rows
    .map((row, i) => {
      const f = fields(row);
      return { row, i, s: matchScore(q, f.main, f.others) };
    })
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.row);
}
