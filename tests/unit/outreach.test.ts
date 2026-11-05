import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/platform/imports";
import {
  DEFAULT_BODY, composeLinks, defaultFaq, firstName, mapColumns, missingColumns, readCarrierRows, renderEmail, settingsProblems, withDefaults,
} from "@/lib/platform/outreach";

// Outreach (master plan B139): reading the FMCSA census export and preparing the email.

const CENSUS = [
  "DOT_NUMBER,LEGAL_NAME,DBA_NAME,PHY_CITY,PHY_STATE,TELEPHONE,EMAIL_ADDRESS,COMPANY_OFFICER_1,NBR_POWER_UNIT,DRIVER_TOTAL,STATUS_CODE,CRGO_GENFREIGHT,CRGO_CONSTMATL",
  '1234567,"ACME HAULING LLC",,WACO,TX,2545550100,Dispatch@AcmeHauling.example,JOHN SMITH,12,14,A,,X',
  "2345678,ROAD RUNNER FREIGHT INC,,TULSA,OK,9185550100,office@roadrunner.example,MARY JONES,40,45,A,X,",
  "3456789,NO EMAIL TRUCKING,,DALLAS,TX,2145550100,,BOB,8,8,A,,X",
  "4567890,OLD CARRIER CO,,AUSTIN,TX,5125550100,old@carrier.example,ANN,9,9,I,,X",
  "5678901,TINY TRUCKS,,EL PASO,TX,9155550100,tiny@trucks.example,SAM,1,1,A,,X",
  "6789012,ACME HAULING TWO,,WACO,TX,2545550101,dispatch@acmehauling.example,JOHN SMITH,12,14,A,,X",
].join("\n");

describe("reading the carrier registry export", () => {
  it("recognises the census columns and the cargo flags", () => {
    const map = mapColumns(parseCsv(CENSUS)[0]);
    expect(missingColumns(map)).toEqual([]);
    expect(map.aggregateCargo.length).toBe(1);
    expect(map.freightCargo.length).toBe(1);
    expect(missingColumns(mapColumns(["Name", "Phone"]))).toEqual(["email address"]);
  });

  it("keeps active carriers with an email that match the filters, once per address, with softer names", () => {
    const r = readCarrierRows(parseCsv(CENSUS), { states: ["tx"], minUnits: 5, maxUnits: 100, segments: ["aggregate"], activeOnly: true });
    expect(r.rows).toEqual([{
      email: "dispatch@acmehauling.example", company_name: "Acme Hauling LLC", contact_name: "John Smith", phone: "2545550100",
      city: "Waco", state: "TX", dot_number: "1234567", power_units: 12, drivers: 14, segment: "aggregate",
    }]);
    expect(r.skipped).toEqual({ noEmail: 1, inactive: 1, filtered: 2, duplicate: 1 });
    const freight = readCarrierRows(parseCsv(CENSUS), { states: [], minUnits: null, maxUnits: null, segments: ["freight"], activeOnly: true });
    expect(freight.rows.map((x) => x.company_name)).toEqual(["Road Runner Freight INC"]);
  });
});

describe("the outreach email", () => {
  const prospect = { email: "dispatch@acmehauling.example", company_name: "Acme Hauling LLC", contact_name: "JOHN SMITH", city: "Waco", power_units: 12, source: "fmcsa_census" as const, unsubscribe_token: "a".repeat(32) };
  const settings = withDefaults({ sender_name: "Jordan Lee", postal_address: "PO Box 100, Waco, TX 76701" });

  it("needs a sender and a postal address before anything can be prepared", () => {
    expect(settingsProblems(withDefaults(null))).toHaveLength(2);
    expect(settingsProblems(settings)).toEqual([]);
  });

  it("is filled in for the company, with the FAQ, where the address came from, the unsubscribe link and the postal address", () => {
    const e = renderEmail(prospect, settings, "https://example.test");
    expect(e.subject).toBe("Less paperwork for Acme Hauling LLC?");
    expect(e.body).toMatch(/^Hi John,/);
    expect(e.body).toContain("how it would work for your 12 trucks?");
    expect(e.body).toContain("Common questions");
    expect(e.body).toContain(defaultFaq()[0].q);
    expect(e.body).toContain("listed in the public FMCSA motor carrier registry");
    expect(e.body).toContain(`https://example.test/unsubscribe/${"a".repeat(32)}`);
    expect(e.body.trim().endsWith("PO Box 100, Waco, TX 76701")).toBe(true);
    expect(e.body).not.toMatch(/\{\{/);
    // Plain punctuation only (owner 2026-11-04: no em dashes in anything prospects read).
    expect(`${DEFAULT_BODY}${JSON.stringify(defaultFaq())}${e.body}`).not.toContain("—");
  });

  it("falls back gracefully and opens in Gmail or the mail app", () => {
    expect(firstName("")).toBe("there");
    expect(firstName("J")).toBe("there");
    expect(firstName("mary ann jones")).toBe("Mary");
    const e = renderEmail({ ...prospect, contact_name: "", power_units: null, source: "manual" }, settings);
    expect(e.body).toMatch(/^Hi there,/);
    expect(e.body).toContain("for your fleet?");
    expect(e.body).not.toContain("FMCSA");
    const links = composeLinks(e);
    expect(links.mailto.startsWith("mailto:dispatch%40acmehauling.example?subject=")).toBe(true);
    expect(links.mailto).not.toContain("+");
    expect(new URL(links.gmail).searchParams.get("to")).toBe(e.to);
    expect(new URL(links.gmail).searchParams.get("body")).toBe(e.body);
  });
});
