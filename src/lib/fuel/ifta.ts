// IFTA quarterly summary (B130). Pure arithmetic over a quarter's trip sheets and fuel purchases: miles and gallons per
// state or province, the fleet's measured miles per gallon, taxable gallons (miles ÷ MPG) and net taxable gallons
// (taxable − bought there). Tax rates are not included: they change every quarter and the company applies the official
// ones. Missing fuel means no MPG — nothing is guessed.

export interface Leg { jurisdiction: string; miles: number }
export interface Purchase { jurisdiction: string; gallons: number }

export interface IftaRow {
  jurisdiction: string;
  miles: number;
  gallonsBought: number;
  /** Miles ÷ fleet MPG; null without MPG. */
  taxableGallons: number | null;
  /** Taxable − bought: positive means gallons owed there, negative a credit. */
  netGallons: number | null;
}

export interface IftaSummary {
  rows: IftaRow[];
  miles: number;
  gallons: number;
  mpg: number | null;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function iftaSummary(legs: Leg[], purchases: Purchase[]): IftaSummary {
  const miles = new Map<string, number>();
  const gallons = new Map<string, number>();
  for (const l of legs) miles.set(l.jurisdiction, (miles.get(l.jurisdiction) ?? 0) + l.miles);
  for (const p of purchases) gallons.set(p.jurisdiction, (gallons.get(p.jurisdiction) ?? 0) + p.gallons);
  const totalMiles = [...miles.values()].reduce((a, b) => a + b, 0);
  const totalGallons = round3([...gallons.values()].reduce((a, b) => a + b, 0));
  const mpg = totalGallons > 0 && totalMiles > 0 ? Math.round((totalMiles / totalGallons) * 100) / 100 : null;
  const rows = [...new Set([...miles.keys(), ...gallons.keys()])].sort().map((j) => {
    const m = miles.get(j) ?? 0;
    const bought = round3(gallons.get(j) ?? 0);
    const taxable = mpg ? round3(m / mpg) : null;
    return { jurisdiction: j, miles: m, gallonsBought: bought, taxableGallons: taxable, netGallons: taxable === null ? null : round3(taxable - bought) };
  });
  return { rows, miles: totalMiles, gallons: totalGallons, mpg };
}

/** First and last day of a calendar quarter (1–4). */
export function quarterRange(year: number, quarter: number): { from: string; to: string } {
  const q = Math.min(4, Math.max(1, Math.trunc(quarter)));
  const startMonth = (q - 1) * 3;
  const from = new Date(Date.UTC(year, startMonth, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(year, startMonth + 3, 0)).toISOString().slice(0, 10);
  return { from, to };
}

/** The quarter a date falls in. */
export function quarterOf(day: string): { year: number; quarter: number } {
  return { year: Number(day.slice(0, 4)), quarter: Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1 };
}

/** CSV for the accountant: one row per jurisdiction plus totals. */
export function iftaCsv(s: IftaSummary, label: string): string {
  const lines = [`IFTA summary,${label}`, "Jurisdiction,Miles,Gallons bought,Taxable gallons,Net taxable gallons"];
  for (const r of s.rows) lines.push([r.jurisdiction, r.miles, r.gallonsBought, r.taxableGallons ?? "", r.netGallons ?? ""].join(","));
  lines.push(["Total", s.miles, s.gallons, "", ""].join(","));
  lines.push(`Fleet MPG,${s.mpg ?? "not available (no fuel recorded)"}`);
  lines.push("Tax rates not included: apply this quarter's official IFTA rates.");
  return lines.join("\n") + "\n";
}

/** US states, DC and Canadian provinces that take part in IFTA, for pickers. */
export const JURISDICTIONS = ["AL", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "AB", "BC", "MB", "NB", "NL", "NS", "ON", "PE", "QC", "SK"] as const;
