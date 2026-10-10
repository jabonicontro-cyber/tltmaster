// Decimal-safe money, quantity and percentage handling.
//
// - Money is integer cents.
// - Quantities are integer thousandths ("milli-units"): 12.5 tons = 12500.
// - Percentages are basis points: 5.25% = 525.
// Parsing works on strings and never goes through floating point. Products
// use BigInt and round half away from zero, matching PostgreSQL round(numeric).

const MONEY_RE = /^-?\d{1,12}(\.\d{0,2})?$/;
const QTY_RE = /^\d{1,9}(\.\d{0,3})?$/;
const PERCENT_RE = /^\d{1,3}(\.\d{0,2})?$/;

function normalize(input: string): string {
  return input.trim().replace(/[$,\s]/g, "");
}

function scaledInteger(value: string, decimals: number): number {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, frac = ""] = unsigned.split(".");
  const digits = whole + frac.padEnd(decimals, "0");
  const result = Number(BigInt(digits));
  return negative ? -result : result;
}

/** "$1,234.5" → 123450. Returns null for invalid input or more than 2 decimals. */
export function parseMoneyToCents(input: string): number | null {
  const v = normalize(input);
  if (v === "" || !MONEY_RE.test(v)) return null;
  return scaledInteger(v, 2);
}

/** "12.5" → 12500 (thousandths). Returns null for invalid input or more than 3 decimals. */
export function parseQuantityToMilli(input: string): number | null {
  const v = normalize(input);
  if (v === "" || !QTY_RE.test(v)) return null;
  return scaledInteger(v, 3);
}

/** "5.25" → 525 basis points. Returns null for invalid input. */
export function parsePercentToBp(input: string): number | null {
  const v = normalize(input).replace(/%$/, "");
  if (v === "" || !PERCENT_RE.test(v)) return null;
  return scaledInteger(v, 2);
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 123450 → "$1,234.50"; -500 → "-$5.00" */
export function formatCents(cents: number | bigint, opts: { symbol?: boolean } = {}): string {
  const big = BigInt(cents);
  const negative = big < BigInt(0);
  const abs = negative ? -big : big;
  const dollars = abs / BigInt(100);
  const rem = abs % BigInt(100);
  const body = `${groupThousands(dollars.toString())}.${rem.toString().padStart(2, "0")}`;
  return `${negative ? "-" : ""}${opts.symbol === false ? "" : "$"}${body}`;
}

/** Cents → plain editable string: 123450 → "1234.50" */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return formatCents(cents, { symbol: false }).replace(/,/g, "");
}

/** 12500 → "12.5"; 12000 → "12" */
export function formatQuantity(milli: number): string {
  const negative = milli < 0;
  const abs = Math.abs(milli);
  const whole = Math.trunc(abs / 1000);
  const frac = (abs % 1000).toString().padStart(3, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${groupThousands(String(whole))}${frac ? "." + frac : ""}`;
}

export function milliToInput(milli: number | null | undefined): string {
  if (milli === null || milli === undefined) return "";
  return formatQuantity(milli).replace(/,/g, "");
}

/** Database numeric string ("12.500") → milli-units. */
export function numericToMilli(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  return parseQuantityToMilli(String(value));
}

/** 525 → "5.25%" */
export function formatBp(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = (bp % 100).toString().padStart(2, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""}%`;
}

export function bpToInput(bp: number | null | undefined): string {
  if (bp === null || bp === undefined) return "";
  return formatBp(bp).replace("%", "");
}

/** round(numerator / denominator), half away from zero, exact. */
export function divRoundHalfAway(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < BigInt(0) !== denominator < BigInt(0);
  const n = numerator < BigInt(0) ? -numerator : numerator;
  const d = denominator < BigInt(0) ? -denominator : denominator;
  const q = (n * BigInt(2) + d) / (d * BigInt(2));
  return negative ? -q : q;
}
