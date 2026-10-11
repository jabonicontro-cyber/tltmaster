import { describe, expect, it } from "vitest";
import { leadSchema, looksAutomated } from "@/lib/site/lead";
import { confirmationEmail, notificationEmail } from "@/lib/site/lead-emails";
import { isPublicSiteRequest, SITE_PAGES } from "@/lib/site/paths";
import { foundingMonthlyCents, PRICING, usd } from "@/lib/site/pricing";
import { guessMapping, mappingProblems, parseCsv, prepareRows } from "@/lib/platform/imports";
import { applyPreview, parsePreviewRole } from "@/lib/platform/preview";
import { publicSiteEnabled } from "@/server/site-access";
import type { Access } from "@/lib/permissions";

describe("public website paths", () => {
  it("opens exact marketing pages to GET/HEAD only, and the lead endpoint to POST only", () => {
    for (const p of SITE_PAGES) {
      expect(isPublicSiteRequest(p, "GET")).toBe(true);
      expect(isPublicSiteRequest(p, "HEAD")).toBe(true);
      // A server action is a POST to a page: never public.
      expect(isPublicSiteRequest(p, "POST")).toBe(false);
    }
    expect(isPublicSiteRequest("/pricing/", "GET")).toBe(true);
    for (const p of ["/pricing/x", "/admin", "/command-center", "/api/leads/x", "/login", "/tickets/photos/1", "//pricing", "/Pricing"]) {
      expect(isPublicSiteRequest(p, "GET"), p).toBe(false);
    }
    expect(isPublicSiteRequest("/api/leads", "POST")).toBe(true);
    expect(isPublicSiteRequest("/api/leads", "GET")).toBe(false);
    expect(isPublicSiteRequest("/", "GET", false)).toBe(false); // site not enabled
  });
  it("is behind the early-access gate unless the owner sets PUBLIC_SITE=on", () => {
    const before = process.env.PUBLIC_SITE;
    try {
      delete process.env.PUBLIC_SITE;
      expect(publicSiteEnabled()).toBe(false);
      process.env.PUBLIC_SITE = "off";
      expect(publicSiteEnabled()).toBe(false);
      process.env.PUBLIC_SITE = " ON ";
      expect(publicSiteEnabled()).toBe(true);
    } finally {
      if (before === undefined) delete process.env.PUBLIC_SITE;
      else process.env.PUBLIC_SITE = before;
    }
  });
});

