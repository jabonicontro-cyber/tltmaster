// Truck health (master plan B93, owner 2026-10-27): Good, Watch or At risk from the company's rules, with every reason
// shown. Computed from records only (work orders, preventive service, service status). Mandatory safety facts are
// always At risk whatever the rules say; the level itself never blocks dispatch (the database restrictions do).

export type HealthLevel = "good" | "watch" | "at_risk";

export const HEALTH_LABELS: Record<HealthLevel, string> = { good: "Good", watch: "Watch", at_risk: "At risk" };

export interface HealthRules {
  at_risk_repairs: number;
  watch_repairs: number;
  watch_open: number;
  service_overdue: "watch" | "at_risk" | "off";
}

export const DEFAULT_HEALTH_RULES: HealthRules = { at_risk_repairs: 2, watch_repairs: 1, watch_open: 2, service_overdue: "watch" };

export const REPAIR_WINDOW_DAYS = 90;

export interface TruckFacts {
  outOfService: boolean;
  /** Open safety-critical work orders, or a restriction awaiting clearance. */
  openSafety: number;
  /** Open work orders that are not safety-critical. */
  openOther: number;
  /** Unplanned repairs opened in the last 90 days (not preventive or inspection, not canceled). */
  repairs90: number;
  /** Preventive service schedules that are overdue. */
  serviceOverdue: number;
}

export interface Health {
  level: HealthLevel;
  reasons: string[];
}

/** Reads company rules safely: anything missing or malformed falls back to the default for that rule. */
export function parseRules(raw: unknown): HealthRules {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 99 ? v : typeof v === "string" && /^\d{1,2}$/.test(v) ? Number(v) : d);
  const so = r.service_overdue;
  return {
    at_risk_repairs: n(r.at_risk_repairs, DEFAULT_HEALTH_RULES.at_risk_repairs),
    watch_repairs: n(r.watch_repairs, DEFAULT_HEALTH_RULES.watch_repairs),
    watch_open: n(r.watch_open, DEFAULT_HEALTH_RULES.watch_open),
    service_overdue: so === "watch" || so === "at_risk" || so === "off" ? so : DEFAULT_HEALTH_RULES.service_overdue,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function truckHealth(f: TruckFacts, rules: HealthRules): Health {
  const atRisk: string[] = [];
  const watch: string[] = [];
  // Mandatory: these are At risk whatever the company's rules are.
  if (f.outOfService) atRisk.push("Out of service");
  if (f.openSafety > 0) atRisk.push(plural(f.openSafety, "open safety-critical defect", "open safety-critical defects"));

  const repairs = `${plural(f.repairs90, "unplanned repair", "unplanned repairs")} in ${REPAIR_WINDOW_DAYS} days`;
  if (rules.at_risk_repairs > 0 && f.repairs90 >= rules.at_risk_repairs) atRisk.push(repairs);
  else if (rules.watch_repairs > 0 && f.repairs90 >= rules.watch_repairs) watch.push(repairs);

  if (f.serviceOverdue > 0 && rules.service_overdue !== "off") {
    (rules.service_overdue === "at_risk" ? atRisk : watch).push(plural(f.serviceOverdue, "service overdue", "services overdue"));
  }
  if (rules.watch_open > 0 && f.openOther >= rules.watch_open) watch.push(plural(f.openOther, "open repair", "open repairs"));

  if (atRisk.length) return { level: "at_risk", reasons: [...atRisk, ...watch] };
  if (watch.length) return { level: "watch", reasons: watch };
  return { level: "good", reasons: [] };
}
