import { describe, expect, it } from "vitest";
import { readCarrierRows } from "@/lib/platform/outreach";
import { searchCensus } from "@/server/fmcsa";

// Outreach registry search (src/server/fmcsa.ts) against a simulated data.transportation.gov: the column names are read
// from the dataset's own column list, the search asks for one state's carriers with an email, and a registry that can't
// compare truck counts is asked again by state only (the counts are then checked here).

const COLUMNS = ["dot_number", "legal_name", "dba_name", "phy_city", "phy_state", "telephone", "email_address", "company_officer_1",
  "power_units", "total_drivers", "status_code", "crgo_genfreight", "crgo_constmatl", "crgo_meat"].map((fieldName) => ({ fieldName }));
const ROWS = [
  { dot_number: "1234567", legal_name: "ACME HAULING LLC", phy_city: "WACO", phy_state: "TX", email_address: "dispatch@acme.example", company_officer_1: "JOHN SMITH", power_units: "12", status_code: "A", crgo_constmatl: "X" },
  { dot_number: "2345678", legal_name: "LONE STAR FREIGHT", phy_city: "DALLAS", phy_state: "TX", email_address: "ops@lonestar.example", power_units: "40", status_code: "A", crgo_genfreight: "X" },
];

function fakeRegistry(opts: { failCast?: boolean; columns?: unknown[] } = {}) {
  const urls: string[] = [];
  const f = (async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/api/views/")) return json({ columns: opts.columns ?? COLUMNS });
    const where = new URL(url).searchParams.get("$where") ?? "";
    if (opts.failCast && where.includes("::number")) return json({ message: "bad cast" }, 400);
    return json(ROWS);
  }) as typeof fetch;
  return { f, urls };
}

describe("searching the FMCSA registry", () => {
  it("reads the registry's own column names and asks for carriers with an email in the chosen states", async () => {
    const { f, urls } = fakeRegistry();
    const r = await searchCensus({ states: ["tx", "ok", "bad!"], minUnits: 5, maxUnits: 100 }, f);
    expect(r.ok).toBe(true);
    const q = new URL(urls[1]).searchParams;
    expect(q.get("$where")).toBe("phy_state in ('TX','OK') AND email_address IS NOT NULL AND power_units::number >= 5 AND power_units::number <= 100");
    expect(q.get("$select")).toContain("email_address");
    if (!r.ok) return;
    const read = readCarrierRows(r.table, { states: ["TX"], minUnits: 5, maxUnits: 100, segments: ["aggregate"], activeOnly: true });
    expect(read.rows.map((x) => [x.company_name, x.segment, x.power_units])).toEqual([["Acme Hauling LLC", "aggregate", 12]]);
  });

  it("asks again by state alone when the registry can't compare truck counts", async () => {
    const { f, urls } = fakeRegistry({ failCast: true });
    const r = await searchCensus({ states: ["TX"], minUnits: 5, maxUnits: null }, f);
    expect(r.ok).toBe(true);
    expect(new URL(urls[2]).searchParams.get("$where")).toBe("phy_state in ('TX') AND email_address IS NOT NULL");
  });

  it("says plainly when it can't search, so the file upload can be used instead", async () => {
    expect(await searchCensus({ states: [], minUnits: null, maxUnits: null }, fakeRegistry().f)).toEqual({ ok: false, error: "Choose at least one state." });
    const missing = await searchCensus({ states: ["TX"], minUnits: null, maxUnits: null }, fakeRegistry({ columns: [{ fieldName: "legal_name" }] }).f);
    expect(missing.ok ? "" : missing.error).toMatch(/no longer has the columns/);
    const down = await searchCensus({ states: ["TX"], minUnits: null, maxUnits: null }, (async () => { throw new Error("offline"); }) as typeof fetch);
    expect(down.ok ? "" : down.error).toMatch(/didn't answer/);
  });
});
