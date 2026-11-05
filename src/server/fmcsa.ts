import "server-only";
import { mapColumns } from "@/lib/platform/outreach";

// FMCSA Company Census File (public registration data, data.transportation.gov dataset az4n-8mr2), read through the
// free Socrata API: no account, no key, read only. Used by Outreach (master plan B139) to find carriers by state and
// fleet size instead of downloading a file.
//
// The dataset's column names have changed between versions, so they are read from the dataset's own column list on
// every search and matched by name (src/lib/platform/outreach.ts mapColumns), the same way an uploaded file is read.
// If the email, company or state column can't be found the search says so, and the file upload still works.

export const CENSUS_DATASET = "az4n-8mr2";
const BASE = "https://data.transportation.gov";
const PAGE = 5000;
export const MAX_ROWS = 20000;

export interface CensusSearch { states: string[]; minUnits: number | null; maxUnits: number | null }
export type CensusResult =
  | { ok: true; table: string[][]; truncated: boolean }
  | { ok: false; error: string };

type Fetch = typeof fetch;
const STATE = /^[A-Z]{2}$/;

async function getJson(url: string, f: Fetch): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await f(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(25_000), cache: "no-store" });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

/** Carriers in the given states with an email address (and, when the registry allows it, within the truck range). */
export async function searchCensus(q: CensusSearch, f: Fetch = fetch): Promise<CensusResult> {
  const states = [...new Set(q.states.map((s) => s.trim().toUpperCase()).filter((s) => STATE.test(s)))];
  if (!states.length) return { ok: false, error: "Choose at least one state." };
  let meta;
  try {
    meta = await getJson(`${BASE}/api/views/${CENSUS_DATASET}.json`, f);
  } catch {
    return { ok: false, error: "The FMCSA registry didn't answer. Try again in a minute, or upload a file instead." };
  }
  const columns = ((meta.body as { columns?: Array<{ fieldName?: string }> } | null)?.columns ?? [])
    .map((c) => c.fieldName ?? "").filter((n) => n && !n.startsWith(":"));
  if (!meta.ok || !columns.length) return { ok: false, error: "The FMCSA registry's column list couldn't be read. Upload a file instead." };
  const map = mapColumns(columns);
  const email = map.fields.email, company = map.fields.company_name, state = map.fields.state;
  if (email === undefined || company === undefined || state === undefined) {
    return { ok: false, error: "The FMCSA registry no longer has the columns Outreach expects. Upload a file instead." };
  }
  const wanted = [...new Set([
    ...Object.values(map.fields), map.dba, map.active, ...map.aggregateCargo, ...map.freightCargo,
  ].filter((i): i is number => i !== null && i !== undefined))].map((i) => columns[i]);
  const col = (i: number) => columns[i];
  const base = [`${col(state)} in (${states.map((s) => `'${s}'`).join(",")})`, `${col(email)} IS NOT NULL`];
  const units = map.fields.power_units !== undefined ? col(map.fields.power_units) : null;
  const unitClause = units && (q.minUnits !== null || q.maxUnits !== null)
    ? [q.minUnits !== null ? `${units}::number >= ${Math.max(0, Math.floor(q.minUnits))}` : null, q.maxUnits !== null ? `${units}::number <= ${Math.max(0, Math.floor(q.maxUnits))}` : null].filter(Boolean) as string[]
    : [];

  const rows: string[][] = [];
  let truncated = false;
  let clauses = [...base, ...unitClause];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const params = new URLSearchParams({ $select: wanted.join(","), $where: clauses.join(" AND "), $order: col(email), $limit: String(PAGE), $offset: String(offset) });
    let page;
    try {
      page = await getJson(`${BASE}/resource/${CENSUS_DATASET}.json?${params}`, f);
    } catch {
      return { ok: false, error: "The FMCSA registry didn't answer. Try again in a minute, or upload a file instead." };
    }
    if (!page.ok && page.status === 400 && unitClause.length && clauses.length > base.length && offset === 0) {
      // The truck count couldn't be compared on the registry's side; fetch by state and filter here instead.
      clauses = base;
      offset -= PAGE;
      continue;
    }
    if (!page.ok || !Array.isArray(page.body)) return { ok: false, error: `The FMCSA registry refused the search (${page.status}). Upload a file instead.` };
    const data = page.body as Array<Record<string, unknown>>;
    for (const r of data) rows.push(wanted.map((k) => (r[k] === null || r[k] === undefined ? "" : String(r[k]))));
    if (data.length < PAGE) break;
    if (offset + PAGE >= MAX_ROWS) truncated = true;
  }
  return { ok: true, table: [wanted, ...rows], truncated };
}
