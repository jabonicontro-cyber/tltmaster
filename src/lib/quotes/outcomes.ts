// Quote win/loss learning (master plan B95). Pure arithmetic over the company's own decided quotes: how many were won
// or lost, by material, customer and straight-line distance from the yard, with the quoted rates of won and lost
// quotes side by side and the reasons recorded when a quote was declined. Nothing here sets or suggests a price.

export const MIN_DECIDED = 3;

export const DISTANCE_BANDS = [
  { key: "0-10", label: "Under 10 miles", max: 10 },
  { key: "10-25", label: "10–25 miles", max: 25 },
  { key: "25-50", label: "25–50 miles", max: 50 },
  { key: "50+", label: "50 miles or more", max: Infinity },
] as const;

export type Outcome = "won" | "lost";

export interface DecidedQuote {
  id: string;
  number: string;
  outcome: Outcome;
  /** "declined" or "expired" for lost quotes (canceled quotes are left out before this point). */
  status: string;
  customer: string;
  decidedOn: string;
  firstSentOn: string | null;
  /** Straight-line miles from the yard to the job site, or null when either has no map position. */
  miles: number | null;
  reason: string;
  totalCents: number;
  /** Material lines of the decided version. */
  materials: Array<{ name: string; unit: string; rateCents: number }>;
}

export interface Group {
  key: string;
  label: string;
  won: number;
  lost: number;
  decided: number;
  /** null below MIN_DECIDED decided quotes. */
  winRate: number | null;
}

export interface MaterialGroup extends Group {
  unit: string;
  /** Median quoted rate per unit, won and lost separately; null with fewer than two quotes on that side. */
  medianWonCents: number | null;
  medianLostCents: number | null;
}

export interface QuoteOutcomes {
  decided: number;
  won: number;
  lost: number;
  winRate: number | null;
  medianDaysToDecision: number | null;
  wonValueCents: number;
  lostValueCents: number;
  materials: MaterialGroup[];
  customers: Group[];
  distance: Group[];
  unlocated: number;
  reasons: Array<{ number: string; customer: string; reason: string; decidedOn: string; status: string }>;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

const rate = (won: number, decided: number) => (decided >= MIN_DECIDED ? won / decided : null);

function group(key: string, label: string, items: DecidedQuote[]): Group {
  const won = items.filter((q) => q.outcome === "won").length;
  return { key, label, won, lost: items.length - won, decided: items.length, winRate: rate(won, items.length) };
}

export function bandFor(miles: number): (typeof DISTANCE_BANDS)[number] {
  return DISTANCE_BANDS.find((b) => miles < b.max) ?? DISTANCE_BANDS[DISTANCE_BANDS.length - 1];
}

export function quoteOutcomes(quotes: DecidedQuote[]): QuoteOutcomes {
  const won = quotes.filter((q) => q.outcome === "won");
  const days = quotes
    .filter((q) => q.firstSentOn)
    .map((q) => Math.max(0, Math.round((Date.parse(`${q.decidedOn}T00:00:00Z`) - Date.parse(`${q.firstSentOn}T00:00:00Z`)) / 86_400_000)));

  // A material is counted once per quote; its rate is the quote's rate for that material and unit.
  const byMaterial = new Map<string, { name: string; unit: string; items: DecidedQuote[]; wonRates: number[]; lostRates: number[] }>();
  for (const q of quotes) {
    const seen = new Set<string>();
    for (const m of q.materials) {
      const key = `${m.name}|${m.unit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const g = byMaterial.get(key) ?? { name: m.name, unit: m.unit, items: [], wonRates: [], lostRates: [] };
      g.items.push(q);
      (q.outcome === "won" ? g.wonRates : g.lostRates).push(m.rateCents);
      byMaterial.set(key, g);
    }
  }
  const materials: MaterialGroup[] = [...byMaterial.entries()]
    .map(([key, g]) => ({
      ...group(key, g.name, g.items),
      unit: g.unit,
      medianWonCents: g.wonRates.length >= 2 ? median(g.wonRates) : null,
      medianLostCents: g.lostRates.length >= 2 ? median(g.lostRates) : null,
    }))
    .sort((a, b) => b.decided - a.decided || a.label.localeCompare(b.label));

  const byCustomer = new Map<string, DecidedQuote[]>();
  for (const q of quotes) byCustomer.set(q.customer, [...(byCustomer.get(q.customer) ?? []), q]);
  const customers = [...byCustomer.entries()].map(([name, items]) => group(name, name, items)).sort((a, b) => b.decided - a.decided || a.label.localeCompare(b.label));

  const located = quotes.filter((q) => q.miles !== null);
  const distance = DISTANCE_BANDS.map((b) => group(b.key, b.label, located.filter((q) => bandFor(q.miles!).key === b.key))).filter((g) => g.decided > 0);

  return {
    decided: quotes.length,
    won: won.length,
    lost: quotes.length - won.length,
    winRate: rate(won.length, quotes.length),
    medianDaysToDecision: median(days),
    wonValueCents: won.reduce((t, q) => t + q.totalCents, 0),
    lostValueCents: quotes.filter((q) => q.outcome === "lost").reduce((t, q) => t + q.totalCents, 0),
    materials,
    customers,
    distance,
    unlocated: quotes.length - located.length,
    reasons: quotes
      .filter((q) => q.outcome === "lost" && q.reason.trim())
      .sort((a, b) => b.decidedOn.localeCompare(a.decidedOn))
      .slice(0, 10)
      .map((q) => ({ number: q.number, customer: q.customer, reason: q.reason.trim(), decidedOn: q.decidedOn, status: q.status })),
  };
}
