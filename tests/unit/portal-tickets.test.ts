import { describe, expect, it } from "vitest";
import { csvCell, groupByDay, isFiltered, parseTicketFilter, ticketFilterQuery, ticketsCsv, ticketsCsvName, type PortalTicketRow } from "@/lib/portal-tickets";

const SITE = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

const row = (p: Partial<PortalTicketRow>): PortalTicketRow => ({
  id: "t1", order_id: "o1", order_number: "ORD-1001", number: "TKT-1", delivered_at: "2026-11-08T15:00:00Z", delivered_on: "2026-11-08",
  quantity: 22.5, unit: "ton", material: "Gravel #53", site: "Route 30 lot, Valparaiso", site_id: SITE, project: "", po: "", reference: "", confirmed: true, ...p,
});

describe("portal ticket filter", () => {
  it("keeps real dates and the customer's own site; ignores anything else", () => {
    expect(parseTicketFilter({ from: "2026-11-01", to: "2026-11-09", site: SITE }, [SITE])).toEqual({ from: "2026-11-01", to: "2026-11-09", site: SITE });
    expect(parseTicketFilter({ from: "2026-02-31", to: "yesterday", site: OTHER }, [SITE])).toEqual({ from: null, to: null, site: null });
    expect(parseTicketFilter({ site: "not-a-uuid" }, null).site).toBeNull();
  });

  it("turns a backwards range around and passes an unknown site on for the database to check (CSV route)", () => {
    expect(parseTicketFilter({ from: "2026-11-09", to: "2026-11-01" }, [])).toMatchObject({ from: "2026-11-01", to: "2026-11-09" });
    expect(parseTicketFilter({ site: OTHER.toUpperCase() }, null).site).toBe(OTHER);
  });

  it("takes the first value of a repeated parameter", () => {
    expect(parseTicketFilter({ from: ["2026-11-01", "2026-10-01"] }, []).from).toBe("2026-11-01");
  });

  it("builds the same query string for the page and the download", () => {
    expect(ticketFilterQuery({ from: "2026-11-01", to: null, site: SITE })).toBe(`?from=2026-11-01&site=${SITE}`);
    expect(ticketFilterQuery({ from: null, to: null, site: null })).toBe("");
    expect(isFiltered({ from: null, to: null, site: null })).toBe(false);
    expect(isFiltered({ from: null, to: "2026-11-09", site: null })).toBe(true);
  });
});

describe("portal tickets CSV", () => {
  it("has a header and one line per ticket, CRLF, plain numbers and readable units", () => {
    const csv = ticketsCsv([row({}), row({ id: "t2", number: "TKT-2", quantity: "3", unit: "cubic_yard", confirmed: false, material: null })]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Delivered,Ticket,Order,Job site,Project,PO,Material,Quantity,Unit,Status,Reference");
    expect(lines[1]).toBe('2026-11-08,TKT-1,ORD-1001,"Route 30 lot, Valparaiso",,,Gravel #53,22.5,ton,Confirmed,');
    expect(lines[2]).toBe('2026-11-08,TKT-2,ORD-1001,"Route 30 lot, Valparaiso",,,,3,cubic yard,Being checked,');
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell('He said "drop it here", then left')).toBe('"He said ""drop it here"", then left"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe("");
  });

  it("never lets a cell run as a spreadsheet formula, but keeps negative numbers", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+1+1")).toBe("'+1+1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-12.5")).toBe("-12.5");
  });

  it("an empty list is just the header", () => {
    expect(ticketsCsv([])).toBe("Delivered,Ticket,Order,Job site,Project,PO,Material,Quantity,Unit,Status,Reference\r\n");
  });

  it("names the file after the filter", () => {
    expect(ticketsCsvName({ from: "2026-11-01", to: "2026-11-09", site: null })).toBe("tickets-2026-11-01-to-2026-11-09.csv");
    expect(ticketsCsvName({ from: null, to: null, site: SITE })).toBe("tickets-all-site.csv");
    expect(ticketsCsvName({ from: "2026-11-01", to: null, site: null })).toBe("tickets-from-2026-11-01.csv");
  });
});

describe("portal tickets by day", () => {
  it("groups consecutive tickets under their delivery day, newest day first as given", () => {
    const days = groupByDay([row({ id: "a", delivered_on: "2026-11-09" }), row({ id: "b", delivered_on: "2026-11-09" }), row({ id: "c", delivered_on: "2026-11-07" })]);
    expect(days.map((d) => [d.day, d.tickets.map((t) => t.id)])).toEqual([["2026-11-09", ["a", "b"]], ["2026-11-07", ["c"]]]);
  });
});
