import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDate, formatDateTime } from "@/lib/dates";
import { OFFER_LABELS, STAGE_LABELS, STAGE_TONES, TERMS_LABELS, type Lifecycle, type PlanVersion } from "@/lib/platform/lifecycle";
import { usd } from "@/lib/site/pricing";
import { cancelSubscription, goLiveNow, recordOnboardingFee, setGoLiveDate, setLifecycleTerms } from "@/app/admin/lifecycle-actions";

const money = (c: number | null | undefined) => (c === null || c === undefined ? "—" : usd(c));

/**
 * A customer company's subscription lifecycle for the platform team: plan and terms, onboarding fee, go-live and
 * cancellation. Every rule is enforced by the database (20261118000300); this card explains what is allowed next.
 * No payment provider is connected, so amounts are records of what was agreed or received outside Taviron.
 */
export function SubscriptionCard({ companyId, life, plans }: { companyId: string; life: Lifecycle | null; plans: PlanVersion[] }) {
  const stage = life?.stage ?? "fee_due";
  const current = plans.filter((p) => p.current);
  const balance = life?.stage === "live" && life.terms === "annual" && life.commitment_months_left !== null ? life.commitment_months_left * (life.agreed_monthly_cents ?? 0) : 0;
  return (
    <section aria-label="Subscription" className="mt-5">
    <Card>
      <CardHeader
        title="Subscription"
        description="Plan, onboarding fee and go-live. No payment provider is connected: nothing is charged or invoiced from here."
        actions={<Badge tone={life ? STAGE_TONES[stage] : "gray"}>{life ? STAGE_LABELS[stage] : "Not set up"}</Badge>}
      />
      <CardBody className="space-y-5 text-sm">
        {life && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            <div><dt className="text-xs text-muted">Plan</dt><dd className="font-semibold">{life.plan ? `${life.plan.name} (v${life.plan.version})` : "Not chosen"}</dd></div>
            <div><dt className="text-xs text-muted">Agreed monthly</dt><dd className="font-semibold tabular">{money(life.agreed_monthly_cents)}</dd></div>
            <div><dt className="text-xs text-muted">Onboarding fee</dt><dd className="font-semibold">{money(life.onboarding_fee_cents)} · {life.onboarding_fee_status === "due" ? "due" : life.onboarding_fee_status === "paid" ? "received" : "waived"}</dd></div>
            <div><dt className="text-xs text-muted">Go-live</dt><dd className="font-semibold">{life.live_at ? `Live since ${formatDateTime(life.live_at)}` : life.go_live_on ? formatDate(life.go_live_on) : "No date yet"}</dd></div>
            <div><dt className="text-xs text-muted">Terms</dt><dd>{TERMS_LABELS[life.terms]}</dd></div>
            <div><dt className="text-xs text-muted">Offer</dt><dd>{OFFER_LABELS[life.offer]}</dd></div>
            {life.onboarding_fee_note && <div><dt className="text-xs text-muted">Fee record</dt><dd>{life.onboarding_fee_note}</dd></div>}
            {life.commitment_months_left !== null && <div><dt className="text-xs text-muted">Commitment</dt><dd>{life.commitment_months_left} monthly payment{life.commitment_months_left === 1 ? "" : "s"} left</dd></div>}
            {life.canceled_at && <div className="col-span-2"><dt className="text-xs text-muted">Canceled</dt><dd>{formatDateTime(life.canceled_at)} — {life.cancel_reason}{life.cancel_balance_cents ? ` · balance ${money(life.cancel_balance_cents)}` : ""}</dd></div>}
          </dl>
        )}

        {stage !== "canceled" && (
          <form action={setLifecycleTerms} className="grid grid-cols-1 gap-3 border-t border-line pt-4 sm:grid-cols-2">
            <input type="hidden" name="company" value={companyId} />
            <Field label="Plan" htmlFor="plan_version_id">
              <Select id="plan_version_id" name="plan_version_id" defaultValue={life?.plan?.id ?? ""} required>
                <option value="" disabled>Choose a plan</option>
                {current.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} — {p.monthly_cents === null ? "quoted" : `${p.from_price ? "from " : ""}${usd(p.monthly_cents)}/mo, onboarding ${usd(p.onboarding_cents ?? 0)}`}</option>
                ))}
                {life?.plan && !current.some((p) => p.id === life.plan!.id) && <option value={life.plan.id}>{life.plan.name} v{life.plan.version} (earlier price)</option>}
              </Select>
            </Field>
            <Field label="Terms" htmlFor="terms">
              <Select id="terms" name="terms" defaultValue={life?.terms ?? "monthly"} disabled={stage === "live"}>
                {Object.entries(TERMS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
              {stage === "live" && <input type="hidden" name="terms" value={life?.terms} />}
            </Field>
            <Field label="Offer" htmlFor="offer">
              <Select id="offer" name="offer" defaultValue={life?.offer ?? "standard"}>
                {Object.entries(OFFER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="Agreed monthly amount" htmlFor="agreed_monthly" hint="Leave empty to use the plan's price for these terms. Needed for Custom, Enterprise, and founding + annual (whether those combine is your decision).">
              <Input id="agreed_monthly" name="agreed_monthly" inputMode="decimal" placeholder="e.g. 399.20" />
            </Field>
            <Field label="Notes" htmlFor="notes" className="sm:col-span-2"><Textarea id="notes" name="notes" rows={2} maxLength={2000} defaultValue={life?.notes ?? ""} /></Field>
            <div className="sm:col-span-2"><SubmitButton variant="secondary" pendingLabel="Saving…">Save plan and terms</SubmitButton></div>
          </form>
        )}

        {life?.plan && life.onboarding_fee_status === "due" && stage !== "canceled" && (
          <form action={recordOnboardingFee} className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
            <input type="hidden" name="company" value={companyId} />
            <Field label="Onboarding fee" htmlFor="fee_status">
              <Select id="fee_status" name="status" defaultValue="paid"><option value="paid">Received</option><option value="waived">Waived</option></Select>
            </Field>
            <Field label="Payment reference or waiver reason" htmlFor="fee_note" className="min-w-0 flex-[1_1_16rem]"><Input id="fee_note" name="note" required maxLength={300} /></Field>
            <SubmitButton variant="secondary" pendingLabel="Saving…">Record</SubmitButton>
          </form>
        )}

        {stage === "fee_due" && life?.plan && <Notice title="Onboarding starts when the fee is received or waived">A go-live date can be set after that.</Notice>}

        {stage === "onboarding" && life && (
          <div className="grid grid-cols-1 gap-4 border-t border-line pt-4 lg:grid-cols-2">
            <form action={setGoLiveDate} className="space-y-2">
              <input type="hidden" name="company" value={companyId} />
              <Field label={life.go_live_on ? "Move go-live earlier" : "Go-live date"} htmlFor="go_live_on" hint={life.go_live_on ? `Currently ${formatDate(life.go_live_on)}. A go-live date can only move earlier, never later.` : "The company goes live automatically on this day (its own time zone). Afterwards the date can only move earlier."}>
                <DateInput id="go_live_on" name="go_live_on" required />
              </Field>
              <SubmitButton variant="secondary" pendingLabel="Saving…">{life.go_live_on ? "Move earlier" : "Set go-live date"}</SubmitButton>
            </form>
            <form action={goLiveNow} className="space-y-2 rounded-xl border border-line p-3">
              <input type="hidden" name="company" value={companyId} />
              <p className="font-semibold">Go live now</p>
              <p className="text-xs text-muted">Starts the subscription today. Enter your password to confirm.</p>
              <Field label="Your password" htmlFor="password"><Input id="password" name="password" type="password" autoComplete="current-password" required /></Field>
              <Checkbox name="confirm" label="This company goes live today" />
              <SubmitButton pendingLabel="Confirming…">Go live now</SubmitButton>
            </form>
          </div>
        )}

        {(stage === "live" || stage === "onboarding" || stage === "fee_due") && life && (
          <details className="border-t border-line pt-4">
            <summary className="cursor-pointer font-semibold">Cancel subscription</summary>
            <form action={cancelSubscription} className="mt-3 space-y-2">
              <input type="hidden" name="company" value={companyId} />
              <input type="hidden" name="balance_cents" value={balance} />
              {balance > 0 ? (
                <Notice tone="warning" title={`Remaining annual commitment: ${usd(balance)}`}>{life.commitment_months_left} monthly payment{life.commitment_months_left === 1 ? "" : "s"} of {money(life.agreed_monthly_cents)} not yet due. Recorded with the cancellation; nothing is charged from here.</Notice>
              ) : (
                <p className="text-xs text-muted">No remaining commitment balance.</p>
              )}
              <Field label="Reason" htmlFor="cancel_reason"><Input id="cancel_reason" name="reason" required maxLength={500} /></Field>
              <Checkbox name="confirm" label={balance > 0 ? `Cancel, with a remaining balance of ${usd(balance)}` : "Cancel this subscription"} />
              <SubmitButton variant="secondary" pendingLabel="Canceling…">Cancel subscription</SubmitButton>
            </form>
          </details>
        )}
      </CardBody>
    </Card>
    </section>
  );
}
