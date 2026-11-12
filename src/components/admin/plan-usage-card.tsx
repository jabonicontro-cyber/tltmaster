import { Badge } from "@/components/ui/badge";
import { DateInput } from "@/components/ui/date-input";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDate, formatDateTime } from "@/lib/dates";
import type { PlanVersion } from "@/lib/platform/lifecycle";
import { usd } from "@/lib/site/pricing";
import { cancelTierChange, scheduleTierChange, setRenewal } from "@/app/admin/lifecycle-actions";
import { Panel, PanelBody, PanelHeader } from "@/components/admin/ui";

// Subscription notices (SUB1, 20261120008800) for the platform team: usage against the plan, renewal, the grace period,
// a proposed plan change waiting for a person's decision, and the notices recorded for the customer.

export type SubscriptionState = {
  trucks: number;
  bases: number;
  limit_trucks: number | null;
  limit_bases: number | null;
  plan: string | null;
  renewal_off: boolean;
  renews_on: string | null;
  grace: { started_on: string; ends_on: string } | null;
  tier_change: { id: string; status: "due" | "scheduled"; reason: string; effective_on: string | null; agreed_monthly_cents: number | null; to_plan_version_id: string | null; to_plan: { name: string; version: number; monthly_cents: number | null } | null } | null;
  events: Array<{ kind: string; detail: Record<string, unknown>; notice_status: string; notice_note: string; created_at: string }>;
};

const EVENT_LABELS: Record<string, string> = {
  renewal_reminder: "Renewal reminder",
  over_limit: "Over the plan: grace started",
  grace_ending: "Grace ending soon",
  back_within_limits: "Back within the plan",
  tier_change_due: "Plan change proposed (team only)",
  tier_change_scheduled: "Plan change scheduled",
  tier_change_applied: "Plan change applied",
};
const NOTICE_LABELS: Record<string, string> = { pending: "Email waiting", sent: "Emailed", previewed: "Not emailed (email off)", failed: "Email failed", not_needed: "No email" };

export function PlanUsageCard({ companyId, state, plans, terms }: { companyId: string; state: SubscriptionState; plans: PlanVersion[]; terms: string }) {
  const over = (state.limit_trucks !== null && state.trucks > state.limit_trucks) || (state.limit_bases !== null && state.bases > state.limit_bases);
  const tc = state.tier_change;
  return (
    <section aria-label="Plan usage and notices" className="mt-5">
      <Panel>
        <PanelHeader
          title="Plan usage and notices"
          description="Checked every day. Renewal reminders 30, 7 and 1 day before; a 30-day grace when over the plan; a plan change only after you schedule it and the customer is told."
          actions={over ? <Badge tone="amber">Over the plan</Badge> : <Badge tone="green">Within the plan</Badge>}
        />
        <PanelBody className="space-y-5">
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div><dt className="text-muted">Trucks</dt><dd className="tabular font-semibold">{state.trucks}{state.limit_trucks !== null ? ` of ${state.limit_trucks}` : ""}</dd></div>
            <div><dt className="text-muted">Dispatch bases</dt><dd className="tabular font-semibold">{state.bases}{state.limit_bases !== null ? ` of ${state.limit_bases}` : ""}</dd></div>
            <div><dt className="text-muted">Grace period</dt><dd className="font-semibold">{state.grace ? `${formatDate(state.grace.started_on)} to ${formatDate(state.grace.ends_on)}` : "None"}</dd></div>
            <div><dt className="text-muted">Renews</dt><dd className="font-semibold">{terms !== "annual" ? "Monthly terms" : state.renewal_off ? "Renewal off" : state.renews_on ? formatDate(state.renews_on) : "No commitment start"}</dd></div>
          </dl>
          <p className="text-xs text-muted">Counted: active company trucks (hired trucks excluded) and active dispatch bases. Pickups and maintenance vehicles are counted until vehicles can be marked as not counting.</p>

          {terms === "annual" && (
            <form action={setRenewal} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="company" value={companyId} />
              <Checkbox name="renew" defaultChecked={!state.renewal_off} label="Renew the annual term automatically (reminders before it renews)" />
              <SubmitButton variant="secondary" size="sm">Save renewal</SubmitButton>
            </form>
          )}

          {tc && tc.status === "due" && (
            <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950">
              <p className="font-semibold">A plan change is proposed. Nothing changes until you schedule it.</p>
              <p className="text-sm">{tc.reason} {tc.to_plan ? `The lowest plan that fits: ${tc.to_plan.name} (${tc.to_plan.monthly_cents !== null ? `${usd(tc.to_plan.monthly_cents)} per month standard` : "price on request"}).` : "No standard plan fits: agree a custom plan."}</p>
              <form action={scheduleTierChange} className="grid grid-cols-1 gap-3 sm:grid-cols-4" aria-label="Schedule the plan change">
                <input type="hidden" name="company" value={companyId} />
                <input type="hidden" name="change" value={tc.id} />
                <Field label="Plan" htmlFor="tc-plan">
                  <Select id="tc-plan" name="plan_version_id" defaultValue={tc.to_plan_version_id ?? ""}>
                    {plans.filter((p) => p.current).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                </Field>
                <Field label="Takes effect (next billing date)" htmlFor="tc-date"><DateInput id="tc-date" name="effective_on" /></Field>
                <Field label="Agreed monthly price ($)" htmlFor="tc-price" hint="Including any discount the customer keeps."><Input id="tc-price" name="agreed_monthly" inputMode="decimal" /></Field>
                <div className="flex items-end"><SubmitButton>Schedule and notify</SubmitButton></div>
              </form>
              <form action={cancelTierChange} className="flex flex-wrap items-end gap-2" aria-label="Do not change the plan">
                <input type="hidden" name="company" value={companyId} />
                <input type="hidden" name="change" value={tc.id} />
                <Field label="Or don't change the plan, because" htmlFor="tc-reason"><Input id="tc-reason" name="reason" maxLength={300} className="min-w-72" /></Field>
                <SubmitButton variant="secondary" size="sm">Don&apos;t change</SubmitButton>
              </form>
            </div>
          )}
          {tc && tc.status === "scheduled" && (
            <p className="rounded-xl bg-surface px-4 py-3 text-sm">
              Plan change scheduled: {tc.to_plan?.name ?? "the new plan"} from {tc.effective_on ? formatDate(tc.effective_on) : "–"} at {tc.agreed_monthly_cents !== null ? usd(tc.agreed_monthly_cents) : "–"} per month. The customer was notified; it applies on that date.
            </p>
          )}

          <div>
            <h3 className="mb-2 text-sm font-semibold text-ink">Recent notices</h3>
            {state.events.length === 0 ? (
              <p className="text-sm text-muted">None yet.</p>
            ) : (
              <ul className="divide-y divide-line text-sm" aria-label="Subscription notices">
                {state.events.map((e, i) => (
                  <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>{EVENT_LABELS[e.kind] ?? e.kind} <span className="text-muted">· {formatDateTime(e.created_at)}</span></span>
                    <span className="text-muted" title={e.notice_note || undefined}>{NOTICE_LABELS[e.notice_status] ?? e.notice_status}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </PanelBody>
      </Panel>
    </section>
  );
}
