// Stop order suggestion for the route builder (B10). Pure: the first place stays first; the last stays last when the
// route has a fixed destination (or returns to the start). The order is chosen to make the total distance short,
// measured with the distances given (straight lines unless road distances are supplied), with a nearest-neighbour start
// improved by 2-opt. It is a suggestion: the dispatcher applies it or not, and road time is recalculated after.

import { straightLineMiles, type Point } from "./route";

export type DistanceFn = (a: number, b: number) => number;

export function straightLineMatrix(points: Point[]): DistanceFn {
  const n = points.length;
  const m = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : straightLineMiles(points[i], points[j]))));
  return (a, b) => m[a][b];
}

export function pathLength(order: number[], d: DistanceFn): number {
  let total = 0;
  for (let i = 0; i + 1 < order.length; i++) total += d(order[i], order[i + 1]);
  return total;
}

/**
 * A short visiting order for indexes 0..n-1. `fixedEnd` keeps the last index last. Stops within `keepTogether` groups
 * (e.g. a pickup before its delivery) are not supported yet; callers with such constraints keep their own order.
 */
export function suggestOrder(n: number, d: DistanceFn, fixedEnd: boolean): number[] {
  if (n <= 3) return Array.from({ length: n }, (_, i) => i);
  const last = fixedEnd ? n - 1 : null;
  const free = new Set(Array.from({ length: n }, (_, i) => i).filter((i) => i !== 0 && i !== last));
  const order = [0];
  while (free.size) {
    const from = order[order.length - 1];
    let best = -1;
    for (const i of free) if (best < 0 || d(from, i) < d(from, best)) best = i;
    order.push(best);
    free.delete(best);
  }
  if (last !== null) order.push(last);
  // 2-opt: reverse a middle segment while that shortens the path (endpoints stay where they are).
  const end = last !== null ? order.length - 1 : order.length;
  let improved = true;
  for (let pass = 0; improved && pass < 50; pass++) {
    improved = false;
    for (let i = 1; i < end - 1; i++) {
      for (let k = i + 1; k < end; k++) {
        const before = d(order[i - 1], order[i]) + (k + 1 < order.length ? d(order[k], order[k + 1]) : 0);
        const after = d(order[i - 1], order[k]) + (k + 1 < order.length ? d(order[i], order[k + 1]) : 0);
        if (after + 1e-9 < before) {
          order.splice(i, k - i + 1, ...order.slice(i, k + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return order;
}
