import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gettingStartedItems } from "@/lib/getting-started";
import { poLabel, portalWords } from "@/lib/portal";
import { portalGeneralHelp } from "@/lib/portal-help";
import { OVER_ORDER, REVIEW_REASON_HELP, REVIEW_REASON_LABELS, reviewReasonLabel } from "@/lib/tickets/rules";
import { LAB_VIEWS, labDestination } from "@/lib/platform/testing-lab";
import { AREAS } from "@/lib/site/areas";

// First-day walkthrough fixes, batch 4 (2026-11-16): tickets, quotes, settings wording, portal, website, demo.

const all = () => true;
const root = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("tickets (T2, T3, T4)", () => {
  it("never shows an internal permission code to people", () => {
    for (const h of Object.values(REVIEW_REASON_HELP)) expect(h.who).not.toMatch(/\(|\./);
  });

  it("over the order is a review reason with its own help, but not a stored reason to filter by", () => {
    expect(reviewReasonLabel(OVER_ORDER)).toMatch(/more than the order/i);
    expect(REVIEW_REASON_HELP[OVER_ORDER].next).toMatch(/Correct/);
    expect(REVIEW_REASON_LABELS[OVER_ORDER]).toBeUndefined();
  });

  it("Getting started speaks the company's words: a freight office reviews a bill of lading", () => {
    const office = gettingStartedItems("office", {}, all, "freight");
    expect(office.find((i) => i.key === "ticket")?.label).toBe("Review a bill of lading");
    expect(gettingStartedItems("office", {}, all).find((i) => i.key === "ticket")?.label).toBe("Review a delivery ticket");
    expect(gettingStartedItems("driver", {}, all, "freight").find((i) => i.key === "ticket")?.label).toBe("Send the BOL for a delivered load");
  });
});

describe("settings wording (T7)", () => {
  it("the logo goes on invoices and the customer portal, not on quotes", () => {
    const [phone] = gettingStartedItems("owner", { companyPhone: false, companyLogo: false }, all);
    expect(phone.hint).toBe("Add your logo on the same page: it goes on your invoices and the customer portal.");
    expect(read("src/components/settings/settings-client.tsx")).not.toMatch(/Quotes and the public website are not changed/);
  });
});

describe("customer portal (W1, W5, W7)", () => {
  const ids = (a: Array<{ id: string }>) => a.map((x) => x.id);

  it("help answers follow the portal's switches: invoices shown, tickets tab, booking", () => {
    const on = portalGeneralHelp({ orders: true, quotes: true, documents: true, support: true, booking: true, invoices: true });
    expect(ids(on)).toEqual(expect.arrayContaining(["tickets", "booking", "job-sites", "invoices", "pay"]));
    expect(on.find((a) => a.id === "invoices")!.body).toMatch(/^Open Invoices/);
    expect(on.find((a) => a.id === "tickets")!.body).toMatch(/^Open Tickets/);
    expect(on.find((a) => a.id === "invoices")!.body).not.toMatch(/not shown/);
  });

  it("help never says invoices are missing from a portal that shows them, and never offers a section that is off", () => {
    const off = portalGeneralHelp({ orders: true, quotes: false, documents: false, support: false, booking: false, invoices: false });
    expect(ids(off)).not.toContain("booking");
    expect(ids(off)).not.toContain("quotes");
    expect(ids(off)).not.toContain("support");
    expect(off.find((a) => a.id === "invoices")!.body).toMatch(/not shown in this portal/);
    expect(off.find((a) => a.id === "tickets")!.body).toMatch(/not shown in this portal/);
  });

  it("“How do I pay?” says payment is arranged with the company, and a search for it finds it", () => {
    for (const f of [{}, { invoices: true }, { invoices: false }]) {
      const pay = portalGeneralHelp(f).find((a) => a.id === "pay")!;
      expect(pay.title).toBe("How do I pay my invoice?");
      expect(pay.body).toMatch(/not made in this portal/);
      expect(pay.body).toMatch(/arranged directly with the company/);
      expect(`${pay.title} ${pay.body}`.toLowerCase()).toContain("pay my invoice");
    }
  });

  it("signed out (switches unknown) the answers are true either way", () => {
    const unknown = portalGeneralHelp({});
    expect(unknown.find((a) => a.id === "invoices")!.body).toMatch(/When the company shows invoices/);
  });

  it("a freight portal says Bills of Lading and delivery locations", () => {
    const w = portalWords("freight");
    expect(w.tickets).toBe("Bills of Lading");
    expect(w.sites).toBe("Delivery locations");
    expect(w.say("Delivery tickets")).toBe("Bills of lading");
    expect(portalWords(undefined).tickets).toBe("Tickets");
    expect(portalWords("aggregate").say("Delivery tickets")).toBe("Delivery tickets");
    const freightHelp = portalGeneralHelp({ orders: true, documents: true }, w.say);
    expect(freightHelp.find((a) => a.id === "job-sites")!.body).toMatch(/^Open Delivery locations/);
  });

  it("a PO is never prefixed twice", () => {
    expect(poLabel("PO 4702")).toBe("PO 4702");
    expect(poLabel("4702")).toBe("PO 4702");
    expect(poLabel("P.O. 88")).toBe("P.O. 88");
    expect(poLabel("PO4702")).toBe("PO4702");
    expect(poLabel("Potomac job")).toBe("PO Potomac job");
    expect(poLabel("")).toBe("");
    expect(poLabel(null)).toBe("");
  });
});

describe("Testing Lab (W6)", () => {
  it("customer portal administration opens inside the chosen demo, like the role views", () => {
    const v = LAB_VIEWS.find((x) => x.key === "company.portal-admin")!;
    expect(v.open).toEqual({ kind: "role", role: "owner", to: "portal-admin" });
    expect(labDestination("portal-admin")).toBe("/customer-portal");
  });

  it("invoices in the portal are described as they are: shown, no online payment", () => {
    const v = LAB_VIEWS.find((x) => x.key === "customer.invoices")!;
    expect(v.implementation).toBe("available");
    expect(v.what).toMatch(/no online payment/i);
    // Opened through the one Customer portal preview, so that row keeps the only "Preview as Customer" button.
    expect(v.open.kind).toBe("none");
    expect(LAB_VIEWS.filter((x) => x.open.kind === "portal")).toHaveLength(1);
    expect(v.note ?? "").not.toMatch(/No issued invoices exist/);
  });
});

describe("public website (W8 to W11)", () => {
  it("the home page words AI one way, as the catalog does (in development)", () => {
    const home = read("src/app/(site)/page.tsx");
    expect(home).not.toMatch(/built but not switched on/);
    expect(home).toMatch(/AI assistance is in development/);
  });

  it("dispatch does not contradict the published driver-hours feature", () => {
    const dispatch = AREAS.find((a) => a.slug === "dispatch")!;
    const text = [...dispatch.controls, ...dispatch.notYet].join(" ");
    expect(text).not.toMatch(/not tracked/);
    expect(text).toMatch(/does not calculate hours-of-service rules/);
  });

  it("trust says two-step verification is required, not being rolled out; customers wording has no internal setup words", () => {
    expect(read("src/app/(site)/trust/page.tsx")).not.toMatch(/being rolled out/);
    const customers = AREAS.find((a) => a.slug === "customers")!;
    expect(customers.notYet.join(" ")).not.toMatch(/email provider is configured/);
  });
});
