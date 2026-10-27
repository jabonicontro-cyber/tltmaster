// The public paperwork calculator (master plan B88: "labelled cost/time calculator"). Pure arithmetic on the visitor's
// own numbers: tickets a week, office hours a week and, when an hourly cost is given, the cost a year. No defaults and
// no savings figure, because Taviron has no measured customer numbers to publish yet (CLAUDE.md "Honest data").

export interface PaperworkInput {
  trucks: number;
  loadsPerTruck: number;
  daysPerWeek: number;
  minutesPerTicket: number;
  hourlyCost: number;
}

const LIMITS: Record<keyof PaperworkInput, number> = { trucks: 2000, loadsPerTruck: 60, daysPerWeek: 7, minutesPerTicket: 120, hourlyCost: 1000 };

function num(v: string | number | undefined, max: number): number | null {
  if (v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}

/** null until trucks, loads, days and minutes are valid positive numbers; the cost needs an hourly cost too. */
export function paperworkCost(input: Partial<Record<keyof PaperworkInput, string | number>>): { ticketsPerWeek: number; hoursPerWeek: number; costPerYear: number | null } | null {
  const trucks = num(input.trucks, LIMITS.trucks);
  const loads = num(input.loadsPerTruck, LIMITS.loadsPerTruck);
  const days = num(input.daysPerWeek, LIMITS.daysPerWeek);
  const minutes = num(input.minutesPerTicket, LIMITS.minutesPerTicket);
  if (trucks === null || loads === null || days === null || minutes === null) return null;
  const ticketsPerWeek = trucks * loads * days;
  const hoursPerWeek = (ticketsPerWeek * minutes) / 60;
  const rate = num(input.hourlyCost, LIMITS.hourlyCost);
  return { ticketsPerWeek, hoursPerWeek, costPerYear: rate === null ? null : hoursPerWeek * rate * 52 };
}
