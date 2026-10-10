// Quote calculation. Mirrors public.save_quote_draft / private.line_amount_cents
// / private.recompute_quote_totals in the database, which is authoritative.
// tests/db/quote-calc-parity.test.ts asserts both produce identical results.

import { divRoundHalfAway } from "@/lib/money";

export type ChargeKind = "material" | "hauling" | "service" | "surcharge" | "discount" | "other";
export type CalcMethod = "per_unit" | "percent_of_subtotal";

export interface CalcLine {
  kind: ChargeKind;
  calcMethod: CalcMethod;
  /** thousandths of a unit; required for per_unit */
  quantityMilli: number | null;
  /** cents per unit; required for per_unit */
  rateCents: number | null;
  /** basis points; required for percent_of_subtotal */
  percentBp: number | null;
  taxable: boolean;
}

export interface QuoteTotals {
  lineAmounts: number[];
  subtotalCents: number;
  discountCents: number;
  taxableCents: number;
  taxCents: number;
  totalCents: number;
}

const ZERO = BigInt(0);

function perUnitAmount(line: CalcLine): bigint {
  if (line.quantityMilli === null || line.rateCents === null) return ZERO;
  return divRoundHalfAway(BigInt(line.quantityMilli) * BigInt(line.rateCents), BigInt(1000));
}

/** Base for percentage lines: per-unit lines that are not discounts. */
export function percentageBase(lines: CalcLine[]): bigint {
  return lines
    .filter((l) => l.calcMethod === "per_unit" && l.kind !== "discount")
    .reduce((sum, l) => sum + perUnitAmount(l), ZERO);
}

export function lineAmount(line: CalcLine, baseCents: bigint): bigint {
  const sign = line.kind === "discount" ? BigInt(-1) : BigInt(1);
  if (line.calcMethod === "per_unit") {
    return sign * perUnitAmount(line);
  }
  if (line.percentBp === null) return ZERO;
  return sign * divRoundHalfAway(baseCents * BigInt(line.percentBp), BigInt(10000));
}

export function calculateQuote(lines: CalcLine[], taxRateBp: number): QuoteTotals {
  const base = percentageBase(lines);
  const amounts = lines.map((l) => lineAmount(l, base));

  let subtotal = ZERO;
  let discount = ZERO;
  let taxable = ZERO;
  amounts.forEach((amount, i) => {
    if (lines[i].kind === "discount") discount -= amount;
    else subtotal += amount;
    if (lines[i].taxable) taxable += amount;
  });
  if (taxable < ZERO) taxable = ZERO;

  const tax = divRoundHalfAway(taxable * BigInt(taxRateBp), BigInt(10000));

  return {
    lineAmounts: amounts.map(Number),
    subtotalCents: Number(subtotal),
    discountCents: Number(discount),
    taxableCents: Number(taxable),
    taxCents: Number(tax),
    totalCents: Number(subtotal - discount + tax),
  };
}
