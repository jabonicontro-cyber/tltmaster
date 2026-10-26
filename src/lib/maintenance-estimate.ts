// Learned maintenance time estimates (B91, owner 2026-10-26): a job's expected time comes from the company's own
// recorded labor on comparable completed jobs. Pure functions here; the data loader is
// src/server/data/maintenance-estimates.ts. Nothing here changes a shop's own estimate.

/** Fewer completed jobs than this and no learned estimate is shown (the shop's estimate, if any, stands). */
export const MIN_JOBS = 3;

export interface CompletedJob {
  id: string;
  category: string;
  /** Truck type or trailer type of the unit; null when unknown. */
  equipment: string | null;
  title: string;
  /** Recorded labor in hours (time entries, or the labor hours recorded on the job). */
  hours: number;
  /** The shop's estimate when the job was done, if any. */
  estimated: number | null;
  lead: string | null;
  completedAt: string;
}

export interface LearnedEstimate {
  hours: number;
  low: number;
  high: number;
  /** How many completed jobs it is based on (after leaving out outliers). */
  jobs: number;
  outliers: number;
  /** How the comparable jobs were chosen, most specific first. */
  match: "same job" | "same category and equipment" | "same category";
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Words that identify a job ("Replace worn steer tires" → replace, worn, steer, tires); short words are ignored. */
export function jobWords(title: string): Set<string> {
  return new Set(title.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3));
}

/** Median of the recorded hours with outliers (outside 1.5 × the interquartile range) left out; null below MIN_JOBS. */
export function summarize(hours: number[]): Omit<LearnedEstimate, "match"> | null {
  const valid = hours.filter((h) => Number.isFinite(h) && h > 0).sort((a, b) => a - b);
  if (valid.length < MIN_JOBS) return null;
  const q1 = quantile(valid, 0.25);
  const q3 = quantile(valid, 0.75);
  const spread = q3 - q1;
  const kept = valid.length >= 4 ? valid.filter((h) => h >= q1 - 1.5 * spread && h <= q3 + 1.5 * spread) : valid;
  if (kept.length < MIN_JOBS) return null;
  return { hours: round1(quantile(kept, 0.5)), low: round1(quantile(kept, 0.25)), high: round1(quantile(kept, 0.75)), jobs: kept.length, outliers: valid.length - kept.length };
}

/**
 * The estimate for a job from comparable completed jobs: the same kind of job first (category, equipment and at least
 * one shared title word), then category and equipment, then category alone, whichever first has MIN_JOBS jobs.
 */
export function learnedEstimate(job: { id?: string; category: string; equipment: string | null; title: string }, history: CompletedJob[]): LearnedEstimate | null {
  const pool = history.filter((h) => h.id !== job.id && h.category === job.category);
  const words = jobWords(job.title);
  const sameEquipment = pool.filter((h) => job.equipment !== null && h.equipment === job.equipment);
  const sameJob = sameEquipment.filter((h) => [...jobWords(h.title)].some((w) => words.has(w)));
  const levels: Array<[LearnedEstimate["match"], CompletedJob[]]> = [["same job", sameJob], ["same category and equipment", sameEquipment], ["same category", pool]];
  for (const [match, jobs] of levels) {
    const s = summarize(jobs.map((j) => j.hours));
    if (s) return { ...s, match };
  }
  return null;
}

/** Actual against estimate: positive means the job took longer than estimated. */
export function variance(actual: number, estimated: number): number {
  return estimated > 0 ? (actual - estimated) / estimated : 0;
}

export interface Performance {
  key: string;
  jobs: number;
  actual: number;
  estimated: number;
  /** Share over (+) or under (−) the estimate across the jobs with an estimate. */
  variance: number | null;
}

/** Estimate against actual, grouped (by kind of job or by lead mechanic); only jobs with an estimate count. */
export function performanceBy(jobs: CompletedJob[], keyOf: (j: CompletedJob) => string | null): Performance[] {
  const groups = new Map<string, Performance>();
  for (const j of jobs) {
    const key = keyOf(j);
    if (!key || j.estimated === null || j.estimated <= 0) continue;
    const g = groups.get(key) ?? { key, jobs: 0, actual: 0, estimated: 0, variance: null };
    g.jobs++;
    g.actual = round1(g.actual + j.hours);
    g.estimated = round1(g.estimated + j.estimated);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, variance: g.estimated > 0 ? Math.round(variance(g.actual, g.estimated) * 100) / 100 : null })).sort((a, b) => b.jobs - a.jobs || a.key.localeCompare(b.key));
}
