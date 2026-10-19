// Company CRM (20261119000100): stages, activity kinds and how they are named. The database enforces the values.

export const STAGES = ["new", "contacted", "qualified", "quoting", "negotiation", "won", "lost"] as const;
export type Stage = (typeof STAGES)[number];
export const OPEN_STAGES: Stage[] = ["new", "contacted", "qualified", "quoting", "negotiation"];

export const STAGE_LABELS: Record<Stage, string> = {
  new: "New lead",
  contacted: "Contacted",
  qualified: "Qualified",
  quoting: "Quoting",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

export const ACTIVITY_KINDS = ["call", "meeting", "email", "note", "visit"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  call: "Call",
  meeting: "Meeting",
  email: "Email (logged)",
  note: "Note",
  visit: "Site visit",
};

export const RELATIONSHIP_LABELS = { prospect: "Prospect", customer: "Customer" } as const;
export type Relationship = keyof typeof RELATIONSHIP_LABELS;

export interface Opportunity {
  id: string;
  customer_id: string;
  title: string;
  stage: Stage;
  value_cents: number | null;
  probability: number | null;
  expected_close_on: string | null;
  owner_id: string | null;
  next_action: string;
  follow_up_on: string | null;
  lost_reason: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  customers?: { name: string; customer_number: string } | null;
}

export interface CrmTask {
  id: string;
  customer_id: string;
  opportunity_id: string | null;
  title: string;
  notes: string;
  due_on: string | null;
  assigned_to: string | null;
  status: "open" | "done" | "canceled";
  completed_at: string | null;
  created_at: string;
  customers?: { name: string } | null;
}

export interface Activity {
  id: string;
  kind: ActivityKind;
  occurred_at: string;
  subject: string;
  body: string;
  created_by: string;
  contact_id: string | null;
}

export interface CustomerHistory {
  orders: number;
  open_orders: number;
  first_order_on: string | null;
  last_order_on: string | null;
  ordered_cents_365d: number;
  accepted_tickets: number;
  delivered_365d: Record<string, number>;
  quotes: { open: number; accepted: number; decided: number };
  recent_orders: Array<{ id: string; order_number: string; status: string; order_date: string; total_cents: number }>;
  quiet: boolean | null;
}

/** Dollars text ("12,500" or "12500.50") → cents, or null when empty or invalid. */
export function dollarsToCents(text: string): number | null {
  const t = text.trim().replace(/[$,\s]/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  return Number(w) * 100 + Number(f.padEnd(2, "0"));
}

/** Tags typed as "quarry, priority" → cleaned list (the database also trims, de-duplicates and limits them). */
export function parseTags(text: string): string[] {
  return [...new Set(text.split(",").map((t) => t.trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
}

/** Open pipeline value: every open opportunity's value, and the probability-weighted value where a probability is set. */
export function pipelineTotals(opps: Pick<Opportunity, "stage" | "value_cents" | "probability">[]) {
  const open = opps.filter((o) => OPEN_STAGES.includes(o.stage));
  const valued = open.filter((o) => o.value_cents !== null);
  return {
    open: open.length,
    valueCents: valued.reduce((n, o) => n + (o.value_cents ?? 0), 0),
    unvalued: open.length - valued.length,
    weightedCents: Math.round(valued.filter((o) => o.probability !== null).reduce((n, o) => n + ((o.value_cents ?? 0) * (o.probability ?? 0)) / 100, 0)),
  };
}
