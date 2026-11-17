/**
 * One unit of measure in the singular, for "per" labels: "$/load", "$/ton", "$/cubic yard" (walkthrough 2026-11-11:
 * "Rate ($/loads)" read wrong). Unit labels are stored in the plural ("Loads", "Cubic yards"; units_of_measure.label).
 * A plural that is not a plain trailing "s" ("Boxes", "Batteries") uses the unit's short form instead, so a word is
 * never mangled.
 */
export function unitSingular(label: string | null | undefined, abbreviation?: string | null): string {
  const l = (label ?? "").trim().toLowerCase();
  const short = (abbreviation ?? "").trim().toLowerCase();
  if (!l) return short || "unit";
  if (/ies$/.test(l) || /(ch|sh|x|z|ss)es$/.test(l)) return short || l;
  if (/[^s]s$/.test(l)) return l.slice(0, -1);
  return l;
}

/**
 * Known units by code, label or short form: [singular, plural]. A company's own unit (units_of_measure.label, stored
 * in the plural) is handled by the rules below instead.
 */
const KNOWN_UNITS: Record<string, readonly [string, string]> = {
  ton: ["ton", "tons"], tons: ["ton", "tons"],
  load: ["load", "loads"], loads: ["load", "loads"],
  cu_yd: ["cubic yard", "cubic yards"], "cu yd": ["cubic yard", "cubic yards"], "cubic yard": ["cubic yard", "cubic yards"], "cubic yards": ["cubic yard", "cubic yards"],
  hour: ["hour", "hours"], hours: ["hour", "hours"], hr: ["hour", "hours"],
  mile: ["mile", "miles"], miles: ["mile", "miles"], mi: ["mile", "miles"],
  day: ["day", "days"], days: ["day", "days"],
  each: ["each", "each"], ea: ["each", "each"],
};

/**
 * The word for a unit next to a quantity, lowercase and matched to the number (walkthrough 2026-11-14: "1 Loads",
 * "24 load", "60 Miles"): unitWord("Loads", 1) = "load", unitWord("load", 24) = "loads", unitWord("cu_yd", 2) =
 * "cubic yards". Accepts a unit code, its label or its short form. A short all-capital unit ("CY", "BBL") keeps its
 * capitals and is never pluralised. "" when there is no unit.
 */
export function unitWord(unit: string | null | undefined, quantity: number | string | null | undefined): string {
  const raw = (unit ?? "").replace(/_/g, " ").trim().replace(/\s+/g, " ");
  if (!raw) return "";
  const one = Number(quantity) === 1;
  const known = KNOWN_UNITS[raw.toLowerCase()] ?? KNOWN_UNITS[(unit ?? "").trim().toLowerCase()];
  if (known) return one ? known[0] : known[1];
  if (raw.length <= 4 && raw === raw.toUpperCase() && /[A-Z]/.test(raw)) return raw;
  const lower = raw.toLowerCase();
  const singular = /(ch|sh|x|z|ss)es$/.test(lower) ? lower.slice(0, -2) : /[^aeiou]ies$/.test(lower) ? `${lower.slice(0, -3)}y` : unitSingular(lower);
  if (one) return singular;
  // Labels are stored in the plural; a singular one gets a plain plural.
  if (singular !== lower) return lower;
  if (/(s|x|z|ch|sh)$/.test(lower)) return lower.endsWith("s") ? lower : `${lower}es`;
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
}

const QTY = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });

/**
 * A quantity with its unit, one way everywhere: "1 load", "24 loads", "60 miles", "14.1 tons", "1,250 cubic yards".
 * The number keeps up to three decimals (tickets record three). "" for a missing or unreadable quantity; the number
 * alone when there is no unit.
 */
export function formatUnitQuantity(quantity: number | string | null | undefined, unit?: string | null): string {
  if (quantity === null || quantity === undefined || quantity === "") return "";
  const n = Number(quantity);
  if (!Number.isFinite(n)) return "";
  const word = unitWord(unit, n);
  const num = QTY.format(n);
  return word ? `${num} ${word}` : num;
}
