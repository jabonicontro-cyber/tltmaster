/**
 * A load's revenue estimate from its order's own rates: material and hauling lines priced per the load's unit
 * (aggregate: per ton; freight: per load) × its planned quantity. Both are revenue for the load, so they add up;
 * surcharges and lines in other units are not estimated per load. No rate or no quantity → null (never guessed).
 */
export interface RateLine {
  order_id: string;
  kind: string;
  calc_method: string;
  unit_code: string | null;
  unit_rate_cents: number | string | null;
}

export function estimateLoadRevenueCents(lines: readonly RateLine[], load: { order_id: string; unit_code: string | null; planned_quantity: number | null }): number | null {
  const priced = lines.filter((x) => x.order_id === load.order_id && (x.kind === "material" || x.kind === "hauling") && x.calc_method === "per_unit" && x.unit_code === load.unit_code && x.unit_rate_cents !== null);
  if (!priced.length || load.planned_quantity === null) return null;
  return Math.round(priced.reduce((sum, x) => sum + Number(x.unit_rate_cents), 0) * load.planned_quantity);
}
