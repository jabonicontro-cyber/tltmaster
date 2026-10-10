import { describe, expect, it } from "vitest";
import {
  EXCEPTION_HELP, EXCEPTION_KINDS, EXCEPTION_LABELS, HANDOFF_CSV_COLUMNS, READINESS, formatDifference, handoffCsv, readinessExplanation,
  type HandoffSnapshot,
} from "@/lib/billing/rules";

function snapshot(orderNumber: string, extra: Partial<HandoffSnapshot["order"]> = {}): HandoffSnapshot {
  return {
    order: {
      order_id: `id-${orderNumber}`,
      order_number: orderNumber,
      customer_number: "C-00007",
      customer_name: 'Prairie View "PV" Landscaping, LLC',
      project_name: "=HYPERLINK(\"x\")",
      customer_po: "",
      service_start: "2026-10-08",
      service_end: "2026-10-09",
      subtotal_cents: 70000,
      discount_cents: 0,
      tax_cents: 4900,
      total_cents: 74900,
      ...extra,
    },
    lines: [
      { line_id: "l2", line_no: 2, kind: "hauling", calc_method: "per_unit", description: "Hauling\nper ton", unit_code: "ton", quantity: 40, unit_rate_cents: 500, percent_bp: null, amount_cents: 20000, price_source: "standard", taxable: false, delivered_quantity: null },
      { line_id: "l1", line_no: 1, kind: "material", calc_method: "per_unit", description: "Gravel #53", unit_code: "ton", quantity: "40.000", unit_rate_cents: 1250, percent_bp: null, amount_cents: 50000, price_source: "customer", taxable: true, delivered_quantity: "41.500" },
    ],
    tickets: [
      { ticket_number: "T-2026-00012", order_line_id: "l1", quantity: 20, unit_code: "ton", external_reference: "SC-2" },
      { ticket_number: "T-2026-00011", order_line_id: "l1", quantity: 21.5, unit_code: "ton", external_reference: "" },
    ],
  };
}

function parse(csv: string): string[][] {
  // Minimal RFC 4180 reader for the test.
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\r" && csv[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += c;
  }
  return rows;
}

describe("billing handoff file", () => {
  it("has one row per order line in order, with the order's own prices and only verified fields", () => {
    const rows = parse(handoffCsv({ batch_number: "B-2026-0003", reference: "QB, October" }, [snapshot("O-2026-0009"), snapshot("O-2026-0002")]));
    expect(rows[0]).toEqual([...HANDOFF_CSV_COLUMNS]);
    expect(rows).toHaveLength(5);
    const col = (r: string[], name: (typeof HANDOFF_CSV_COLUMNS)[number]) => r[HANDOFF_CSV_COLUMNS.indexOf(name)];
    expect(rows.slice(1).map((r) => `${col(r, "order_number")}/${col(r, "line_no")}`)).toEqual(["O-2026-0002/1", "O-2026-0002/2", "O-2026-0009/1", "O-2026-0009/2"]);
    const gravel = rows[1];
    expect(col(gravel, "format")).toBe("tlt-billing-handoff-v1");
    expect(col(gravel, "batch_reference")).toBe("QB, October");
    expect(col(gravel, "customer_name")).toBe('Prairie View "PV" Landscaping, LLC');
    expect(col(gravel, "ordered_quantity")).toBe("40");
    expect(col(gravel, "delivered_quantity_accepted")).toBe("41.5");
    expect(col(gravel, "unit_rate")).toBe("12.50");
    expect(col(gravel, "line_amount")).toBe("500.00"); // the accepted amount, not recalculated from delivered
    expect(col(gravel, "order_total")).toBe("749.00");
    expect(col(gravel, "ticket_numbers")).toBe("T-2026-00011 T-2026-00012");
    expect(col(gravel, "paper_ticket_numbers")).toBe("SC-2");
    const hauling = rows[2];
    expect(col(hauling, "description")).toBe("Hauling\nper ton");
    expect(col(hauling, "delivered_quantity_accepted")).toBe(""); // no ticket: blank, never zero
    expect(col(hauling, "taxable")).toBe("no");
  });

  it("neutralizes spreadsheet formulas but keeps negative numbers", () => {
    const csv = handoffCsv({ batch_number: "B-1", reference: "" }, [snapshot("O-1", { discount_cents: -500 })]);
    const row = parse(csv)[1];
    expect(row[HANDOFF_CSV_COLUMNS.indexOf("project")]).toBe("'=HYPERLINK(\"x\")");
    expect(row[HANDOFF_CSV_COLUMNS.indexOf("order_discounts")]).toBe("-5.00");
  });

  it("is identical for the same batch every time", () => {
    const a = handoffCsv({ batch_number: "B-1", reference: "" }, [snapshot("O-1"), snapshot("O-2")]);
    const b = handoffCsv({ batch_number: "B-1", reference: "" }, [snapshot("O-2"), snapshot("O-1")]);
    expect(a).toBe(b);
  });
});

describe("explanations", () => {
  it("every readiness state explains why and what to do", () => {
    for (const r of READINESS) {
      const e = readinessExplanation(r, { status: "in_progress", loads_missing: 1, loads_not_due: 2, tickets_live: 1, tickets_pending: 1, exceptions_count: 2 });
      expect(e.why, r).toBeTruthy();
      expect(e.action, r).toBeTruthy();
    }
    expect(readinessExplanation("missing_documentation", { status: "completed", loads_missing: 0, loads_not_due: 0, tickets_live: 0, tickets_pending: 0, exceptions_count: 0 }).why).toMatch(/no delivery tickets/);
  });

  it("every exception kind has a label and help text", () => {
    for (const k of EXCEPTION_KINDS) {
      expect(EXCEPTION_LABELS[k]).toBeTruthy();
      expect(EXCEPTION_HELP[k]).toBeTruthy();
    }
  });

  it("formats signed differences without inventing values", () => {
    expect(formatDifference("-0.530")).toBe("-0.53");
    expect(formatDifference("1.000")).toBe("+1");
    expect(formatDifference(0)).toBe("0");
    expect(formatDifference("0.000")).toBe("0");
    expect(formatDifference(null)).toBe("—");
  });
});
