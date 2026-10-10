import { describe, expect, it } from "vitest";
import { renderQuotePdf } from "@/server/pdf/quote-pdf";
import type { QuoteDocument } from "@/lib/quotes/document";

const doc: QuoteDocument = {
  isDraft: false,
  quoteNumber: "Q-2026-0042",
  versionNo: 3,
  title: "Quote Q-2026-0042 (revision 3)",
  filename: "Q-2026-0042-v3.pdf",
  company: { name: "Top Line Trucking", addressLines: [], contactLine: "" },
  quoteDate: "October 1, 2026",
  validUntil: "October 31, 2026",
  billTo: { name: "Test Customer", customerNumber: "C-00001", addressLines: ["1 Test St", "Gary, IN 46401"] },
  contact: { name: "Pat", email: "pat@example.com", phone: "" },
  jobSite: { label: "Yard", addressLines: ["5 Site Rd"] },
  projectName: "Driveway",
  customerPo: "PO-1",
  paymentTerms: "Net 30",
  lines: Array.from({ length: 60 }, (_, i) => ({
    no: i + 1, description: `Line ${i + 1}`, quantity: "1", unit: "Tons", rate: "$1.00", amount: "$1.00", isDiscount: false,
  })),
  quantitySummary: [{ unit: "Tons", quantity: "60" }],
  totals: { subtotal: "$60.00", discount: null, tax: null, taxLabel: "", total: "$60.00" },
  jobInstructions: "Call ahead",
  terms: "Terms text",
  footerNote: "Thanks",
};

describe("quote PDF", () => {
  it("renders a valid multi-page PDF and reports its hash and size", async () => {
    const { buffer, sha256, byteSize } = await renderQuotePdf(doc);
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(byteSize).toBe(buffer.byteLength);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    const pages = buffer.toString("latin1").match(/\/Type \/Page\b/g) ?? [];
    expect(pages.length).toBeGreaterThanOrEqual(2);
  }, 30000);

  it("renders short documents", async () => {
    const a = await renderQuotePdf({ ...doc, lines: doc.lines.slice(0, 3) });
    expect(a.byteSize).toBeGreaterThan(1000);
  }, 30000);
});
