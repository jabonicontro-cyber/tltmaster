/**
 * Shop insights (B120, owner 2026-11-02): repeat failures per truck, parts a job usually needs (learned from the parts
 * used on past jobs of the same kind) and the days a truck has no loads for service. From the company's own records;
 * suggestions only.
 */
import { addDays } from "@/lib/dates";

export interface PastJob { id: string; unitId: string; unitLabel: string; category: string; completedAt: string }
export interface PartUse { workOrderId: string; partId: string; quantity: number }
export interface PartStock { id: string; name: string; unit: string; onHand: number; reorderPoint: number | null }
export interface OpenJob { id: string; number: string; unitId: string | null; category: string; status: string }

export const CATEGORY_LABEL: Record<string, string> = {
  repair: "repair", tires: "tire", brakes: "brake", engine: "engine", inspection: "inspection", electrical: "electrical", preventive: "preventive service", body: "body",
};

export interface RepeatFailure { unitId: string; unitLabel: string; category: string; count: number; detail: string }

/** Three or more completed jobs of the same kind on one unit in the last 90 days (inspections and PM excluded). */
export function repeatFailures(jobs: PastJob[], today: string): RepeatFailure[] {
  const from = addDays(today, -89);
  const by = new Map<string, { label: string; unit: string; category: string; n: number }>();
  for (const j of jobs) {
    if (j.completedAt.slice(0, 10) < from || j.category === "inspection" || j.category === "preventive") continue;
    const k = `${j.unitId}|${j.category}`;
    const g = by.get(k) ?? { label: j.unitLabel, unit: j.unitId, category: j.category, n: 0 };
    g.n += 1;
    by.set(k, g);
  }
  return [...by.values()].filter((g) => g.n >= 3).map((g) => ({
    unitId: g.unit, unitLabel: g.label, category: g.category, count: g.n,
    detail: `${g.n} ${CATEGORY_LABEL[g.category] ?? g.category} jobs in 90 days. Worth finding the root cause.`,
  })).sort((a, b) => b.count - a.count);
}

export interface PartHint { partId: string; name: string; unit: string; usedOn: number; typical: number; onHand: number; short: boolean }

/**
 * Parts a job of this kind usually needs: parts used on at least 2 past jobs of the same kind (most-used first), with
 * the typical quantity and whether today's stock covers it.
 */
export function partsUsuallyNeeded(category: string, pastJobs: PastJob[], uses: PartUse[], stock: PartStock[]): PartHint[] {
  const jobIds = new Set(pastJobs.filter((j) => j.category === category).map((j) => j.id));
  const per = new Map<string, number[]>();
  for (const u of uses) {
    if (!jobIds.has(u.workOrderId) || u.quantity <= 0) continue;
    per.set(u.partId, [...(per.get(u.partId) ?? []), u.quantity]);
  }
  const byId = new Map(stock.map((p) => [p.id, p]));
  const out: PartHint[] = [];
  for (const [partId, qs] of per) {
    const p = byId.get(partId);
    if (!p || qs.length < 2) continue;
    const sorted = [...qs].sort((a, b) => a - b);
    const typical = sorted[Math.floor(sorted.length / 2)];
    out.push({ partId, name: p.name, unit: p.unit, usedOn: qs.length, typical, onHand: p.onHand, short: p.onHand < typical });
  }
  return out.sort((a, b) => b.usedOn - a.usedOn).slice(0, 4);
}

/** The next days (up to `days`) on which the truck has no planned loads, for scheduling service. */
export function freeDays(busyDates: string[], today: string, days = 7): string[] {
  const busy = new Set(busyDates);
  return Array.from({ length: days }, (_, i) => addDays(today, i + 1)).filter((d) => !busy.has(d));
}
