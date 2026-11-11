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
