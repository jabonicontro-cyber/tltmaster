// Quote pricing help (master plan B114). Pure arithmetic over the company's own decided quotes and measured costs:
// for one priced line (item + unit) it shows what the company's won and lost quotes charged, prefers quotes at a similar
// distance when there are enough of them, and suggests a rate with the reasoning. A suggestion only: the person sets the
// price, nothing is changed, and it is never shown to customers.

import { bandFor, median, type DecidedQuote } from "@/lib/quotes/outcomes";

/** Won quotes needed (on the chosen basis) before a rate is suggested. */
export const MIN_WON = 2;
/** Decided quotes needed in the same distance band before the band is used instead of all distances. */
export const MIN_BAND = 3;

export type Verdict = "no_history" | "in_line" | "high" | "low" | "below_cost";

export interface PricingInput {
  name: string;
  unit: string;
  /** The line's current rate, or null when not priced yet. */
  rateCents: number | null;
  /** Straight-line miles yard → job site for this quote, or null when unknown. */
  miles: number | null;
}

export interface PricingHelp {
  name: string;
  unit: string;
  rateCents: number | null;
  /** "distance" when only quotes in the same distance band were used. */
  basis: "distance" | "all" | null;
  bandLabel: string | null;
  won: number;
  lost: number;
  medianWonCents: number | null;
  medianLostCents: number | null;
  /** Lowest and highest won rate on the basis used. */
  wonLowCents: number | null;
  wonHighCents: number | null;
  suggestedCents: number | null;
  /** Average measured cost per delivered load (only for per-load lines, only when the viewer may see costs). */
  costPerLoadCents: number | null;
  verdict: Verdict;
  reason: string;
}

const keyOf = (name: string, unit: string) => `${name.trim().toLowerCase()}|${unit.trim().toLowerCase()}`;

/** Each decided quote's rate for this item and unit (first matching line), with its outcome and distance. */
function samples(history: DecidedQuote[], name: string, unit: string) {
  const key = keyOf(name, unit);
  const out: Array<{ rate: number; won: boolean; miles: number | null }> = [];
  for (const q of history) {
    const line = q.materials.find((m) => keyOf(m.name, m.unit) === key);
    if (line) out.push({ rate: line.rateCents, won: q.outcome === "won", miles: q.miles });
  }
  return out;
}

const isLoadUnit = (unit: string) => /^(load|loads|ld)$/i.test(unit.trim());

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export function pricingHelp(input: PricingInput, history: DecidedQuote[], costPerLoadCents: number | null = null): PricingHelp {
  const all = samples(history, input.name, input.unit);
  const band = input.miles !== null ? bandFor(input.miles) : null;
  const inBand = band ? all.filter((s) => s.miles !== null && bandFor(s.miles).key === band.key) : [];
  const useBand = band !== null && inBand.length >= MIN_BAND && inBand.filter((s) => s.won).length >= MIN_WON;
  const used = useBand ? inBand : all;
  const wonRates = used.filter((s) => s.won).map((s) => s.rate);
  const lostRates = used.filter((s) => !s.won).map((s) => s.rate);
  const medianWon = wonRates.length >= MIN_WON ? median(wonRates) : null;
  const medianLost = lostRates.length >= MIN_WON ? median(lostRates) : null;
  const cost = isLoadUnit(input.unit) ? costPerLoadCents : null;

  // Suggested: the typical winning rate, never below measured cost per load.
  let suggested = medianWon;
  if (suggested !== null && cost !== null && suggested < cost) suggested = cost;

  const base = {
    name: input.name,
    unit: input.unit,
    rateCents: input.rateCents,
    basis: used.length ? (useBand ? ("distance" as const) : ("all" as const)) : null,
    bandLabel: useBand && band ? band.label : null,
    won: wonRates.length,
    lost: lostRates.length,
    medianWonCents: medianWon,
    medianLostCents: medianLost,
    wonLowCents: wonRates.length ? Math.min(...wonRates) : null,
    wonHighCents: wonRates.length ? Math.max(...wonRates) : null,
    suggestedCents: suggested,
    costPerLoadCents: cost,
  };
  const scope = useBand && band ? `quotes ${band.label.toLowerCase()} from your yard` : "your decided quotes";
  const per = `/${input.unit}`;

  if (input.rateCents !== null && cost !== null && input.rateCents < cost) {
    return { ...base, verdict: "below_cost", reason: `Below your average cost of ${money(cost)} per delivered load (last 90 days).` };
  }
  if (medianWon === null) {
    return { ...base, verdict: "no_history", reason: wonRates.length ? `Only ${wonRates.length} won quote for this item and unit — not enough to suggest a rate.` : "No won quotes for this item and unit yet." };
  }
  if (input.rateCents === null) {
    return { ...base, verdict: "in_line", reason: `Typical winning rate in ${scope}: ${money(medianWon)}${per}.` };
  }
  if (medianLost !== null && input.rateCents >= medianLost) {
    return { ...base, verdict: "high", reason: `At or above the typical rate on quotes you lost (${money(medianLost)}${per}) in ${scope}.` };
  }
  if (input.rateCents < Math.min(...wonRates)) {
    return { ...base, verdict: "low", reason: `Below every rate you have won at (lowest ${money(Math.min(...wonRates))}${per}) — you may be leaving money on the table.` };
  }
  return { ...base, verdict: "in_line", reason: `In line with the rates you win at in ${scope} (typical ${money(medianWon)}${per}).` };
}
