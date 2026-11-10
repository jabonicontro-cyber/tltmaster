// "Price to be checked" (financial review M1, owner 2026-11-10; migration 20261120016100). Pure: what the order and
// billing pages say about a price typed on a line without a price-list rate. The database decides whether a check is
// pending (orders.price_check_requested_at without price_checked_at) and refuses billing until it is confirmed.

import { formatBp, formatCents } from "@/lib/money";

export interface PriceCheckOrder {
  price_check_requested_at?: string | null;
  price_check_requested_by?: string | null;
  price_checked_at?: string | null;
  price_checked_by?: string | null;
  price_check_note?: string;
}

export interface PriceCheckLine {
  id?: string;
  line_no: number;
  description: string;
  calc_method: string;
  unit_code: string | null;
  unit_label?: string;
  unit_rate_cents: number | null;
  percent_bp: number | null;
  price_entered_by?: string | null;
}

/** A typed price waits for a person with pricing or billing rights. */
export function priceCheckPending(o: PriceCheckOrder): boolean {
  return Boolean(o.price_check_requested_at) && !o.price_checked_at;
}

/** "Line 2, Rush hauling: $95.00 per load" for each line whose price was typed. */
export function typedPriceLines(lines: PriceCheckLine[]): string[] {
  return lines
    .filter((l) => l.price_entered_by)
    .sort((a, b) => a.line_no - b.line_no)
    .map((l) => {
      const price = l.calc_method === "per_unit"
        ? `${formatCents(l.unit_rate_cents ?? 0)} per ${(l.unit_code || l.unit_label || "unit").toLowerCase()}`
        : `${formatBp(l.percent_bp ?? 0)} of the subtotal`;
      return `Line ${l.line_no}, ${l.description}: ${price}`;
    });
}

/** A typed line billing may correct while confirming (owner 2026-11-10, 20261120016400): per-unit lines only. */
export interface CorrectableLine {
  id: string;
  label: string;
  unit: string;
  rateCents: number;
}

export function correctableLines(lines: PriceCheckLine[]): CorrectableLine[] {
  return lines
    .filter((l) => l.price_entered_by && l.id && l.calc_method === "per_unit")
    .sort((a, b) => a.line_no - b.line_no)
    .map((l) => ({ id: l.id!, label: `Line ${l.line_no}, ${l.description}`, unit: (l.unit_code || l.unit_label || "unit").toLowerCase(), rateCents: l.unit_rate_cents ?? 0 }));
}

/**
 * The corrections to send: lines whose typed price was changed in the dialog (dollars as typed). Null when a price
 * cannot be read; an unchanged line is left out.
 */
export function priceCorrections(lines: CorrectableLine[], typed: Record<string, string>, parse: (s: string) => number | null): Array<{ line_id: string; unit_rate_cents: number }> | null {
  const out: Array<{ line_id: string; unit_rate_cents: number }> = [];
  for (const l of lines) {
    const raw = typed[l.id];
    if (raw === undefined) continue;
    const cents = parse(raw.trim());
    if (cents === null || cents < 0) return null;
    if (cents !== l.rateCents) out.push({ line_id: l.id, unit_rate_cents: cents });
  }
  return out;
}
