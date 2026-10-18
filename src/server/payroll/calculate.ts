import "server-only";
import { evaluateFormula, selectRule, validateFormula, type PayInputs, type PayRuleVersion, type TicketFacts } from "@/lib/payroll/formula";
import { createClient } from "@/server/supabase/server";

/**
 * Driver earnings for one payroll period, calculated on the server from verified delivery tickets with the company's
 * own active pay rules (src/lib/payroll/formula.ts). Nothing is guessed: a ticket without an applicable rule, with two
 * equally specific rules, or with a missing input becomes an exception for review. The database checks the result
 * again when it is recorded (payroll_record_entries) and never pays a ticket twice.
 */

export interface PayableTicket extends TicketFacts {
  ticket_id: string;
  ticket_number: string;
  revision: number;
  quantity: number | string;
  order_line_id: string | null;
}

export type TicketResult =
  | { ticket: PayableTicket; status: "calculated"; rule: PayRuleVersion; inputs: PayInputs; cents: number; breakdown: string }
  | { ticket: PayableTicket; status: "exception"; rule: PayRuleVersion | null; inputs: PayInputs; exception: string };

const decimal = (v: number | string) => {
  const s = String(v);
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
};

/** The inputs a formula may read for a ticket. billed_amount only when the formula names it (pay never follows billing by default). */
export function ticketInputs(t: PayableTicket, rule: PayRuleVersion, billedCents: number | null): PayInputs {
  const qty = decimal(t.quantity);
  const uses = validateFormula(rule.formula);
  return {
    quantity: qty,
    tons: t.unit_code === "ton" ? qty : null,
    loads: "1",
    rate: rule.rate,
    hours: null, // not recorded on delivery tickets
    // A delivery ticket has one driver: the whole ticket is theirs. Shared deliveries need a confirmed allocation rule.
    driver_share: "1",
    billed_amount: uses.usesBilling && billedCents !== null ? (billedCents / 100).toFixed(2) : null,
  };
}

export function calculateTicket(t: PayableTicket, rules: readonly PayRuleVersion[], billedCents: number | null): TicketResult {
  const sel = selectRule(rules, t);
  if (!sel.ok) {
    const exception = sel.reason === "no_rule" ? "No active pay rule applies to this ticket (date, unit or scope)." : `Two pay rules apply equally (${sel.rules.map((r) => r.name).join(", ")}). Make one more specific or end one.`;
    return { ticket: t, status: "exception", rule: null, inputs: {}, exception };
  }
  const inputs = ticketInputs(t, sel.rule, billedCents);
  const ev = evaluateFormula(sel.rule.formula, inputs);
  if (!ev.ok) {
    const exception = ev.reason === "missing_input" ? `Missing input: ${ev.missing.join(", ")}.` : ev.error;
    return { ticket: t, status: "exception", rule: sel.rule, inputs, exception };
  }
  return { ticket: t, status: "calculated", rule: sel.rule, inputs, cents: Number(ev.cents), breakdown: ev.breakdown };
}

export async function loadActiveRules(): Promise<PayRuleVersion[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pay_rule_versions")
    .select("id, rule_id, status, effective_from, effective_to, formula, rate, unit_code, scope, pay_rules(name)")
    .eq("status", "active");
  if (error) throw new Error("Pay rules could not be read.");
  return ((data ?? []) as unknown as Array<Omit<PayRuleVersion, "name" | "rate"> & { rate: number | string | null; pay_rules: { name: string } | null }>).map((r) => ({
    ...r,
    rate: r.rate === null ? null : String(r.rate),
    name: r.pay_rules?.name ?? "Rule",
  }));
}

/** Preview (nothing saved) or record the period's payable tickets. */
export async function calculatePeriod(periodId: string, persist: boolean): Promise<{ results: TicketResult[]; recorded?: { added: number; already_recorded: number } }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("payroll_period_work", { p_period: periodId });
  if (error) throw new Error(error.message);
  const payable = ((data as { payable: PayableTicket[] }).payable ?? []);
  const rules = await loadActiveRules();
  // Billing amounts only for formulas that name billed_amount.
  const lineIds = rules.some((r) => validateFormula(r.formula).usesBilling) ? [...new Set(payable.map((t) => t.order_line_id).filter((x): x is string => Boolean(x)))] : [];
  const rates = new Map<string, number>();
  if (lineIds.length) {
    const lines = await supabase.from("order_lines").select("id, unit_rate_cents").in("id", lineIds);
    for (const l of (lines.data ?? []) as Array<{ id: string; unit_rate_cents: number | null }>) if (l.unit_rate_cents !== null) rates.set(l.id, Number(l.unit_rate_cents));
  }
  const results = payable.map((t) => {
    const rate = t.order_line_id ? rates.get(t.order_line_id) : undefined;
    return calculateTicket(t, rules, rate === undefined ? null : Math.round(rate * Number(t.quantity)));
  });
  if (!persist || !results.length) return { results };
  const entries = results.map((r) => ({
    ticket_id: r.ticket.ticket_id,
    driver_id: r.ticket.driver_id,
    status: r.status,
    rule_version_id: r.status === "calculated" ? r.rule.id : null,
    amount_cents: r.status === "calculated" ? r.cents : null,
    inputs: { ...r.inputs, rule_version: r.rule?.id ?? null, ticket_revision: r.ticket.revision },
    breakdown: r.status === "calculated" ? r.breakdown : "",
    exception: r.status === "exception" ? r.exception : "",
  }));
  const rec = await supabase.rpc("payroll_record_entries", { p_period: periodId, p_entries: entries });
  if (rec.error) throw new Error(rec.error.message);
  return { results, recorded: rec.data as { added: number; already_recorded: number } };
}
