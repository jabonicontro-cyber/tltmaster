import { industryOf } from "@/lib/industry";

// Default units for new lines (master plan MK1): what a new order or quote line, material or charge starts with when
// nothing more specific says so. Units only, never rates: a rate comes only from the company's own price catalog
// (src/components/quotes/quote-editor.tsx), otherwise it stays empty for a person to enter.
//
// Order of preference, always limited to the company's own active units:
//   1. the company's own catalog: the unit most of its active per-unit items of that kind use (materials for a
//      material line, hauling charges for a hauling line);
//   2. what the company hauls (Settings → Company → What you haul): aggregate and "both" work in tons, a general freight
//      carrier prices linehaul per mile (MK2: per-mile and flat rates are the freight units);
//   3. "each", else the first active unit.
// Accessorials, services and other charges keep "each" (a lumper fee, a truck ordered not used).

export type LineKind = "material" | "hauling" | "other";

interface Unit { code: string; active?: boolean }
interface CatalogItem { default_unit_code: string | null; active?: boolean; calc_method?: string; kind?: string }

const BY_INDUSTRY = {
  material: { aggregate: "ton", freight: "load", both: "ton" },
  hauling: { aggregate: "ton", freight: "mile", both: "ton" },
} as const;

/** The unit most of these items use, among the active units. A tie goes to the preferred unit, else the one met first. */
function mostUsed(items: readonly CatalogItem[], active: ReadonlySet<string>, preferred: string): string | null {
  const counts = new Map<string, number>();
  for (const i of items) {
    const u = i.default_unit_code;
    if (u && active.has(u)) counts.set(u, (counts.get(u) ?? 0) + 1);
  }
  const top = Math.max(0, ...counts.values());
  if (!top) return null;
  const tied = [...counts].filter(([, n]) => n === top).map(([u]) => u);
  return tied.includes(preferred) ? preferred : tied[0];
}

export function defaultLineUnit(input: {
  kind: LineKind;
  industry: unknown;
  units: readonly Unit[];
  materials?: readonly CatalogItem[];
  charges?: readonly CatalogItem[];
}): string | null {
  const activeUnits = input.units.filter((u) => u.active !== false);
  const active = new Set(activeUnits.map((u) => u.code));
  const fallback = active.has("each") ? "each" : activeUnits[0]?.code ?? null;
  if (input.kind === "other") return fallback;

  const byIndustry = BY_INDUSTRY[input.kind][industryOf(input.industry)];
  const own = input.kind === "material"
    ? mostUsed((input.materials ?? []).filter((m) => m.active !== false), active, byIndustry)
    : mostUsed((input.charges ?? []).filter((c) => c.active !== false && c.kind === "hauling" && (c.calc_method ?? "per_unit") === "per_unit"), active, byIndustry);
  if (own) return own;
  return active.has(byIndustry) ? byIndustry : fallback;
}
