"use server";

import { cleanQuery, type SearchGroupKey, type SearchHit } from "@/lib/search";
import { getAccess } from "@/server/auth";
import { mfaBlocks } from "@/server/mfa";
import { globalSearch } from "@/server/data/global-search";

export type QuickResults = { q: string; groups: Array<{ key: SearchGroupKey; label: string; hits: SearchHit[] }> };

/**
 * Results while typing in the header search (owner 2026-10-26). The same search as the Search page, with fewer hits
 * per group; runs with the person's own session, so it only finds records they may open.
 */
export async function quickSearch(raw: string): Promise<QuickResults | null> {
  const access = await getAccess();
  if (!access || !access.active || !access.role || !access.companyId || (await mfaBlocks())) return null;
  const q = cleanQuery(raw);
  if (!q) return { q: "", groups: [] };
  const groups = await globalSearch(access, q, 4);
  return { q, groups: groups.filter((g) => g.hits.length > 0) };
}