describe("lead form", () => {
  const base = { kind: "demo", name: "Pat", email: " Pat@Example.COM ", company_name: "Example Haul", phone: "", truck_count: "18", base_count: "2", message: "", source_path: "/demo" };
  it("normalizes and validates; a demo needs a company, trucks and bases, and a message needs some words", () => {
    const ok = leadSchema.parse(base);
    expect(ok).toMatchObject({ email: "pat@example.com", truck_count: 18, base_count: 2 });
    expect(leadSchema.parse({ ...base, truck_count: "0" }).truck_count).toBe(0); // a supplier without its own trucks
    for (const bad of [{ company_name: "" }, { truck_count: "" }, { base_count: "" }, { base_count: "0" }, { truck_count: "-1" }, { truck_count: "2.5" }, { truck_count: "lots" }]) {
      expect(leadSchema.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    const missing = leadSchema.safeParse({ ...base, truck_count: "", base_count: "" });
    expect(missing.error?.issues.map((i) => i.message)).toEqual(["Enter the number of hauling trucks (0 if none).", "Enter the number of dispatch bases."]);
    expect(leadSchema.safeParse({ ...base, kind: "contact", company_name: "", truck_count: "", base_count: "", message: "short" }).success).toBe(false);
    expect(leadSchema.safeParse({ ...base, kind: "contact", company_name: "", truck_count: "", base_count: "", message: "A question about pricing." }).success).toBe(true);
    expect(leadSchema.safeParse({ ...base, email: "nope" }).success).toBe(false);
    expect(leadSchema.safeParse({ ...base, phone: "call me maybe" }).success).toBe(false);
    expect(leadSchema.safeParse({ ...base, kind: "admin" }).success).toBe(false);
    expect(leadSchema.parse({ ...base, source_path: "https://evil.example" }).source_path).toBe("/");
  });
  it("flags automated submissions: the hidden field, instant submits, link-stuffed messages", () => {
    expect(looksAutomated({ website: "", elapsed_ms: 5000, message: "Hello" })).toBe(false);
    expect(looksAutomated({ website: "http://spam.example", elapsed_ms: 5000 })).toBe(true);
    expect(looksAutomated({ elapsed_ms: 300 })).toBe(true);
    expect(looksAutomated({ elapsed_ms: "abc" })).toBe(true);
    expect(looksAutomated({ elapsed_ms: undefined, message: "Hello" })).toBe(false); // plain form post: hidden field only
    expect(looksAutomated({ elapsed_ms: 9000, message: "http://a http://b http://c http://d" })).toBe(true);
  });
});

describe("lead emails", () => {
  const lead = { kind: "demo" as const, name: "Pat Example", email: "pat@example.com", company_name: "Example Haul (test)", phone: "", truck_count: 18, base_count: 2, message: "Ticket review." };
  it("confirm receipt to the prospect without promising a response time, a price or an offer", () => {
    const m = confirmationEmail(lead);
    expect(m.subject).toBe("We received your Taviron demo request");
    expect(m.text).toMatch(/^Hello Pat,/);
    expect(m.text).toMatch(/We will follow up by email/);
    expect(m.text).not.toMatch(/\bwithin\b|\bhours?\b|business day|\$|discount|price/i);
  });
  it("give the team every detail and a link to the lead", () => {
    const m = notificationEmail(lead, { leadUrl: "https://example.test/admin/leads/1", created: true });
    expect(m.subject).toBe("Demo request: Example Haul (test)");
    for (const line of ["Email: pat@example.com", "Hauling trucks: 18", "Dispatch bases: 2", "Ticket review.", "Open the lead: https://example.test/admin/leads/1"]) expect(m.text).toContain(line);
    expect(notificationEmail({ ...lead, kind: "contact", truck_count: null, base_count: null }, { leadUrl: "u", created: false }).subject).toBe("Contact message: Example Haul (test) (sent again)");
  });
});

describe("proposed pricing", () => {
  it("is $499 with 20% off for founding customers, $399.20", () => {
    expect(usd(PRICING.baseMonthlyCents)).toBe("$499");
    expect(foundingMonthlyCents()).toBe(39_920);
    expect(usd(foundingMonthlyCents())).toBe("$399.20");
    expect(PRICING.foundingCustomerLimit).toBe(10);
  });
});

describe("spreadsheet import", () => {
  it("parses CSV with quotes, embedded commas and line breaks, CRLF, a BOM, and tab-separated pastes", () => {
    expect(parseCsv('﻿Name,Notes\r\n"Smith, J.","said ""hi""\nthen left"\r\n\r\nLee,\r\n')).toEqual([
      ["Name", "Notes"],
      ["Smith, J.", 'said "hi"\nthen left'],
      ["Lee", ""],
    ]);
    expect(parseCsv("Unit\tType\n101\ttri axle")).toEqual([["Unit", "Type"], ["101", "tri axle"]]);
    expect(parseCsv("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("maps columns from their names, each field once, and reports missing required fields", () => {
    expect(guessMapping(["Customer Name", "E-mail", "ZIP", "Phone #", "Mystery", "Company"], "customers")).toEqual(["name", "email", "billing_postal_code", "phone", "", ""]);
    expect(guessMapping(["Truck #", "Type", "Year"], "trucks")).toEqual(["unit_number", "truck_type", "model_year"]);
    expect(mappingProblems(["", "make"], "trucks")).toEqual(['Choose the column for "Unit number".', 'Choose the column for "Truck type".']);
    expect(mappingProblems(["unit_number", "unit_number", "truck_type"], "trucks")).toEqual(['Two columns are mapped to "Unit number".']);
  });

  it("normalizes values and explains every problem by row", () => {
    const table = parseCsv(["Unit,Type,Year,Plate", "101,Tri-Axle,2019,ABC1", "102,spaceship,1890,", ",tandem,,"].join("\n"));
    const rows = prepareRows(table, ["unit_number", "truck_type", "model_year", "license_plate"], "trucks", new Date("2026-10-11T00:00:00Z"));
    expect(rows[0]).toEqual({ row: 2, data: { unit_number: "101", truck_type: "tri_axle_dump", model_year: "2019", license_plate: "ABC1" }, errors: [] });
    expect(rows[1].errors).toEqual(['Truck type "spaceship" is not recognized.', 'Year "1890" is not a valid year.']);
    expect(rows[2]).toMatchObject({ row: 4, errors: ["Unit number is required."] });

    const people = prepareRows(parseCsv("Name,Hire date\nSam,3/1/2024\nLee,2024-02-30\nAl,yesterday"), ["name", "hire_date"], "drivers");
    expect(people.map((r) => [r.data.hire_date ?? null, r.errors.length])).toEqual([["2024-03-01", 0], [null, 1], [null, 1]]);

    const cust = prepareRows(parseCsv("Name,PO,Email,Type\nA,yes,A@X.COM,business\nB,maybe,bad,\n"), ["name", "po_required", "email", "customer_type"], "customers");
    expect(cust[0].data).toEqual({ name: "A", po_required: "true", email: "a@x.com", customer_type: "commercial" });
    expect(cust[1].errors).toHaveLength(2);

    const mats = prepareRows(parseCsv("Name,UOM\nStone,Tons\nMulch,bucket"), ["name", "default_unit_code"], "materials");
    expect(mats[0].data.default_unit_code).toBe("ton");
    expect(mats[1].errors).toEqual(['Unit "bucket" is not recognized.']);
  });
});

describe("demo role previews", () => {
  const owner: Access = {
    userId: "u", companyId: "c", companyName: "Demo", email: "x@example.com", fullName: "X", role: "owner", active: true,
    permissions: ["orders.view", "dispatch.view", "dispatch.edit", "billing.view", "settings.manage", "driver.portal"], isDemo: true,
  };
  const rolePermissions = [
    { role: "dispatcher", permission: "orders.view" }, { role: "dispatcher", permission: "dispatch.view" }, { role: "dispatcher", permission: "dispatch.edit" },
    { role: "driver", permission: "driver.portal" },
    { role: "office", permission: "billing.view" }, { role: "office", permission: "audit.view" },
  ];
  it("only ever narrows: the result is the intersection with what the person really has", () => {
    expect(applyPreview(owner, "dispatcher", rolePermissions)).toMatchObject({ role: "dispatcher", preview: "dispatcher", permissions: ["orders.view", "dispatch.view", "dispatch.edit"] });
    expect(applyPreview(owner, "multi", rolePermissions).permissions).toEqual(["orders.view", "dispatch.view", "dispatch.edit", "driver.portal"]);
    // office has audit.view, which this person does not: the preview does not add it.
    expect(applyPreview(owner, "office", rolePermissions).permissions).toEqual(["billing.view"]);
    const limited = { ...owner, permissions: ["orders.view" as const] };
    expect(applyPreview(limited, "dispatcher", rolePermissions).permissions).toEqual(["orders.view"]);
    expect(applyPreview(owner, "mechanic", rolePermissions).permissions).toEqual([]);
  });
  it("accepts only known preview roles", () => {
    expect(parsePreviewRole("driver")).toBe("driver");
    expect(parsePreviewRole("platform_admin")).toBeNull();
    expect(parsePreviewRole(undefined)).toBeNull();
  });
});
