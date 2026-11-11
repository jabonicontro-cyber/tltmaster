import "server-only";

// The database API returns at most 1000 rows per request (max_rows, supabase/config.toml; the same on the hosted
// project), whatever .limit() asks for. A list that is totalled (money owed, IFTA miles and gallons, billing queues,
// costs) must read every page, or past 1000 rows it quietly leaves records out. allRows reads page after page until a
// short one, and fails if there are more than maxPages pages. Pages are separate requests, not one snapshot: a record
// saved or removed between two of them can shift the rows (a repeated row is dropped below; a row that moves back
// across a page boundary in those milliseconds is missed for that one read).

export const PAGE_ROWS = 1000;

type Page = PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
export type AllRows<T> = { data: T[] | null; error: { code?: string; message: string } | null };

/**
 * Every row of a query. `query` builds the query afresh for each page and must give it a stable order (end with a
 * unique column such as id), so no row is skipped or read twice between pages.
 */
export async function allRows<T>(query: () => { range(from: number, to: number): Page }, maxPages = 100): Promise<AllRows<T>> {
  const out: T[] = [];
  // Pages are separate requests: a record saved between two of them can shift the rows, so the row at a page boundary
  // may come back twice. Rows with an id (or a view's key) are kept once, so no total counts a record twice.
  const seen = new Set<unknown>();
  for (let page = 0; page < maxPages; page++) {
    const { data, error } = await query().range(page * PAGE_ROWS, page * PAGE_ROWS + PAGE_ROWS - 1);
    if (error) return { data: null, error };
    const rows = (data ?? []) as T[];
    for (const row of rows) {
      const id = (row as { id?: unknown; key?: unknown } | null)?.id ?? (row as { key?: unknown } | null)?.key;
      if (id !== undefined && id !== null) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      out.push(row);
    }
    if (rows.length < PAGE_ROWS) return { data: out, error: null };
  }
  return { data: null, error: { code: "too_many_rows", message: `more than ${maxPages * PAGE_ROWS} rows` } };
}
