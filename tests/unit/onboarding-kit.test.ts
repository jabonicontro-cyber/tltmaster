import { describe, expect, it } from "vitest";
import { GO_LIVE_ITEMS, goLiveBlockers, forbiddenKeys, QUESTIONNAIRE, questionnaireMissing, renderWelcome, DEFAULT_WELCOME_BODY, DISPATCH_RULES } from "@/lib/onboarding/kit";
import { kitFormProblem } from "@/lib/onboarding/kit-validate";
import { guessMapping, IMPORT_ENTITIES, IMPORT_FIELDS, parseCsv, prepareRows, templateCsv, templateHeaders } from "@/lib/platform/imports";

const allPassed = Object.fromEntries(GO_LIVE_ITEMS.map((i) => [i.key, { status: "passed" as const, note: "ok" }]));

describe("onboarding kit", () => {
  it("every import template maps back to the importer's fields without manual mapping", () => {
    for (const e of IMPORT_ENTITIES) {
      const headers = templateHeaders(e);
      expect(guessMapping(headers, e)).toEqual(IMPORT_FIELDS[e].map((f) => f.key));
      const parsed = parseCsv(templateCsv(e));
      expect(parsed).toEqual([headers]); // header only: no example row that could be imported by mistake
    }
  });

  it("critical items must pass, others need a reason to be waived, and open critical issues block", () => {
    expect(goLiveBlockers(allPassed, [])).toEqual([]);
    expect(goLiveBlockers({ ...allPassed, dispatch_testing: { status: "not_applicable", note: "n/a" } }, [])).toHaveLength(1);
    expect(goLiveBlockers({ ...allPassed, training: { status: "exception", note: "" } }, [])[0]).toMatch(/reason/);
    expect(goLiveBlockers({ ...allPassed, training: { status: "exception", note: "Night shift trained next week" } }, [])).toEqual([]);
    expect(goLiveBlockers(allPassed, [{ status: "open", critical: true }])).toEqual(["An open critical issue in Testing must be resolved."]);
    expect(goLiveBlockers(allPassed, [{ status: "open", critical: false }])).toEqual([]);
    expect(GO_LIVE_ITEMS.filter((i) => i.critical).map((i) => i.key)).toEqual(["tenant_permissions", "data_validation", "dispatch_testing", "safety_procedures"]);
  });

  it("an integration can only be verified when this server has it configured, and unavailable ones stay unavailable", () => {
    const cfg = { email: false, routing: true, ai: false, portal: true };
    expect(kitFormProblem("integration_checks", { items: { email: { status: "verified" } } }, "taviron", cfg)).toMatch(/not configured/);
    expect(kitFormProblem("integration_checks", { items: { routing: { status: "verified" } } }, "taviron", cfg)).toBeNull();
    expect(kitFormProblem("integration_checks", { items: { eld: { status: "verified" } } }, "taviron", cfg)).toMatch(/not available/);
    expect(kitFormProblem("integration_checks", { items: {} }, "company", cfg)).toMatch(/Taviron completes/);
  });

  it("no secrets in forms; required questionnaire answers are listed; the welcome email fills or marks placeholders", () => {
    expect(forbiddenKeys({ a: { api_key: "x" } })).toEqual(["a.api_key"]);
    expect(kitFormProblem("questionnaire", { password: "x" }, "company")).toMatch(/never stored/);
    const required = QUESTIONNAIRE.flatMap((s) => s.fields.filter((f) => f.required));
    expect(questionnaireMissing({})).toHaveLength(required.length);
    const text = renderWelcome(DEFAULT_WELCOME_BODY, { company_name: "Acme Haul", primary_contact: "Sam" });
    expect(text).toContain("Acme Haul");
    expect(text).toContain("[kickoff]");
    expect(text).toMatch(/subscription starts at your actual go-live/);
  });

  it("the worksheet never calls hours of service product-enforced (no ELD integration)", () => {
    expect(DISPATCH_RULES.find((r) => r.key === "hos")!.product).toBe("manual");
  });
});

describe("imports for real company data (LR3): job sites, trailers, driver credentials", () => {
  it("guesses columns from common spreadsheet headers", () => {
    expect(guessMapping(["Customer", "Job Name", "Address", "City", "ST", "Zip", "Gate code"], "sites")).toEqual(["customer_name", "label", "line1", "city", "state", "postal_code", "directions"]);
    expect(guessMapping(["Trailer #", "Type", "Year", "VIN", "Plate"], "trailers")).toEqual(["unit_number", "trailer_type", "model_year", "vin", "license_plate"]);
    expect(guessMapping(["Driver Name", "CDL Class", "CDL Exp", "Med Card Exp"], "drivers")).toEqual(["name", "cdl_class", "cdl_expires_on", "medical_expires_on"]);
  });
  it("reads trailer types and CDL classes as people write them", () => {
    const trailers = prepareRows([["Unit", "Type"], ["T1", "End Dump"], ["T2", "53' Dry Van"], ["T3", "Reefer"], ["T4", "boat"]], ["unit_number", "trailer_type"], "trailers");
    expect(trailers.map((r) => r.data.trailer_type ?? null)).toEqual(["end_dump", "dry_van", "reefer", null]);
    expect(trailers[3].errors.length).toBeGreaterThan(0);
    const drivers = prepareRows([["Name", "CDL", "Exp"], ["Ray", "Class A", "3/31/2027"]], ["name", "cdl_class", "cdl_expires_on"], "drivers");
    expect(drivers[0].data).toMatchObject({ name: "Ray", cdl_class: "A", cdl_expires_on: "2027-03-31" });
  });
});
