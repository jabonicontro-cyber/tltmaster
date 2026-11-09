import { formatCents } from "@/lib/money";

// Parts used per job (owner 2026-11-05, master plan UX20): how many parts came off the shelf for a work order (shop
// parts inventory, B105), and what its part cost lines add up to. Countable parts (each, kit, set...) add up by
// quantity (2 air filters = 2 parts); a measured part (gallons of oil, feet of hose) counts once, whatever the amount. The cost is shown only to people who
// see maintenance costs; it includes parts bought outside the stock room. Nothing is estimated: a part used without a
// known cost adds no cost.

export interface PartsSummary {
  /** Parts used from stock: countable units by quantity, a measured part once. */
  parts: number;
  /** Sum of the work order's part cost lines, in cents; null when the person can't see costs. */
  costCents: number | null;
}

export interface UsedMovement { work_order_id: string | null; part_id: string; kind: string; quantity?: number | string; unit?: string | null }

/** Units measured rather than counted: a part in one of these counts once on a job. */
const MEASURED = /^(gal|gallons?|qt|quarts?|l|liters?|litres?|ml|oz|ounces?|lb|lbs|pounds?|kg|ft|feet|foot|in|inch(es)?|m|meters?|metres?|yd|yards?)\.?$/i;
export const isMeasuredUnit = (unit: string | null | undefined) => Boolean(unit && MEASURED.test(unit.trim()));
export interface PartCostLine { work_order_id: string; kind: string; quantity: number | string; unit_cost_cents: number | string }

/** One summary per work order id asked for (zero when nothing was used). costs null = the person can't see costs. */
export function summarizeParts(ids: string[], movements: UsedMovement[], costs: PartCostLine[] | null): Map<string, PartsSummary> {
  const out = new Map<string, PartsSummary>(ids.map((id) => [id, { parts: 0, costCents: costs ? 0 : null }]));
  const measured = new Map<string, Set<string>>();
  // Parts returned to stock from the job (20261120012600) come off the count: countable parts by quantity, a measured
  // part once it is fully returned.
  const net = new Map<string, number>();
  for (const m of movements) {
    if ((m.kind !== "used" && m.kind !== "returned") || !m.work_order_id) continue;
    const k = `${m.work_order_id}:${m.part_id}`;
    net.set(k, (net.get(k) ?? 0) - Number(m.quantity ?? (m.kind === "used" ? -1 : 1)));
  }
  // Uses first, then returns (the movements may come newest first).
  for (const m of [...movements.filter((x) => x.kind === "used"), ...movements.filter((x) => x.kind === "returned")]) {
    if (m.kind === "returned") {
      if (m.work_order_id && out.has(m.work_order_id) && !isMeasuredUnit(m.unit)) {
        const s = out.get(m.work_order_id)!;
        s.parts = Math.max(0, s.parts - Math.max(1, Math.ceil(Math.abs(Number(m.quantity ?? 1)) || 1)));
      }
      continue;
    }
    if (!m.work_order_id || !out.has(m.work_order_id)) continue;
    if (isMeasuredUnit(m.unit) && (net.get(`${m.work_order_id}:${m.part_id}`) ?? 1) <= 0) continue;
    const s = out.get(m.work_order_id)!;
    if (isMeasuredUnit(m.unit)) {
      const set = measured.get(m.work_order_id) ?? new Set<string>();
      if (!set.has(m.part_id)) s.parts += 1;
      set.add(m.part_id);
      measured.set(m.work_order_id, set);
    } else {
      // Uses are stored as negative quantities; a fraction of a countable part still counts as one.
      s.parts += Math.max(1, Math.ceil(Math.abs(Number(m.quantity ?? 1)) || 1));
    }
  }
  for (const c of costs ?? []) {
    const s = out.get(c.work_order_id);
    if (!s || c.kind !== "part" || s.costCents === null) continue;
    s.costCents += Math.round(Number(c.quantity) * Number(c.unit_cost_cents));
  }
  return out;
}

/** "2 parts used · $245.10 in parts"; null when there is nothing to say. */
export function partsSummaryText(s: PartsSummary | undefined): string | null {
  if (!s) return null;
  const bits: string[] = [];
  if (s.parts > 0) bits.push(`${s.parts} ${s.parts === 1 ? "part" : "parts"} used`);
  if (s.costCents) bits.push(`${formatCents(s.costCents)} in parts`);
  return bits.length ? bits.join(" · ") : null;
}
