import "server-only";

/** Make user search text safe inside a PostgREST or=(...) ilike filter. */
export function ilikePattern(q: string | undefined | null): string | null {
  const cleaned = (q ?? "").replace(/[,()%*\\"'.:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return cleaned ? `%${cleaned}%` : null;
}

export const PAGE_SIZE = 25;

export function pageParam(value: string | undefined): number {
  const n = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10000) : 1;
}
