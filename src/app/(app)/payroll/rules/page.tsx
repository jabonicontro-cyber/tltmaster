import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { FlashToast } from "@/components/ui/flash-toast";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, ErrorState, Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDate, formatDateTime } from "@/lib/dates";
import { PAY_VARIABLES, evaluateFormula, type PayRuleVersion } from "@/lib/payroll/formula";
import { centsText } from "@/lib/payroll/export";
import { RULE_STATUS } from "@/lib/payroll/labels";
import { requirePagePermission } from "@/server/auth";
import { loadPayrollHome, previewTickets, type RuleVersionRow } from "@/server/data/payroll";
import { getUserNames } from "@/server/data/quotes";
import { createClient } from "@/server/supabase/server";
import { ticketInputs, type PayableTicket } from "@/server/payroll/calculate";
import { activateRule, draftRule, endRule } from "../actions";

export const metadata = { title: "Pay rules" };

/**
 * Each company's own pay rules. Drafts are previewed on recent verified tickets and do nothing until an authorized
 * person activates them; an active version never changes (a change is a new version with its own dates).
 */
export default async function PayRulesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requirePagePermission("payroll.manage");
  const sp = await searchParams;
  const home = await loadPayrollHome();
  if (!home) return <ErrorState title="Payroll needs a database update" description="Apply migration 20261118000200 (owner step)." />;
  const supabase = await createClient();
  const [tickets, names, drivers, customers, units] = await Promise.all([
    previewTickets(),
    getUserNames(),
    supabase.from("drivers").select("id, name").eq("active", true).order("name"),
    supabase.from("customers").select("id, name").eq("active", true).order("name").limit(500),
    supabase.from("units_of_measure").select("code, label").eq("active", true).order("sort_order"),
  ]);
  const driverName = new Map(((drivers.data ?? []) as Array<{ id: string; name: string }>).map((d) => [d.id, d.name]));
  const customerName = new Map(((customers.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]));
  const scopeText = (s: Record<string, string>) =>
    [s.driver_id && `Driver: ${driverName.get(s.driver_id) ?? "another driver"}`, s.customer_id && `Customer: ${customerName.get(s.customer_id) ?? "another customer"}`].filter(Boolean).join(" · ") || "All drivers and customers";

  // A draft's result on recent verified tickets it would apply to (unit and scope), before anyone relies on it.
  const preview = (v: RuleVersionRow) =>
    tickets
      .map((t) => ({ ...t, customer_id: t.orders?.customer_id ?? null, delivered_on: t.delivered_at.slice(0, 10), ticket_id: t.id }) as unknown as PayableTicket)
      .filter((t) => (!v.unit_code || v.unit_code === t.unit_code) && (!v.scope.driver_id || v.scope.driver_id === t.driver_id) && (!v.scope.customer_id || v.scope.customer_id === t.customer_id))
      .slice(0, 5)
      .map((t) => ({ t, r: evaluateFormula(v.formula, ticketInputs(t, { ...v, name: "" } as PayRuleVersion, null)) }));

  return (
    <>
      <FlashToast messages={{ saved: { text: "Saved." } }} />
      <PageHeader title="Pay rules" description="How your drivers' earnings are calculated from verified delivery tickets. Write it as a formula; nothing is paid until you activate it." crumbs={[{ label: "Payroll", href: "/payroll" }, { label: "Pay rules" }]} />
      {sp.error && <div className="mb-4"><Notice tone="warning" title="Not saved">{sp.error}</Notice></div>}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_400px]">
        <div className="space-y-5">
          {home.rules.length === 0 ? (
            <EmptyState title="No pay rules yet" description="Taviron has no built-in pay rule. Write your company's agreed rule on the right — for example tons × rate per ton — then preview it on real tickets." />
          ) : (
            home.rules.map((rule) => (
              <Card key={rule.id}>
                <CardHeader title={rule.name} />
                <ul className="divide-y divide-line">
                  {rule.versions.map((v) => (
                    <li key={v.id} className="space-y-2 px-4 py-3 text-sm sm:px-5">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">Version {v.version}</span>
                        <Badge tone={RULE_STATUS[v.status].tone}>{RULE_STATUS[v.status].label}</Badge>
                        <span className="text-muted">{formatDate(v.effective_from)} – {v.effective_to ? formatDate(v.effective_to) : "no end"}</span>
                      </p>
                      <p><code className="rounded bg-surface px-1.5 py-0.5">{v.formula}</code>{v.rate !== null ? <span className="ml-2">rate {v.rate}</span> : null}{v.unit_code ? <span className="ml-2 text-muted">tickets in {v.unit_code}</span> : null}</p>
                      <p className="text-muted">{scopeText(v.scope)}</p>
                      {v.evidence_note && <p className="text-muted">Source: {v.evidence_note}</p>}
                      {v.approved_at && <p className="text-xs text-muted">Activated {formatDateTime(v.approved_at)} by {v.approved_by ? names[v.approved_by] ?? "former user" : "—"}</p>}
                      {v.status === "draft" && (
                        <div className="rounded-md border border-line bg-surface/50 p-3">
                          <p className="font-semibold">Preview on recent verified tickets</p>
                          {preview(v).length === 0 ? (
                            <p className="text-muted">No recent verified ticket matches this rule&apos;s unit and scope.</p>
                          ) : (
                            <ul className="mt-1 space-y-1">
                              {preview(v).map(({ t, r }) => (
                                <li key={t.ticket_id} className="tabular">
                                  {t.ticket_number} · {driverName.get(t.driver_id ?? "") ?? "driver"} · {String(t.quantity)} {t.unit_code}: {r.ok ? <span className="font-semibold">${centsText(Number(r.cents))}</span> : <span className="text-amber-800">{r.reason === "missing_input" ? `missing ${r.missing.join(", ")}` : r.error}</span>}
                                  {r.ok && <span className="block text-xs text-muted">{r.breakdown}</span>}
                                </li>
                              ))}
                            </ul>
                          )}
                          <form action={activateRule} className="mt-3 space-y-2 border-t border-line pt-3">
                            <input type="hidden" name="id" value={v.id} />
                            <Checkbox name="confirm" label="This matches our agreed pay terms, checked against past payroll" />
                            <Input name="note" placeholder="Approval note (optional)" maxLength={500} aria-label="Approval note" />
                            <SubmitButton size="sm" pendingLabel="Activating…">Approve and activate</SubmitButton>
                          </form>
                        </div>
                      )}
                      {v.status === "active" && (
                        <form action={endRule} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="id" value={v.id} />
                          <Field label="Last day of this version" htmlFor={`last-${v.id}`}><DateInput id={`last-${v.id}`} name="last_day" required /></Field>
                          <SubmitButton size="sm" variant="secondary" pendingLabel="Saving…">End on that day</SubmitButton>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            ))
          )}
        </div>
        <Card>
          <CardHeader title="Write a rule" description="Saved as a draft. A new version of an existing rule keeps the old one for earlier tickets." />
          <CardBody>
            <form action={draftRule} className="space-y-3">
              <Field label="Rule" htmlFor="rule_id">
                <Select id="rule_id" name="rule_id" defaultValue="">
                  <option value="">A new rule</option>
                  {home.rules.map((r) => <option key={r.id} value={r.id}>New version of {r.name}</option>)}
                </Select>
              </Field>
              <Field label="Name (for a new rule)" htmlFor="name"><Input id="name" name="name" maxLength={80} placeholder="e.g. Aggregate hauling per ton" /></Field>
              <Field label="Formula" htmlFor="formula" hint={`Inputs: ${Object.keys(PAY_VARIABLES).join(", ")}. Operators + - * / ( ), min(), max(), if(condition, value, otherwise).`}>
                <Input id="formula" name="formula" required maxLength={500} placeholder="tons * rate" className="font-mono" />
              </Field>
              <Field label="Rate" htmlFor="rate" hint="The value of rate in the formula (e.g. dollars per ton)."><Input id="rate" name="rate" inputMode="decimal" placeholder="4.25" /></Field>
              <Field label="Tickets in" htmlFor="unit_code">
                <Select id="unit_code" name="unit_code" defaultValue="">
                  <option value="">Any unit</option>
                  {((units.data ?? []) as Array<{ code: string; label: string }>).map((u) => <option key={u.code} value={u.code}>{u.label}</option>)}
                </Select>
              </Field>
              <Field label="Only for driver" htmlFor="driver_id">
                <Select id="driver_id" name="driver_id" defaultValue=""><option value="">All drivers</option>{[...driverName].map(([id, n]) => <option key={id} value={id}>{n}</option>)}</Select>
              </Field>
              <Field label="Only for customer" htmlFor="customer_id">
                <Select id="customer_id" name="customer_id" defaultValue=""><option value="">All customers</option>{[...customerName].map(([id, n]) => <option key={id} value={id}>{n}</option>)}</Select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="First day" htmlFor="effective_from"><DateInput id="effective_from" name="effective_from" required /></Field>
                <Field label="Last day" htmlFor="effective_to"><DateInput id="effective_to" name="effective_to" /></Field>
              </div>
              <Field label="Where this rule comes from" htmlFor="evidence_note" hint="e.g. the rate sheet or agreement it was taken from.">
                <Textarea id="evidence_note" name="evidence_note" rows={2} maxLength={2000} />
              </Field>
              <SubmitButton pendingLabel="Saving…">Save draft</SubmitButton>
            </form>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
