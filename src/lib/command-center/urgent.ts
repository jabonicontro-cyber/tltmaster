// The urgent part of the Command Center status strip: one indicator whose parts add up to the urgent total, each
// urgent item counted once under its own kind (public.command_center_urgent_by_kind, 20261119000200).

/** Urgent kinds in the order they are listed (most operationally pressing first). */
const ORDER = ["urgent_order", "unassigned_load", "assignment_problem", "order_unscheduled", "equipment_report", "delay_report"];

const NOUNS: Record<string, [string, string]> = {
  urgent_order: ["order", "orders"],
  unassigned_load: ["load today without a truck", "loads today without a truck"],
  assignment_problem: ["assignment the rules now refuse", "assignments the rules now refuse"],
  order_unscheduled: ["order wanted by tomorrow without a date", "orders wanted by tomorrow without a date"],
  equipment_report: ["driver equipment report", "driver equipment reports"],
  delay_report: ["driver delay report", "driver delay reports"],
};

export interface UrgentPart {
  kind: string;
  count: number;
  /** "2 loads today without a truck" (used after the "N urgent" lead when several kinds are urgent). */
  text: string;
}

export interface UrgentSummary {
  total: number;
  /** The single indicator when one kind is urgent ("1 urgent order"), else the lead ("3 urgent"). */
  lead: string;
  /** Kind to link the lead to when only one kind is urgent. */
  kind: string | null;
  /** The breakdown when several kinds are urgent (empty otherwise). */
  parts: UrgentPart[];
}

const noun = (kind: string, n: number) => (NOUNS[kind] ?? ["item", "items"])[n === 1 ? 0 : 1];

/** Build the urgent indicator from per-kind counts; null when nothing is urgent. Zero and negative counts are ignored. */
export function urgentSummary(byKind: Record<string, number> | null | undefined): UrgentSummary | null {
  const parts = Object.entries(byKind ?? {})
    .filter(([, n]) => Number.isInteger(n) && n > 0)
    .sort(([a], [b]) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b))
    .map(([kind, count]) => ({ kind, count, text: `${count} ${noun(kind, count)}` }));
  const total = parts.reduce((n, p) => n + p.count, 0);
  if (total === 0) return null;
  if (parts.length === 1) {
    const p = parts[0];
    const lead = p.kind === "urgent_order" ? `${p.count} urgent ${noun(p.kind, p.count)}` : `${p.count} urgent: ${p.text}`;
    return { total, lead, kind: p.kind, parts: [] };
  }
  return { total, lead: `${total} urgent`, kind: null, parts };
}
